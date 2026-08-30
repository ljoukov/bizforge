import { describe, expect, it } from "vitest";

import {
  type ActiveResearchRun,
  type ActiveResearchRunState,
  createResearchRun,
  IllegalResearchRunTransitionError,
  isTerminalResearchRun,
  isTerminalResearchRunState,
  RESEARCH_RUN_STATES,
  type ResearchRun,
  type ResearchRunEvent,
  ResearchRunTimestampOrderError,
  ResearchRunVersionConflictError,
  TerminalResearchRunError,
  transitionResearchRun,
} from "../../src/application/research-run-machine.js";

const STARTED_AT = "2026-08-29T20:00:00.000Z";

const progression = [
  {
    from: "PLANNING",
    event: { type: "PLAN_COMPLETED" },
    to: "WAITING_APPROVAL",
  },
  {
    from: "WAITING_APPROVAL",
    event: { type: "APPROVAL_GRANTED" },
    to: "COLLECTING",
  },
  {
    from: "COLLECTING",
    event: { type: "COLLECTION_COMPLETED" },
    to: "NORMALIZING",
  },
  {
    from: "NORMALIZING",
    event: { type: "NORMALIZATION_COMPLETED" },
    to: "ANALYZING",
  },
  {
    from: "ANALYZING",
    event: { type: "ANALYSIS_COMPLETED" },
    to: "SYNTHESIZING",
  },
  {
    from: "SYNTHESIZING",
    event: { type: "SYNTHESIS_COMPLETED" },
    to: "VALIDATING",
  },
] as const satisfies readonly {
  from: ActiveResearchRunState;
  event: Pick<ResearchRunEvent, "type">;
  to: ActiveResearchRunState;
}[];

function eventAt(event: Pick<ResearchRunEvent, "type">, index: number): ResearchRunEvent {
  const occurredAt = `2026-08-29T20:0${index + 1}:00.000Z`;

  switch (event.type) {
    case "PLAN_COMPLETED":
    case "APPROVAL_GRANTED":
    case "COLLECTION_COMPLETED":
    case "NORMALIZATION_COMPLETED":
    case "ANALYSIS_COMPLETED":
    case "SYNTHESIS_COMPLETED":
      return { type: event.type, occurredAt };
    case "VALIDATION_COMPLETED":
      return {
        type: "VALIDATION_COMPLETED",
        occurredAt,
        result: { status: "COMPLETED" },
      };
    case "RUN_FAILED":
      return {
        type: "RUN_FAILED",
        occurredAt,
        failure: {
          code: "fixture_failure",
          message: "Fixture failure",
          retryable: false,
        },
      };
    case "RUN_CANCELLED":
      return { type: "RUN_CANCELLED", occurredAt, reason: "Fixture cancel" };
  }
}

function runInState(target: ActiveResearchRunState): ActiveResearchRun {
  let run: ResearchRun = createResearchRun({
    id: `run-${target.toLowerCase()}`,
    createdAt: STARTED_AT,
  });

  if (target === "PLANNING") {
    return run;
  }

  for (const [index, step] of progression.entries()) {
    run = transitionResearchRun(run, eventAt(step.event, index), run.version);

    if (run.state === target) {
      return run;
    }
  }

  throw new Error(`Test helper cannot create state ${target}`);
}

function validatedRun(): ActiveResearchRun {
  return runInState("VALIDATING");
}

