import { type TrueForgeApi, TrueForgeError } from "@truefoundry/trueforge-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  mapTrueForgeRequiredAction,
  mapTrueForgeTurnState,
  TrueForgeAgentRuntime,
} from "../../src/adapters/trueforge/trueforge-agent-runtime.js";
import {
  AgentSessionSubmissionUnknownError,
  AgentTurnSubmissionUnknownError,
} from "../../src/ports/agent-runtime.js";

function createFakeClient() {
  const sessions = {
    create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
    createTurn: vi.fn().mockResolvedValue({ data: { id: "turn-1" } }),
    getTurn: vi.fn().mockResolvedValue({
      data: {
        id: "turn-1",
        state: { status: "running" },
      },
    }),
    cancel: vi.fn().mockResolvedValue({ data: undefined }),
  };

  return {
    sessions,
    client: { sessions } as never,
  };
}

describe("mapTrueForgeTurnState", () => {
  it("maps a running turn", () => {
    const state: TrueForgeApi.TurnState = { status: "running" };

    expect(mapTrueForgeTurnState(state)).toEqual({ state: "RUNNING" });
  });

  it("maps an ordinary completed turn without losing its output", () => {
    const output: TrueForgeApi.ModelMessageEvent = {
      type: "model.message",
      id: "message-1",
      threadId: "main",
      createdAt: "2026-08-29T12:00:00.000Z",
      content: "Research complete",
    };
    const state: TrueForgeApi.TurnState = {
      status: "done",
      completedAt: "2026-08-29T12:00:01.000Z",
      output,
      requiredActions: [],
    };

    expect(mapTrueForgeTurnState(state)).toEqual({ state: "COMPLETED", output });
  });

  it("treats a done turn with pending approval as waiting", () => {
    const state: TrueForgeApi.TurnState = {
      status: "done",
      completedAt: "2026-08-29T12:00:01.000Z",
      output: null,
      requiredActions: [
        {
          type: "tool.approval_required",
          id: "approval-event-1",
          threadId: "main",
          createdAt: "2026-08-29T12:00:00.000Z",
          toolCalls: [{ id: "call-1", sourceEventId: "model-message-1" }],
        },
      ],
    };

    expect(mapTrueForgeTurnState(state)).toEqual({
      state: "WAITING_FOR_ACTION",
      actions: [
        {
          id: "approval-event-1:call-1",
          kind: "APPROVAL",
          threadId: "main",
          toolCallId: "call-1",
          sourceEventId: "model-message-1",
        },
      ],
    });
  });

  it("maps provider errors as explicit non-retryable failures", () => {
    const state: TrueForgeApi.TurnState = {
      status: "error",
      completedAt: "2026-08-29T12:00:01.000Z",
      message: "model provider rejected the request",
    };

    expect(mapTrueForgeTurnState(state)).toEqual({
      state: "FAILED",
      code: "TRUEFORGE_TURN_ERROR",
      message: "model provider rejected the request",
      retryable: false,
    });
  });

  it("maps cancellation without inventing a successful result", () => {
    const state: TrueForgeApi.TurnState = {
      status: "cancelled",
      completedAt: "2026-08-29T12:00:01.000Z",
      reason: "client-cancelled",
    };

    expect(mapTrueForgeTurnState(state)).toEqual({ state: "CANCELLED" });
  });
});

describe("mapTrueForgeRequiredAction", () => {
  it("maps requested tool responses to explicit questions", () => {
    const action: TrueForgeApi.ToolResponseRequiredEvent = {
      type: "tool.response_required",
      id: "response-event-1",
      threadId: "subagent-1",
      createdAt: "2026-08-29T12:00:00.000Z",
      toolCalls: [{ id: "call-7", sourceEventId: "model-message-7" }],
    };

    expect(mapTrueForgeRequiredAction(action)).toEqual([
      {
        id: "response-event-1:call-7",
        kind: "QUESTION",
        threadId: "subagent-1",
        toolCallId: "call-7",
        sourceEventId: "model-message-7",
      },
    ]);
  });

  it("preserves MCP authorization URLs without pretending they can be resolved as turns", () => {
    const action: TrueForgeApi.McpAuthRequiredEvent = {
      type: "mcp.auth_required",
      id: "mcp-event-1",
      threadId: null,
      createdAt: "2026-08-29T12:00:00.000Z",
      mcpServers: [
        {
          id: "bright-data",
          name: "Bright Data",
          authUrl: "https://example.test/oauth",
        },
      ],
    };

    expect(mapTrueForgeRequiredAction(action)).toEqual([
      {
        id: "mcp-event-1:bright-data",
        kind: "MCP_OAUTH",
        serverId: "bright-data",
        serverName: "Bright Data",
        authorizationUrl: "https://example.test/oauth",
      },
    ]);
  });
});

