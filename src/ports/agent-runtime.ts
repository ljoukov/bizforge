export type AgentReference = Readonly<{ kind: "SAVED"; agentName: string }>;

export interface CreateAgentSessionRequest {
  readonly agent: AgentReference;
}

export interface AgentSessionReference {
  readonly sessionId: string;
}

export interface StartAgentTurnRequest {
  readonly sessionId: string;
  /** `null` starts a new root; otherwise the exact parent turn is required. */
  readonly previousTurnId: string | null;
  readonly prompt: string;
}

export interface AgentTurnReference {
  readonly sessionId: string;
  readonly turnId: string;
}

/**
 * Session creation is non-idempotent. A transport failure can hide a session
 * that the provider already created, so callers must reconcile by agent/run
 * metadata rather than blindly creating another session.
 */
export class AgentSessionSubmissionUnknownError extends Error {
  override readonly name = "AgentSessionSubmissionUnknownError";
  readonly code = "AGENT_SESSION_SUBMISSION_UNKNOWN";
  readonly retryable = false;

  constructor(
    readonly agentName: string,
    options?: ErrorOptions,
  ) {
    super(
      `Agent session submission outcome is unknown for ${agentName}; reconcile before resubmitting`,
      options,
    );
  }
}

/**
 * A turn-creation request may have reached the server even though no response
 * reached the caller. Retrying this error is unsafe until the session is
 * reconciled against provider state.
 */
export class AgentTurnSubmissionUnknownError extends Error {
  override readonly name = "AgentTurnSubmissionUnknownError";
  readonly code = "AGENT_TURN_SUBMISSION_UNKNOWN";
  readonly retryable = false;

  constructor(
    readonly sessionId: string,
    readonly previousTurnId: string | null,
    options?: ErrorOptions,
  ) {
    super(
      `Agent turn submission outcome is unknown for session ${sessionId}; reconcile before resubmitting`,
      options,
    );
  }
}

interface AgentToolAction {
  readonly id: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly sourceEventId: string;
}

export interface AgentApprovalAction extends AgentToolAction {
  readonly kind: "APPROVAL";
}

export interface AgentQuestionAction extends AgentToolAction {
  readonly kind: "QUESTION";
}

export interface AgentMcpOauthAction {
  readonly id: string;
  readonly kind: "MCP_OAUTH";
  readonly serverId: string;
  readonly serverName: string;
  readonly authorizationUrl: string;
}

export type AgentRequiredAction = AgentApprovalAction | AgentQuestionAction | AgentMcpOauthAction;

export type AgentTurnStatus =
  | Readonly<{ state: "RUNNING" }>
  | Readonly<{
      state: "WAITING_FOR_ACTION";
      actions: readonly AgentRequiredAction[];
    }>
  | Readonly<{ state: "COMPLETED"; output: unknown }>
  | Readonly<{
      state: "FAILED";
      code: string;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{ state: "CANCELLED" }>;

export type AgentActionResolution =
  | Readonly<{
      kind: "APPROVAL";
      action: AgentApprovalAction;
      decision: "APPROVE" | "REJECT";
      reason?: string;
    }>
  | Readonly<{
      kind: "QUESTION";
      action: AgentQuestionAction;
      response: string;
    }>;

/** Headless agent-harness boundary; implementations may poll or use streams. */
export interface AgentRuntime {
  /**
   * Creates a session as a separate durability boundary. Callers must persist
   * the returned reference before attempting the first turn.
   */
  createSession(
    request: CreateAgentSessionRequest,
    signal: AbortSignal,
  ): Promise<AgentSessionReference>;

  startTurn(request: StartAgentTurnRequest, signal: AbortSignal): Promise<AgentTurnReference>;

  inspectTurn(turn: AgentTurnReference, signal: AbortSignal): Promise<AgentTurnStatus>;

  resolveActions(
    turn: AgentTurnReference,
    resolutions: readonly AgentActionResolution[],
    signal: AbortSignal,
  ): Promise<AgentTurnReference>;

  /**
   * Cancels the currently running tip for a session. TrueForge cancellation is
   * session-scoped, so this API intentionally does not accept a stale turn ID.
   * Each batch run must own its TrueForge session.
   */
  cancelSession(session: AgentSessionReference, signal: AbortSignal): Promise<void>;
}
