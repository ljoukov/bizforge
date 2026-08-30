import { IsoDateTimeSchema } from "../domain/common.js";

export const RESEARCH_RUN_STATES = [
  "PLANNING",
  "WAITING_APPROVAL",
  "COLLECTING",
  "NORMALIZING",
  "ANALYZING",
  "SYNTHESIZING",
  "VALIDATING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;

export type ResearchRunState = (typeof RESEARCH_RUN_STATES)[number];

export type ActiveResearchRunState = Exclude<ResearchRunState, TerminalResearchRunState>;

export type TerminalResearchRunState = "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";

export interface ResearchRunFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface ResearchRunBase {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ActiveResearchRun extends ResearchRunBase {
  readonly state: ActiveResearchRunState;
  readonly outcome: null;
}

export interface CompletedResearchRun extends ResearchRunBase {
  readonly state: "COMPLETED";
  readonly outcome: Readonly<{ kind: "COMPLETED" }>;
}

export interface PartialResearchRun extends ResearchRunBase {
  readonly state: "PARTIAL";
  readonly outcome: Readonly<{
    kind: "PARTIAL";
    reason: string;
  }>;
}

export interface FailedResearchRun extends ResearchRunBase {
  readonly state: "FAILED";
  readonly outcome: Readonly<{
    kind: "FAILED";
    fromState: ActiveResearchRunState;
    failure: ResearchRunFailure;
  }>;
}

export interface CancelledResearchRun extends ResearchRunBase {
  readonly state: "CANCELLED";
  readonly outcome: Readonly<{
    kind: "CANCELLED";
    fromState: ActiveResearchRunState;
    reason: string;
  }>;
}

export type TerminalResearchRun =
  | CompletedResearchRun
  | PartialResearchRun
  | FailedResearchRun
  | CancelledResearchRun;

export type ResearchRun = ActiveResearchRun | TerminalResearchRun;

export type ResearchRunEvent =
  | Readonly<{ type: "PLAN_COMPLETED"; occurredAt: string }>
  | Readonly<{ type: "APPROVAL_GRANTED"; occurredAt: string }>
  | Readonly<{ type: "COLLECTION_COMPLETED"; occurredAt: string }>
  | Readonly<{ type: "NORMALIZATION_COMPLETED"; occurredAt: string }>
  | Readonly<{ type: "ANALYSIS_COMPLETED"; occurredAt: string }>
  | Readonly<{ type: "SYNTHESIS_COMPLETED"; occurredAt: string }>
  | Readonly<{
      type: "VALIDATION_COMPLETED";
      occurredAt: string;
      result: Readonly<{ status: "COMPLETED" }> | Readonly<{ status: "PARTIAL"; reason: string }>;
    }>
  | Readonly<{
      type: "RUN_FAILED";
      occurredAt: string;
      failure: ResearchRunFailure;
    }>
  | Readonly<{
      type: "RUN_CANCELLED";
      occurredAt: string;
      reason: string;
    }>;

export interface CreateResearchRunInput {
  readonly id: string;
  readonly createdAt: string;
}

export class ResearchRunVersionConflictError extends Error {
  override readonly name = "ResearchRunVersionConflictError";

  constructor(
    readonly runId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Research run ${runId} is at version ${actualVersion}; expected version ${expectedVersion}`,
    );
  }
}

export class IllegalResearchRunTransitionError extends Error {
  override readonly name = "IllegalResearchRunTransitionError";

  constructor(
    readonly runId: string,
    readonly state: ActiveResearchRunState,
    readonly eventType: ResearchRunEvent["type"],
  ) {
    super(`Cannot apply ${eventType} to research run ${runId} while it is ${state}`);
  }
}

export class TerminalResearchRunError extends Error {
  override readonly name = "TerminalResearchRunError";

  constructor(
    readonly runId: string,
    readonly state: TerminalResearchRunState,
    readonly eventType: ResearchRunEvent["type"],
  ) {
    super(`Cannot apply ${eventType} to research run ${runId}; ${state} is terminal`);
  }
}

export class ResearchRunTimestampOrderError extends RangeError {
  override readonly name = "ResearchRunTimestampOrderError";

  constructor(
    readonly runId: string,
    readonly occurredAt: string,
    readonly currentUpdatedAt: string,
  ) {
    super(
      `Research run ${runId} event at ${occurredAt} precedes current updatedAt ${currentUpdatedAt}`,
    );
  }
}

export function createResearchRun({ id, createdAt }: CreateResearchRunInput): ActiveResearchRun {
  if (id.trim().length === 0) {
    throw new TypeError("Research run id must not be empty");
  }
  requireIsoTimestamp(createdAt, "Research run createdAt");

  return Object.freeze({
    id,
    state: "PLANNING",
    version: 0,
    createdAt,
    updatedAt: createdAt,
    outcome: null,
  });
}

export function isTerminalResearchRunState(
  state: ResearchRunState,
): state is TerminalResearchRunState {
  switch (state) {
    case "PLANNING":
    case "WAITING_APPROVAL":
    case "COLLECTING":
    case "NORMALIZING":
    case "ANALYZING":
    case "SYNTHESIZING":
    case "VALIDATING":
      return false;
    case "COMPLETED":
    case "PARTIAL":
    case "FAILED":
    case "CANCELLED":
      return true;
    default:
      return assertNever(state);
  }
}

export function isTerminalResearchRun(run: ResearchRun): run is TerminalResearchRun {
  return isTerminalResearchRunState(run.state);
}

/**
 * Applies one event without mutating the supplied run.
 *
 * `expectedVersion` is deliberately checked before transition legality. That
 * makes a stale writer distinguishable from a writer that loaded the latest
 * state but attempted an invalid transition. Persist the returned run with the
 * same compare-and-swap expectation in {@link ResearchRunRepository}.
 */
export function transitionResearchRun(
  run: ResearchRun,
  event: ResearchRunEvent,
  expectedVersion: number,
): ResearchRun {
  if (run.version !== expectedVersion) {
    throw new ResearchRunVersionConflictError(run.id, expectedVersion, run.version);
  }
  if (isTerminalResearchRun(run)) {
    throw new TerminalResearchRunError(run.id, run.state, event.type);
  }

  switch (event.type) {
    case "PLAN_COMPLETED":
      return advance(run, event.type, "PLANNING", "WAITING_APPROVAL", event.occurredAt);
    case "APPROVAL_GRANTED":
      return advance(run, event.type, "WAITING_APPROVAL", "COLLECTING", event.occurredAt);
    case "COLLECTION_COMPLETED":
      return advance(run, event.type, "COLLECTING", "NORMALIZING", event.occurredAt);
    case "NORMALIZATION_COMPLETED":
      return advance(run, event.type, "NORMALIZING", "ANALYZING", event.occurredAt);
    case "ANALYSIS_COMPLETED":
      return advance(run, event.type, "ANALYZING", "SYNTHESIZING", event.occurredAt);
    case "SYNTHESIS_COMPLETED":
      return advance(run, event.type, "SYNTHESIZING", "VALIDATING", event.occurredAt);
    case "VALIDATION_COMPLETED": {
      requireState(run, event.type, "VALIDATING");
      requireMonotonicTimestamp(run, event.occurredAt);

      if (event.result.status === "COMPLETED") {
        return complete(run, event.occurredAt);
      }

      return finishPartially(run, event.result.reason, event.occurredAt);
    }
    case "RUN_FAILED":
      requireMonotonicTimestamp(run, event.occurredAt);
      return fail(run, event.failure, event.occurredAt);
    case "RUN_CANCELLED":
      requireMonotonicTimestamp(run, event.occurredAt);
      return cancel(run, event.reason, event.occurredAt);
    default:
      return assertNever(event);
  }
}

function advance(
  run: ActiveResearchRun,
  eventType: ResearchRunEvent["type"],
  requiredState: ActiveResearchRunState,
  nextState: ActiveResearchRunState,
  occurredAt: string,
): ActiveResearchRun {
  requireState(run, eventType, requiredState);
  requireMonotonicTimestamp(run, occurredAt);

  return Object.freeze({
    ...run,
    state: nextState,
    version: run.version + 1,
    updatedAt: occurredAt,
    outcome: null,
  });
}

function complete(run: ActiveResearchRun, occurredAt: string): CompletedResearchRun {
  return Object.freeze({
    ...run,
    state: "COMPLETED",
    version: run.version + 1,
    updatedAt: occurredAt,
    outcome: Object.freeze({ kind: "COMPLETED" }),
  });
}

function finishPartially(
  run: ActiveResearchRun,
  reason: string,
  occurredAt: string,
): PartialResearchRun {
  return Object.freeze({
    ...run,
    state: "PARTIAL",
    version: run.version + 1,
    updatedAt: occurredAt,
    outcome: Object.freeze({ kind: "PARTIAL", reason }),
  });
}

function fail(
  run: ActiveResearchRun,
  failure: ResearchRunFailure,
  occurredAt: string,
): FailedResearchRun {
  return Object.freeze({
    ...run,
    state: "FAILED",
    version: run.version + 1,
    updatedAt: occurredAt,
    outcome: Object.freeze({
      kind: "FAILED",
      fromState: run.state,
      failure: Object.freeze({ ...failure }),
    }),
  });
}

function cancel(run: ActiveResearchRun, reason: string, occurredAt: string): CancelledResearchRun {
  return Object.freeze({
    ...run,
    state: "CANCELLED",
    version: run.version + 1,
    updatedAt: occurredAt,
    outcome: Object.freeze({
      kind: "CANCELLED",
      fromState: run.state,
      reason,
    }),
  });
}

function requireState(
  run: ActiveResearchRun,
  eventType: ResearchRunEvent["type"],
  requiredState: ActiveResearchRunState,
): void {
  if (run.state !== requiredState) {
    throw new IllegalResearchRunTransitionError(run.id, run.state, eventType);
  }
}

function requireIsoTimestamp(value: string, label: string): number {
  const parsed = IsoDateTimeSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${label} must be an ISO 8601 date-time with a timezone`);
  }
  return Date.parse(parsed.data);
}

function requireMonotonicTimestamp(run: ActiveResearchRun, occurredAt: string): void {
  const eventTime = requireIsoTimestamp(occurredAt, "Research run event occurredAt");
  const updatedTime = requireIsoTimestamp(run.updatedAt, "Research run updatedAt");
  if (eventTime < updatedTime) {
    throw new ResearchRunTimestampOrderError(run.id, occurredAt, run.updatedAt);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled research-run value: ${String(value)}`);
}