describe("research run state machine", () => {
  it("declares the complete, stable state vocabulary", () => {
    expect(RESEARCH_RUN_STATES).toEqual([
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
    ]);
  });

  it("creates an immutable version-zero run in PLANNING", () => {
    const run = createResearchRun({ id: "run-1", createdAt: STARTED_AT });

    expect(run).toEqual({
      id: "run-1",
      state: "PLANNING",
      version: 0,
      createdAt: STARTED_AT,
      updatedAt: STARTED_AT,
      outcome: null,
    });
    expect(Object.isFrozen(run)).toBe(true);
    expect(() => createResearchRun({ id: "  ", createdAt: STARTED_AT })).toThrow(
      "Research run id must not be empty",
    );
    expect(() => createResearchRun({ id: "run-invalid-time", createdAt: "yesterday" })).toThrow(
      "Research run createdAt must be an ISO 8601 date-time with a timezone",
    );
  });

  it("requires valid, monotonic event timestamps", () => {
    const run = runInState("WAITING_APPROVAL");

    expect(() =>
      transitionResearchRun(run, { type: "APPROVAL_GRANTED", occurredAt: STARTED_AT }, run.version),
    ).toThrow(ResearchRunTimestampOrderError);

    expect(() =>
      transitionResearchRun(
        run,
        { type: "APPROVAL_GRANTED", occurredAt: "not-a-timestamp" },
        run.version,
      ),
    ).toThrow("Research run event occurredAt must be an ISO 8601 date-time with a timezone");
  });

  it("follows the complete approved happy path and increments once per event", () => {
    let run: ResearchRun = createResearchRun({
      id: "run-happy",
      createdAt: STARTED_AT,
    });

    for (const [index, step] of progression.entries()) {
      const previous = run;
      const event = eventAt(step.event, index);

      run = transitionResearchRun(run, event, run.version);

      expect(previous.state).toBe(step.from);
      expect(run.state).toBe(step.to);
      expect(run.version).toBe(index + 1);
      expect(run.updatedAt).toBe(event.occurredAt);
      expect(run).not.toBe(previous);
      expect(Object.isFrozen(run)).toBe(true);
    }

    run = transitionResearchRun(
      run,
      {
        type: "VALIDATION_COMPLETED",
        occurredAt: "2026-08-29T20:07:00.000Z",
        result: { status: "COMPLETED" },
      },
      6,
    );

    expect(run).toMatchObject({
      state: "COMPLETED",
      version: 7,
      outcome: { kind: "COMPLETED" },
    });
    expect(isTerminalResearchRun(run)).toBe(true);
  });

  it("preserves the explanation when validation yields a partial bundle", () => {
    const validating = validatedRun();
    const result = transitionResearchRun(
      validating,
      {
        type: "VALIDATION_COMPLETED",
        occurredAt: "2026-08-29T21:00:00.000Z",
        result: {
          status: "PARTIAL",
          reason: "One source failed after bounded retries",
        },
      },
      validating.version,
    );

    expect(result).toMatchObject({
      state: "PARTIAL",
      version: validating.version + 1,
      outcome: {
        kind: "PARTIAL",
        reason: "One source failed after bounded retries",
      },
    });
  });

  it("allows failure from every active state and records where it happened", () => {
    const activeStates = RESEARCH_RUN_STATES.filter(
      (state): state is ActiveResearchRunState => !isTerminalResearchRunState(state),
    );

    for (const state of activeStates) {
      const run = runInState(state);
      const failed = transitionResearchRun(
        run,
        {
          type: "RUN_FAILED",
          occurredAt: "2026-08-29T22:00:00.000Z",
          failure: {
            code: "source_unavailable",
            message: "Provider remained unavailable",
            retryable: true,
          },
        },
        run.version,
      );

      expect(failed).toMatchObject({
        state: "FAILED",
        version: run.version + 1,
        outcome: {
          kind: "FAILED",
          fromState: state,
          failure: { code: "source_unavailable", retryable: true },
        },
      });
    }
  });

  it("copies and freezes failure details instead of retaining mutable event data", () => {
    const run = runInState("COLLECTING");
    const failure = {
      code: "schema_drift",
      message: "Unexpected provider payload",
      retryable: false,
    };
    const failed = transitionResearchRun(
      run,
      {
        type: "RUN_FAILED",
        occurredAt: "2026-08-29T22:30:00.000Z",
        failure,
      },
      run.version,
    );

    failure.message = "Mutated after transition";

    if (failed.state !== "FAILED") {
      throw new Error(`Expected FAILED, received ${failed.state}`);
    }

    expect(failed.outcome).toMatchObject({
      kind: "FAILED",
      failure: { message: "Unexpected provider payload" },
    });
    expect(Object.isFrozen(failed.outcome)).toBe(true);
    expect(Object.isFrozen(failed.outcome.failure)).toBe(true);
  });

  it("allows cancellation from every active state and records the reason", () => {
    const activeStates = RESEARCH_RUN_STATES.filter(
      (state): state is ActiveResearchRunState => !isTerminalResearchRunState(state),
    );

    for (const state of activeStates) {
      const run = runInState(state);
      const cancelled = transitionResearchRun(
        run,
        {
          type: "RUN_CANCELLED",
          occurredAt: "2026-08-29T23:00:00.000Z",
          reason: "User revoked approval",
        },
        run.version,
      );

      expect(cancelled).toMatchObject({
        state: "CANCELLED",
        outcome: {
          kind: "CANCELLED",
          fromState: state,
          reason: "User revoked approval",
        },
      });
    }
  });

  it("rejects every out-of-order progress event", () => {
    for (const currentState of progression.map((step) => step.from)) {
      const run = runInState(currentState);

      for (const [index, step] of progression.entries()) {
        if (step.from === currentState) {
          continue;
        }

        expect(() => transitionResearchRun(run, eventAt(step.event, index), run.version)).toThrow(
          IllegalResearchRunTransitionError,
        );
      }
    }

    const planning = runInState("PLANNING");
    expect(() =>
      transitionResearchRun(
        planning,
        {
          type: "VALIDATION_COMPLETED",
          occurredAt: "2026-08-30T00:00:00.000Z",
          result: { status: "COMPLETED" },
        },
        planning.version,
      ),
    ).toThrow(IllegalResearchRunTransitionError);

    const validating = runInState("VALIDATING");
    for (const [index, step] of progression.entries()) {
      expect(() =>
        transitionResearchRun(validating, eventAt(step.event, index), validating.version),
      ).toThrow(IllegalResearchRunTransitionError);
    }
  });

  it("reports expected and actual versions for a stale writer", () => {
    const run = runInState("WAITING_APPROVAL");

    expect(() =>
      transitionResearchRun(
        run,
        {
          type: "APPROVAL_GRANTED",
          occurredAt: "2026-08-30T01:00:00.000Z",
        },
        0,
      ),
    ).toThrow(
      expect.objectContaining({
        name: "ResearchRunVersionConflictError",
        runId: run.id,
        expectedVersion: 0,
        actualVersion: 1,
      }) as ResearchRunVersionConflictError,
    );
  });

  it("checks optimistic concurrency before transition legality", () => {
    const run = runInState("WAITING_APPROVAL");

    expect(() =>
      transitionResearchRun(
        run,
        {
          type: "COLLECTION_COMPLETED",
          occurredAt: "2026-08-30T02:00:00.000Z",
        },
        0,
      ),
    ).toThrow(ResearchRunVersionConflictError);
  });

  it("never mutates the supplied run when transitioning or rejecting an event", () => {
    const run = runInState("WAITING_APPROVAL");
    const snapshot = structuredClone(run);

    transitionResearchRun(
      run,
      {
        type: "APPROVAL_GRANTED",
        occurredAt: "2026-08-30T03:00:00.000Z",
      },
      run.version,
    );
    expect(run).toEqual(snapshot);

    expect(() =>
      transitionResearchRun(
        run,
        {
          type: "COLLECTION_COMPLETED",
          occurredAt: "2026-08-30T03:01:00.000Z",
        },
        run.version,
      ),
    ).toThrow(IllegalResearchRunTransitionError);
    expect(run).toEqual(snapshot);
  });

  it("rejects all events once a run is terminal", () => {
    const validating = validatedRun();
    const terminalRuns: readonly ResearchRun[] = [
      transitionResearchRun(
        validating,
        {
          type: "VALIDATION_COMPLETED",
          occurredAt: "2026-08-30T04:00:00.000Z",
          result: { status: "COMPLETED" },
        },
        validating.version,
      ),
      transitionResearchRun(
        validating,
        {
          type: "VALIDATION_COMPLETED",
          occurredAt: "2026-08-30T04:00:00.000Z",
          result: { status: "PARTIAL", reason: "Fixture partial" },
        },
        validating.version,
      ),
      transitionResearchRun(
        validating,
        {
          type: "RUN_FAILED",
          occurredAt: "2026-08-30T04:00:00.000Z",
          failure: {
            code: "fixture",
            message: "Fixture failure",
            retryable: false,
          },
        },
        validating.version,
      ),
      transitionResearchRun(
        validating,
        {
          type: "RUN_CANCELLED",
          occurredAt: "2026-08-30T04:00:00.000Z",
          reason: "Fixture cancel",
        },
        validating.version,
      ),
    ];

    const allEventShapes: readonly ResearchRunEvent[] = [
      { type: "PLAN_COMPLETED", occurredAt: STARTED_AT },
      { type: "APPROVAL_GRANTED", occurredAt: STARTED_AT },
      { type: "COLLECTION_COMPLETED", occurredAt: STARTED_AT },
      { type: "NORMALIZATION_COMPLETED", occurredAt: STARTED_AT },
      { type: "ANALYSIS_COMPLETED", occurredAt: STARTED_AT },
      { type: "SYNTHESIS_COMPLETED", occurredAt: STARTED_AT },
      {
        type: "VALIDATION_COMPLETED",
        occurredAt: STARTED_AT,
        result: { status: "COMPLETED" },
      },
      {
        type: "RUN_FAILED",
        occurredAt: STARTED_AT,
        failure: { code: "fixture", message: "Fixture", retryable: false },
      },
      { type: "RUN_CANCELLED", occurredAt: STARTED_AT, reason: "Fixture" },
    ];

    for (const run of terminalRuns) {
      for (const event of allEventShapes) {
        expect(() => transitionResearchRun(run, event, run.version)).toThrow(
          TerminalResearchRunError,
        );
      }
    }
  });

  it("still reports a version conflict first when a terminal snapshot is stale", () => {
    const validating = validatedRun();
    const completed = transitionResearchRun(
      validating,
      {
        type: "VALIDATION_COMPLETED",
        occurredAt: "2026-08-30T05:00:00.000Z",
        result: { status: "COMPLETED" },
      },
      validating.version,
    );

    expect(() =>
      transitionResearchRun(
        completed,
        { type: "RUN_CANCELLED", occurredAt: STARTED_AT, reason: "Too late" },
        validating.version,
      ),
    ).toThrow(ResearchRunVersionConflictError);
  });
});