describe("TrueForgeAgentRuntime", () => {
  it("creates a non-retrying session as a separate durability boundary", async () => {
    const { client, sessions } = createFakeClient();
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });
    const signal = new AbortController().signal;

    await expect(
      runtime.createSession({ agent: { kind: "SAVED", agentName: "bizforge-research" } }, signal),
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(sessions.create).toHaveBeenCalledWith(
      { agent: { name: "bizforge-research" } },
      { abortSignal: signal, maxRetries: 0 },
    );
    expect(sessions.createTurn).not.toHaveBeenCalled();
  });

  it("surfaces an ambiguous session submission as typed and non-retryable", async () => {
    const { client, sessions } = createFakeClient();
    const networkError = new Error("connection closed before a response arrived");
    sessions.create.mockRejectedValueOnce(networkError);
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });

    const caught: unknown = await runtime
      .createSession(
        { agent: { kind: "SAVED", agentName: "bizforge-research" } },
        new AbortController().signal,
      )
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AgentSessionSubmissionUnknownError);
    expect(caught).toMatchObject({
      code: "AGENT_SESSION_SUBMISSION_UNKNOWN",
      retryable: false,
      agentName: "bizforge-research",
      cause: networkError,
    });
  });

  it("starts a non-retrying background turn in a persisted session", async () => {
    const { client, sessions } = createFakeClient();
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });
    const signal = new AbortController().signal;

    await expect(
      runtime.startTurn(
        {
          sessionId: "session-1",
          previousTurnId: null,
          prompt: "Build a bounded research plan",
        },
        signal,
      ),
    ).resolves.toEqual({ sessionId: "session-1", turnId: "turn-1" });

    expect(sessions.createTurn).toHaveBeenCalledWith(
      "session-1",
      {
        input: [{ type: "user.message", content: "Build a bounded research plan" }],
        previousTurnId: "none",
      },
      { abortSignal: signal, maxRetries: 0 },
    );
  });

  it("starts a follow-up turn without creating a replacement session", async () => {
    const { client, sessions } = createFakeClient();
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });

    await runtime.startTurn(
      {
        sessionId: "existing-session",
        previousTurnId: "turn-parent",
        prompt: "Continue",
      },
      new AbortController().signal,
    );

    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.createTurn).toHaveBeenCalledWith(
      "existing-session",
      {
        input: [{ type: "user.message", content: "Continue" }],
        previousTurnId: "turn-parent",
      },
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it("polls the exact persisted turn reference", async () => {
    const { client, sessions } = createFakeClient();
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });
    const signal = new AbortController().signal;

    await expect(
      runtime.inspectTurn({ sessionId: "session-7", turnId: "turn-9" }, signal),
    ).resolves.toEqual({ state: "RUNNING" });
    expect(sessions.getTurn).toHaveBeenCalledWith("session-7", "turn-9", {
      abortSignal: signal,
    });
  });

  it("resumes approvals and questions in one action-only turn", async () => {
    const { client, sessions } = createFakeClient();
    sessions.createTurn.mockResolvedValueOnce({ data: { id: "turn-resumed" } });
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });
    const signal = new AbortController().signal;

    await expect(
      runtime.resolveActions(
        { sessionId: "session-1", turnId: "turn-paused" },
        [
          {
            kind: "APPROVAL",
            action: {
              id: "event-1:call-1",
              kind: "APPROVAL",
              threadId: "main",
              toolCallId: "call-1",
              sourceEventId: "message-1",
            },
            decision: "REJECT",
            reason: "Outside the approved budget",
          },
          {
            kind: "QUESTION",
            action: {
              id: "event-2:call-2",
              kind: "QUESTION",
              threadId: "subagent-1",
              toolCallId: "call-2",
              sourceEventId: "message-2",
            },
            response: "Use the United Kingdom only",
          },
        ],
        signal,
      ),
    ).resolves.toEqual({ sessionId: "session-1", turnId: "turn-resumed" });

    expect(sessions.createTurn).toHaveBeenCalledWith(
      "session-1",
      {
        input: [
          {
            type: "user.tool_approval",
            threadId: "main",
            toolCallId: "call-1",
            approval: { status: "deny", reason: "Outside the approved budget" },
          },
          {
            type: "user.tool_response",
            threadId: "subagent-1",
            toolCallId: "call-2",
            content: "Use the United Kingdom only",
          },
        ],
        previousTurnId: "turn-paused",
      },
      { abortSignal: signal, maxRetries: 0 },
    );
  });

  it("refuses an empty resume and exposes cancellation as session-scoped", async () => {
    const { client, sessions } = createFakeClient();
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });
    const turn = { sessionId: "session-1", turnId: "turn-1" };
    const signal = new AbortController().signal;

    await expect(runtime.resolveActions(turn, [], signal)).rejects.toThrow(
      "At least one agent action resolution is required",
    );
    await runtime.cancelSession({ sessionId: turn.sessionId }, signal);

    expect(sessions.cancel).toHaveBeenCalledWith("session-1", {}, { abortSignal: signal });
  });

  it("maps approval decisions without inventing rejection reasons", async () => {
    const { client, sessions } = createFakeClient();
    sessions.createTurn.mockResolvedValueOnce({ data: { id: "turn-resumed" } });
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });

    await runtime.resolveActions(
      { sessionId: "session-1", turnId: "turn-paused" },
      [
        {
          kind: "APPROVAL",
          action: {
            id: "event-1:call-1",
            kind: "APPROVAL",
            threadId: "main",
            toolCallId: "call-1",
            sourceEventId: "message-1",
          },
          decision: "APPROVE",
        },
        {
          kind: "APPROVAL",
          action: {
            id: "event-2:call-2",
            kind: "APPROVAL",
            threadId: "main",
            toolCallId: "call-2",
            sourceEventId: "message-2",
          },
          decision: "REJECT",
        },
      ],
      new AbortController().signal,
    );

    expect(sessions.createTurn).toHaveBeenCalledWith(
      "session-1",
      {
        input: [
          {
            type: "user.tool_approval",
            threadId: "main",
            toolCallId: "call-1",
            approval: { status: "allow" },
          },
          {
            type: "user.tool_approval",
            threadId: "main",
            toolCallId: "call-2",
            approval: { status: "deny" },
          },
        ],
        previousTurnId: "turn-paused",
      },
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it("surfaces an ambiguous turn submission as typed and non-retryable", async () => {
    const { client, sessions } = createFakeClient();
    const networkError = new Error("connection closed before a response arrived");
    sessions.createTurn.mockRejectedValueOnce(networkError);
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });

    const caught: unknown = await runtime
      .startTurn(
        {
          sessionId: "session-ambiguous",
          previousTurnId: null,
          prompt: "Start research",
        },
        new AbortController().signal,
      )
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AgentTurnSubmissionUnknownError);
    expect(caught).toMatchObject({
      code: "AGENT_TURN_SUBMISSION_UNKNOWN",
      retryable: false,
      sessionId: "session-ambiguous",
      previousTurnId: null,
      cause: networkError,
    });
  });

  it("preserves a definitive client rejection", async () => {
    const { client, sessions } = createFakeClient();
    const rejection = new TrueForgeError({ message: "Invalid turn", statusCode: 400 });
    sessions.createTurn.mockRejectedValueOnce(rejection);
    const runtime = new TrueForgeAgentRuntime({
      baseUrl: "http://localhost:8790",
      client,
    });

    await expect(
      runtime.startTurn(
        {
          sessionId: "session-invalid",
          previousTurnId: null,
          prompt: "Invalid research request",
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(rejection);
  });
});
