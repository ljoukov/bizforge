import { TrueForge, type TrueForgeApi, TrueForgeError } from "@truefoundry/trueforge-sdk";

import {
  AgentSessionCreationIndeterminateError,
  AgentTurnSubmissionUnknownError,
  type AgentActionResolution,
  type AgentRequiredAction,
  type AgentRuntime,
  type AgentSessionReference,
  type AgentTurnReference,
  type AgentTurnStatus,
  type CreateAgentSessionRequest,
  type StartAgentTurnRequest,
} from "../../ports/agent-runtime.js";

type TrueForgeClient = Pick<TrueForge, "sessions">;

export interface TrueForgeAgentRuntimeOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly client?: TrueForgeClient;
}

/**
 * Headless TrueForge adapter for one saved agent per batch session.
 *
 * Creating sessions and turns deliberately disables SDK retries. Those POSTs
 * have no documented idempotency key. An ambiguous turn can be inspected in
 * its known session; an ambiguous session creation cannot be correlated
 * exactly and must fail closed for manual handling.
 */
export class TrueForgeAgentRuntime implements AgentRuntime {
  readonly #client: TrueForgeClient;

  constructor(options: TrueForgeAgentRuntimeOptions) {
    this.#client =
      options.client ??
      new TrueForge({
        baseUrl: options.baseUrl,
        ...(options.token === undefined ? {} : { token: options.token }),
      });
  }

  async createSession(
    request: CreateAgentSessionRequest,
    signal: AbortSignal,
  ): Promise<AgentSessionReference> {
    try {
      const { data: session } = await this.#client.sessions.create(
        { agent: { name: request.agent.agentName } },
        { abortSignal: signal, maxRetries: 0 },
      );

      return { sessionId: session.id };
    } catch (error) {
      if (isDefinitiveClientRejection(error)) {
        throw error;
      }
      throw new AgentSessionCreationIndeterminateError(request.attemptId, request.agent.agentName, {
        cause: error,
      });
    }
  }

  async startTurn(
    request: StartAgentTurnRequest,
    signal: AbortSignal,
  ): Promise<AgentTurnReference> {
    const turn = await this.#submitTurn(
      request.sessionId,
      request.previousTurnId,
      [{ type: "user.message", content: request.prompt }],
      signal,
    );

    return { sessionId: request.sessionId, turnId: turn.id };
  }

  async inspectTurn(turn: AgentTurnReference, signal: AbortSignal): Promise<AgentTurnStatus> {
    const { data } = await this.#client.sessions.getTurn(turn.sessionId, turn.turnId, {
      abortSignal: signal,
    });
    return mapTrueForgeTurnState(data.state);
  }

  async resolveActions(
    turn: AgentTurnReference,
    resolutions: readonly AgentActionResolution[],
    signal: AbortSignal,
  ): Promise<AgentTurnReference> {
    if (resolutions.length === 0) {
      throw new TypeError("At least one agent action resolution is required");
    }

    const input: TrueForgeApi.TurnInputItem[] = resolutions.map((resolution) => {
      if (resolution.kind === "QUESTION") {
        return {
          type: "user.tool_response",
          threadId: resolution.action.threadId,
          toolCallId: resolution.action.toolCallId,
          content: resolution.response,
        };
      }

      return {
        type: "user.tool_approval",
        threadId: resolution.action.threadId,
        toolCallId: resolution.action.toolCallId,
        approval:
          resolution.decision === "APPROVE"
            ? { status: "allow" }
            : {
                status: "deny",
                ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
              },
      };
    });

    const resumedTurn = await this.#submitTurn(turn.sessionId, turn.turnId, input, signal);

    return { sessionId: turn.sessionId, turnId: resumedTurn.id };
  }

  async cancelSession(session: AgentSessionReference, signal: AbortSignal): Promise<void> {
    await this.#client.sessions.cancel(session.sessionId, {}, { abortSignal: signal });
  }

  async #submitTurn(
    sessionId: string,
    previousTurnId: string | null,
    input: TrueForgeApi.TurnInputItem[],
    signal: AbortSignal,
  ): Promise<TrueForgeApi.Turn> {
    try {
      const { data } = await this.#client.sessions.createTurn(
        sessionId,
        { input, previousTurnId: previousTurnId ?? "none" },
        { abortSignal: signal, maxRetries: 0 },
      );
      return data;
    } catch (error) {
      if (isDefinitiveClientRejection(error)) {
        throw error;
      }
      throw new AgentTurnSubmissionUnknownError(sessionId, previousTurnId, { cause: error });
    }
  }
}

function isDefinitiveClientRejection(error: unknown): boolean {
  if (!(error instanceof TrueForgeError) || error.statusCode === undefined) {
    return false;
  }

  return (
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408 &&
    error.statusCode !== 425 &&
    error.statusCode !== 429
  );
}

export function mapTrueForgeTurnState(state: TrueForgeApi.TurnState): AgentTurnStatus {
  switch (state.status) {
    case "running":
      return { state: "RUNNING" };
    case "done": {
      const actions = state.requiredActions.flatMap(mapTrueForgeRequiredAction);
      return actions.length > 0
        ? { state: "WAITING_FOR_ACTION", actions }
        : { state: "COMPLETED", output: state.output };
    }
    case "cancelled":
      return { state: "CANCELLED" };
    case "error":
      return {
        state: "FAILED",
        code: "TRUEFORGE_TURN_ERROR",
        message: state.message,
        retryable: false,
      };
    default:
      return assertNever(state);
  }
}

export function mapTrueForgeRequiredAction(
  action: TrueForgeApi.ActionRequiredEvent,
): AgentRequiredAction[] {
  switch (action.type) {
    case "tool.approval_required":
      return action.toolCalls.map((toolCall) => ({
        id: `${action.id}:${toolCall.id}`,
        kind: "APPROVAL",
        threadId: action.threadId,
        toolCallId: toolCall.id,
        sourceEventId: toolCall.sourceEventId,
      }));
    case "tool.response_required":
      return action.toolCalls.map((toolCall) => ({
        id: `${action.id}:${toolCall.id}`,
        kind: "QUESTION",
        threadId: action.threadId,
        toolCallId: toolCall.id,
        sourceEventId: toolCall.sourceEventId,
      }));
    case "mcp.auth_required":
      return action.mcpServers.map((server) => ({
        id: `${action.id}:${server.id}`,
        kind: "MCP_OAUTH",
        serverId: server.id,
        serverName: server.name,
        authorizationUrl: server.authUrl,
      }));
    default:
      return assertNever(action);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled TrueForge value: ${String(value)}`);
}
