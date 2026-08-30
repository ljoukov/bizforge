export type AgentReference = Readonly<{ kind: "SAVED"; agentName: string }>;

export interface CreateAgentSessionRequest {
  /**
   * Application-owned ID persisted before the non-idempotent provider call.
   * TrueForge cannot store or query it; it exists for audit and operator
   * recovery only, never for automatic provider-side correlation.
   */
  readonly attemptId: string;
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
 * Session creation is non-idempotent and TrueForge accepts no idempotency key
 * or client correlation value. A transport failure can therefore hide a
 * session that the provider already created. The outcome is terminal for the
 * current run: do not retry or guess from agent names and timestamps. Record
 * the attempt for manual investigation and require an operator-authorized new
 * attempt if the run should continue.
 */
export class AgentSessionCreationIndeterminateError extends Error {
  override readonly name = "AgentSessionCreationIndeterminateError";
  readonly code = "AGENT_SESSION_CREATION_INDETERMINATE";
  readonly retryable = false;
  readonly recovery = "MANUAL_ONLY";
  readonly orphanPossible = true;

  constructor(
    readonly attemptId: string,
    readonly agentName: string,
    options?: ErrorOptions,
  ) {
    super(
      `Agent session creation outcome is indeterminate for attempt ${attemptId} (${agentName}); automatic retry or name/time-based recovery is unsafe`,
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
   * `request.attemptId` before calling and the returned reference before
   * attempting the first turn. An indeterminate creation outcome must fail the
   * run non-retryably and be handled through manual operator policy.
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
