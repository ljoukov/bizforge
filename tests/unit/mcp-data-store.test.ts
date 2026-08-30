import { describe, expect, it } from "vitest";

import type { EvidenceItem } from "../../src/domain/evidence.js";
import type { ConfirmedFounderProfileSnapshot } from "../../src/domain/founder-profile.js";
import {
  type ConsentRecord,
  ConsentRecordSchema,
  type DataStoreStatus,
} from "../../src/mcp/contracts.js";
import { BizForgeStoreError, InMemoryBizForgeDataStore } from "../../src/mcp/data-store.js";
import { buildSyntheticResearchBundle, seedSyntheticMockData } from "../fixtures/mock-data.js";

function makeStore() {
  return new InMemoryBizForgeDataStore();
}

function persistentDataStatus(): DataStoreStatus {
  return {
    dataMode: "persistent",
    storageMode: "persistent",
    storageBackend: "sqlite",
    persistenceStatus: "persistent",
    isMock: false,
    ephemeral: false,
    writePolicy: {
      requiresExplicitMockAcceptance: false,
      acceptsNonSyntheticWrites: true,
    },
    fixtureVersion: "not-applicable",
    warnings: [],
  };
}

function makePersistentStore() {
  return new InMemoryBizForgeDataStore({ dataStatus: persistentDataStatus() });
}

function seedEvidence(evidenceId: string, timestamp = "2026-08-01T12:00:00.000Z"): EvidenceItem {
  return {
    evidenceId,
    evidenceType: "user_input",
    title: "Synthetic competency",
    summary: "A synthetic founder reports workflow automation experience.",
    provenance: {
      provider: "test",
      collectionMethod: "user_input",
      sourceRecordId: `input-${evidenceId}`,
      retrievedAt: timestamp,
      contentSha256: "a".repeat(64),
    },
    observedAt: timestamp,
    rawArtifactRef: `mock://${evidenceId}`,
    locator: { jsonPointer: "/value" },
    extraction: { method: "manual", version: "test-v1" },
    attributes: { synthetic: true },
    tags: ["synthetic"],
  };
}

function seedProfile(
  founderId: string,
  snapshotId: string,
  evidenceId: string,
): ConfirmedFounderProfileSnapshot {
  return {
    snapshotId,
    founderId,
    displayName: "Synthetic Founder",
    competencies: [
      {
        name: "Workflow automation",
        level: "working",
        evidenceIds: [evidenceId],
        confidence: { lower: 0.25, estimate: 0.5, upper: 0.75 },
      },
    ],
    businessAppetite: {
      hoursPerWeek: 10,
      capitalBudgetUsd: 1_000,
      timeToFirstRevenueDays: 30,
      teamSize: 1,
      preferredOfferTypes: ["hybrid"],
      preferredCustomerTypes: ["smb"],
      salesTolerance: "medium",
      riskTolerance: "medium",
      regulatoryTolerance: "low",
    },
    constraints: ["Synthetic only"],
    accessAdvantages: [],
    sourceEvidenceIds: [evidenceId],
    claims: { observed: [], inferred: [], assumptions: [] },
    capturedAt: "2026-08-01T12:00:00.000Z",
    confirmedAt: "2026-08-29T12:00:00.000Z",
  };
}

function prepareConfirmation(
  store: InMemoryBizForgeDataStore,
  ids = { setupRunId: "setup-new", founderId: "founder-new", evidenceId: "evidence-new" },
  isSynthetic = true,
) {
  store.createSetupRun({ ...ids, isSynthetic, now: "2026-08-01T12:00:00.000Z" });
  for (const [consentId, scope] of [
    ["self-report-new", "retain_minimized_founder_self_report"],
    ["profile-evidence-new", "retain_minimized_profile_evidence"],
    ["retain-new", "retain_minimized_founder_snapshot"],
    ["research-new", "use_confirmed_founder_snapshot_for_research"],
  ] as const) {
    store.recordConsent({
      consentId: `${consentId}-${ids.founderId}`,
      setupRunId: ids.setupRunId,
      founderId: ids.founderId,
      scope,
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-01T12:00:00.000Z",
      grantedAt: "2026-08-01T12:00:00.000Z",
    });
  }
  const evidence = seedEvidence(ids.evidenceId);
  store.putEvidence(ids.setupRunId, evidence, "mcp_write", isSynthetic);
  store.transitionSetupRun({
    setupRunId: ids.setupRunId,
    expectedVersion: 1,
    targetState: "INTERVIEW",
    idempotencyKey: "interview",
  });
  store.transitionSetupRun({
    setupRunId: ids.setupRunId,
    expectedVersion: 2,
    targetState: "DRAFT_REVIEW",
    idempotencyKey: "review",
  });
  return {
    ...ids,
    evidence,
    profile: seedProfile(ids.founderId, `snapshot-${ids.founderId}`, ids.evidenceId),
  };
}

describe("InMemoryBizForgeDataStore", () => {
  it("requires consent timestamps appropriate to active and revoked status", () => {
    const base = {
      consentId: "consent-validation",
      setupRunId: "setup-validation",
      founderId: "founder-validation",
      scope: "retain_minimized_founder_snapshot" as const,
      sourceUrls: [],
      recordedAt: "2026-08-01T12:00:00.000Z",
    };
    expect(ConsentRecordSchema.safeParse({ ...base, status: "active" }).success).toBe(false);
    expect(ConsentRecordSchema.safeParse({ ...base, status: "revoked" }).success).toBe(false);
    expect(ConsentRecordSchema.safeParse({ ...base, status: "declined" }).success).toBe(true);
  });

  it("refuses to synthesize research without founder evidence", () => {
    const profile = seedProfile("founder-empty", "snapshot-empty", "evidence-empty");
    expect(() => buildSyntheticResearchBundle(profile, [])).toThrow(
      /at least one founder evidence/,
    );
  });

  it("seeds a schema-valid synthetic Step 1 to Step 2 to Step 3 demo", () => {
    const store = makeStore();
    seedSyntheticMockData(store);

    const run = store.getSetupRun("setup-synthetic-demo");
    const bundle = store.getLatestResearchBundle("founder-synthetic-demo");
    expect(run?.value.state).toBe("CONFIRMED");
    expect(run).toMatchObject({
      isMock: true,
      ephemeral: true,
      storageBackend: "memory",
      isSynthetic: true,
      source: "mock_seed",
    });
    expect(bundle?.value.founderProfile.snapshotId).toBe("snapshot-synthetic-demo");
    expect(bundle?.value.marketSignals[0]?.measurement).toMatchObject({
      baselineValue: 24,
      value: 39,
      absoluteChange: 15,
      percentageChange: 62.5,
    });
    expect(store.getResearchBundle(bundle?.value.bundleId ?? "missing")?.value).toEqual(
      bundle?.value,
    );
    expect(store.getResearchBundle(bundle?.value.bundleId ?? "missing", 99)).toBeUndefined();
    expect(store.getLatestResearchBundle("missing-founder")).toBeUndefined();
    expect(store.getOpportunity("missing-opportunity")).toBeUndefined();
  });

  it("enforces ownership, CAS, transition rules, and idempotency", () => {
    const store = makeStore();
    const created = store.createSetupRun({
      founderId: "founder-cas",
      setupRunId: "setup-cas",
      isSynthetic: true,
    });
    expect(
      store.createSetupRun({
        founderId: "founder-cas",
        setupRunId: "setup-cas",
        isSynthetic: true,
      }),
    ).toEqual(created);
    expect(() =>
      store.createSetupRun({ founderId: "other", setupRunId: "setup-cas", isSynthetic: true }),
    ).toThrowError(BizForgeStoreError);

    const input = {
      setupRunId: "setup-cas",
      expectedVersion: 1,
      targetState: "INTERVIEW" as const,
      idempotencyKey: "same",
      stateData: { branch: "interview_only" },
    };
    expect(store.transitionSetupRun(input)).toMatchObject({ replayed: false, run: { version: 2 } });
    expect(store.transitionSetupRun(input)).toMatchObject({ replayed: true, run: { version: 2 } });
    expect(() => store.transitionSetupRun({ ...input, targetState: "PUBLIC_EVIDENCE" })).toThrow(
      /idempotency key/,
    );
    expect(() => store.transitionSetupRun({ ...input, idempotencyKey: "wrong-version" })).toThrow(
      /current version is 2/,
    );
    expect(() =>
      store.transitionSetupRun({
        setupRunId: "setup-cas",
        expectedVersion: 2,
        targetState: "CONFIRMED",
        idempotencyKey: "invalid",
      }),
    ).toThrow(/reserved for atomic founder-profile confirmation/);
    expect(() => store.getConsent("unknown")).toThrow(/not found/);

    store.createSetupRun({
      founderId: "founder-synthetic-origin",
      setupRunId: "setup-synthetic-origin",
      isSynthetic: true,
    });
    expect(() =>
      store.createSetupRun({
        founderId: "founder-synthetic-origin",
        setupRunId: "setup-synthetic-origin",
        isSynthetic: false,
      }),
    ).toThrow(/synthetic records only/);
  });

  it("assigns opaque runtime IDs and replays an explicit setup ID without a founder ID", () => {
    const store = makeStore();
    const generated = store.createSetupRun({ isSynthetic: true });

    expect(generated.value.founderId).toMatch(/^founder-[0-9a-f-]+$/);
    expect(generated.value.setupRunId).toMatch(/^setup-[0-9a-f-]+$/);

    const explicit = store.createSetupRun({
      founderId: "founder-explicit",
      setupRunId: "setup-explicit",
      isSynthetic: true,
    });
    expect(store.createSetupRun({ setupRunId: "setup-explicit", isSynthetic: true })).toEqual(
      explicit,
    );
  });

  it("replays generated setup IDs by client request and rejects conflicting key reuse", () => {
    const store = makeStore();
    const request = {
      clientRequestId: "application-generated-create-request",
      isSynthetic: true,
    } as const;
    const created = store.createSetupRun(request);

    expect(store.createSetupRun(request)).toEqual(created);
    expect(() =>
      store.createSetupRun({ ...request, founderId: "founder-conflicting-retry" }),
    ).toThrow(/clientRequestId was already used with different parameters/);
  });

  it("rejects blank request keys before any mutation can be persisted", () => {
    const store = makeStore();
    expect(() => store.createSetupRun({ clientRequestId: " \t", isSynthetic: true })).toThrow(
      /clientRequestId must contain at least one non-whitespace character/,
    );
    expect(store.exportSnapshot().creationKeys).toHaveLength(0);

    const prepared = prepareConfirmation(store, {
      setupRunId: "setup-blank-request-keys",
      founderId: "founder-blank-request-keys",
      evidenceId: "evidence-blank-request-keys",
    });
    const before = store.exportSnapshot();
    expect(() =>
      store.transitionSetupRun({
        setupRunId: prepared.setupRunId,
        expectedVersion: 3,
        targetState: "DRAFT_REVIEW",
        idempotencyKey: "  ",
      }),
    ).toThrow(/idempotency key must contain at least one non-whitespace character/);
    expect(() =>
      store.confirmFounderProfile({
        setupRunId: prepared.setupRunId,
        expectedVersion: 3,
        idempotencyKey: "\n",
        profile: prepared.profile,
        isSynthetic: true,
      }),
    ).toThrow(/idempotency key must contain at least one non-whitespace character/);
    expect(() =>
      store.requestDeletion({
        setupRunId: prepared.setupRunId,
        founderId: prepared.founderId,
        reason: "blank key must not delete",
        idempotencyKey: "",
      }),
    ).toThrow(/idempotency key must contain at least one non-whitespace character/);
    expect(store.exportSnapshot()).toEqual(before);

    const firstTransition = before.transitionKeys[0];
    if (firstTransition === undefined) throw new Error("expected transition receipt");
    const transitionSetupRunId =
      firstTransition[1].status === "replayable"
        ? firstTransition[1].run.setupRunId
        : firstTransition[1].setupRunId;
    const whitespaceCanonicalKeySnapshot = {
      ...structuredClone(before),
      transitionKeys: [
        [
          `@1:${transitionSetupRunId.length}:${transitionSetupRunId}: `,
          firstTransition[1],
        ] as const,
        ...before.transitionKeys.slice(1),
      ],
    };
    expect(() => makeStore().restoreSnapshot(whitespaceCanonicalKeySnapshot)).toThrow(
      /scoped idempotency key suffix cannot be empty/,
    );

    const creationStore = makeStore();
    creationStore.createSetupRun({ clientRequestId: "valid-create", isSynthetic: true });
    const validCreationSnapshot = creationStore.exportSnapshot();
    const creationReceipt = validCreationSnapshot.creationKeys[0]?.[1];
    if (creationReceipt === undefined) throw new Error("expected creation receipt");
    const blankCreationSnapshot = {
      ...structuredClone(validCreationSnapshot),
      creationKeys: [[" ", creationReceipt] as const],
    };
    expect(() => makeStore().restoreSnapshot(blankCreationSnapshot)).toThrow(
      /setup creation clientRequestId cannot be empty/,
    );
  });

  it("supports idempotent INTERVIEW checkpoints when callers merge replacement stateData", () => {
    const store = makeStore();
    store.createSetupRun({
      founderId: "founder-interview-checkpoint",
      setupRunId: "setup-interview-checkpoint",
      isSynthetic: true,
    });
    const enteredInterview = store.transitionSetupRun({
      setupRunId: "setup-interview-checkpoint",
      expectedVersion: 1,
      targetState: "INTERVIEW",
      idempotencyKey: "enter-interview",
      stateData: {
        answers: { competency: "workflow automation" },
        answeredFields: ["competency"],
      },
    });
    const mergedStateData = {
      ...enteredInterview.run.stateData,
      answers: {
        ...(enteredInterview.run.stateData.answers as Record<string, unknown>),
        availabilityHoursPerWeek: 15,
      },
      answeredFields: ["competency", "availabilityHoursPerWeek"],
    };
    const checkpointInput = {
      setupRunId: "setup-interview-checkpoint",
      expectedVersion: 2,
      targetState: "INTERVIEW" as const,
      idempotencyKey: "interview-checkpoint-2",
      stateData: mergedStateData,
    };

    expect(store.transitionSetupRun(checkpointInput)).toMatchObject({
      replayed: false,
      run: { state: "INTERVIEW", version: 3, stateData: mergedStateData },
    });
    expect(store.transitionSetupRun(checkpointInput)).toMatchObject({
      replayed: true,
      run: { state: "INTERVIEW", version: 3, stateData: mergedStateData },
    });
    expect(() =>
      store.transitionSetupRun({
        ...checkpointInput,
        stateData: { availabilityHoursPerWeek: 20 },
      }),
    ).toThrow(/idempotency key/);
    expect(() =>
      store.transitionSetupRun({
        ...checkpointInput,
        idempotencyKey: "stale-interview-checkpoint",
      }),
    ).toThrow(/current version is 3/);

    const replacement = store.transitionSetupRun({
      setupRunId: "setup-interview-checkpoint",
      expectedVersion: 3,
      targetState: "INTERVIEW",
      idempotencyKey: "replacement-semantics",
      stateData: { latestAnswerOnly: true },
    });
    expect(replacement.run.stateData).toEqual({ latestAnswerOnly: true });
  });

  it("isolates scoped idempotency keys for legacy explicit setup IDs containing colons", () => {
    const store = makeStore();
    store.createSetupRun({ setupRunId: "a", founderId: "founder-a", isSynthetic: true });
    store.createSetupRun({ setupRunId: "a:b", founderId: "founder-a-b", isSynthetic: true });
    const firstInput = {
      setupRunId: "a",
      expectedVersion: 1,
      targetState: "INTERVIEW" as const,
      idempotencyKey: "b:shared",
    };
    const secondInput = {
      setupRunId: "a:b",
      expectedVersion: 1,
      targetState: "INTERVIEW" as const,
      idempotencyKey: "shared",
    };
    expect(store.transitionSetupRun(firstInput)).toMatchObject({ replayed: false });
    expect(store.transitionSetupRun(secondInput)).toMatchObject({ replayed: false });
    expect(store.transitionSetupRun(firstInput)).toMatchObject({ replayed: true });
    expect(store.transitionSetupRun(secondInput)).toMatchObject({ replayed: true });
    expect(store.exportSnapshot().transitionKeys).toHaveLength(2);

    store.requestDeletion({
      setupRunId: "a",
      founderId: "founder-a",
      reason: "Remove only run a",
      idempotencyKey: "b:delete",
    });
    expect(store.getSetupRun("a")).toBeUndefined();
    expect(store.getSetupRun("a:b")?.value.version).toBe(2);
    expect(store.transitionSetupRun(secondInput)).toMatchObject({ replayed: true });

    const legacyStore = makeStore();
    legacyStore.createSetupRun({
      setupRunId: "legacy:run",
      founderId: "legacy-founder",
      isSynthetic: true,
    });
    const legacyInput = {
      setupRunId: "legacy:run",
      expectedVersion: 1,
      targetState: "INTERVIEW" as const,
      idempotencyKey: "legacy:key",
    };
    legacyStore.transitionSetupRun(legacyInput);
    const canonicalSnapshot = legacyStore.exportSnapshot();
    const legacySnapshot = {
      ...structuredClone(canonicalSnapshot),
      transitionKeys: canonicalSnapshot.transitionKeys.map(
        ([, replay]) =>
          [`${legacyInput.setupRunId}:${legacyInput.idempotencyKey}`, replay] as const,
      ),
    };
    const migrated = makeStore();
    migrated.restoreSnapshot(legacySnapshot);
    expect(migrated.transitionSetupRun(legacyInput)).toMatchObject({ replayed: true });
    expect(migrated.exportSnapshot().transitionKeys[0]?.[0]).toMatch(/^@1:/);
  });

  it("requires effective purpose-specific consent for founder evidence", () => {
    const store = makeStore();
    store.createSetupRun({
      founderId: "founder-purpose",
      setupRunId: "setup-purpose",
      isSynthetic: true,
    });
    const selfReport = seedEvidence("evidence-purpose");
    expect(() => store.putEvidence("setup-purpose", selfReport, "mcp_write", true)).toThrow(
      /retain_minimized_founder_self_report/,
    );
    store.recordConsent({
      consentId: "profile-purpose",
      setupRunId: "setup-purpose",
      founderId: "founder-purpose",
      scope: "retain_minimized_profile_evidence",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-01T12:00:00.000Z",
      grantedAt: "2026-08-01T12:00:00.000Z",
    });
    const profileEvidence = {
      ...selfReport,
      evidenceId: "profile-evidence-purpose",
      evidenceType: "other" as const,
      provenance: {
        ...selfReport.provenance,
        collectionMethod: "manual_import" as const,
      },
    };
    expect(store.putEvidence("setup-purpose", profileEvidence, "mcp_write", true).value).toEqual(
      profileEvidence,
    );
    expect(() =>
      store.putEvidence(
        "setup-purpose",
        {
          ...selfReport,
          evidenceId: "misclassified-user-input-purpose",
          provenance: {
            ...selfReport.provenance,
            collectionMethod: "manual_import",
          },
        },
        "mcp_write",
        true,
      ),
    ).toThrow(/user_input evidenceType and user_input collectionMethod/);
    expect(() =>
      store.putEvidence(
        "setup-purpose",
        {
          ...selfReport,
          evidenceId: "misclassified-import-purpose",
          evidenceType: "other",
        },
        "mcp_write",
        true,
      ),
    ).toThrow(/user_input evidenceType and user_input collectionMethod/);
    expect(() => store.putEvidence("setup-purpose", selfReport, "mcp_write", false)).toThrow(
      /synthetic records only/,
    );
    store.recordConsent({
      consentId: "profile-purpose-revoked",
      setupRunId: "setup-purpose",
      founderId: "founder-purpose",
      scope: "retain_minimized_profile_evidence",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-02T12:00:00.000Z",
      revokedAt: "2026-08-02T12:00:00.000Z",
    });
    expect(() =>
      store.putEvidence(
        "setup-purpose",
        { ...profileEvidence, evidenceId: "profile-evidence-after-revoke" },
        "mcp_write",
        true,
      ),
    ).toThrow(/retain_minimized_profile_evidence/);
  });

  it("keeps consent and evidence immutable and scoped to a run", () => {
    const store = makeStore();
    store.createSetupRun({ founderId: "founder-a", setupRunId: "setup-a", isSynthetic: true });
    store.createSetupRun({ founderId: "founder-b", setupRunId: "setup-b", isSynthetic: true });
    const consent = {
      consentId: "consent-a",
      setupRunId: "setup-a",
      founderId: "founder-a",
      scope: "retain_minimized_founder_snapshot" as const,
      status: "active" as const,
      sourceUrls: [],
      recordedAt: "2026-08-01T12:00:00.000Z",
      grantedAt: "2026-08-01T12:00:00.000Z",
    };
    expect(store.recordConsent(consent).isSynthetic).toBe(true);
    expect(store.recordConsent(consent).value).toEqual(consent);
    expect(store.getConsent("setup-a", consent.scope)).toHaveLength(1);
    expect(store.getConsent("setup-a", "retain_founder_version_history")).toHaveLength(0);
    expect(() => store.recordConsent({ ...consent, status: "declined" })).toThrow(/immutable/);
    expect(() =>
      store.recordConsent({ ...consent, consentId: "wrong-founder", founderId: "founder-b" }),
    ).toThrow(/does not match/);

    for (const [setupRunId, founderId] of [
      ["setup-a", "founder-a"],
      ["setup-b", "founder-b"],
    ] as const) {
      store.recordConsent({
        consentId: `self-report-${founderId}`,
        setupRunId,
        founderId,
        scope: "retain_minimized_founder_self_report",
        status: "active",
        sourceUrls: [],
        recordedAt: "2026-08-01T12:01:00.000Z",
        grantedAt: "2026-08-01T12:01:00.000Z",
      });
    }

    const evidence = seedEvidence("evidence-a");
    expect(store.putEvidence("setup-a", evidence, "mcp_write", true).value).toEqual(evidence);
    expect(store.putEvidence("setup-a", evidence, "mcp_write", true).value).toEqual(evidence);
    expect(store.getEvidence("evidence-a")?.value).toEqual(evidence);
    expect(store.getEvidence("missing")).toBeUndefined();
    expect(() => store.putEvidence("setup-b", evidence)).toThrow(/different content or ownership/);
    expect(() => store.putEvidence("setup-a", { ...evidence, title: "Different" })).toThrow(
      /different content or ownership/,
    );
  });

  it("publishes a synthetic profile without generating research and saves a bundle explicitly", () => {
    const store = makeStore();
    const prepared = prepareConfirmation(store);
    const input = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "confirm-new",
      isSynthetic: true,
      profile: prepared.profile,
    };
    const result = store.confirmFounderProfile(input);
    expect(result).toMatchObject({
      stage2HandoffEligible: false,
      replayed: false,
      run: { state: "CONFIRMED", version: 4 },
    });
    expect(store.confirmFounderProfile(input)).toMatchObject({ replayed: true });
    expect(() =>
      store.confirmFounderProfile({
        ...input,
        profile: { ...input.profile, displayName: "Changed" },
      }),
    ).toThrow(/idempotency key/);
    expect(store.getFounderProfile(prepared.profile.snapshotId)?.value).toEqual(prepared.profile);
    expect(store.getFounderProfile("missing")).toBeUndefined();

    expect(store.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
    const bundle = buildSyntheticResearchBundle(prepared.profile, [prepared.evidence]);
    const saved = store.saveResearchBundle(bundle, "mcp_write", true);
    expect(saved.value.founderProfile).toEqual(prepared.profile);
    expect(saved.value.opportunities[0]?.founderProfileSnapshotId).toBe(
      prepared.profile.snapshotId,
    );
    expect(saved.isSynthetic).toBe(true);
    expect(store.saveResearchBundle(bundle, "mcp_write", true)).toEqual(saved);
    expect(() => store.saveResearchBundle(bundle, "mcp_write", false)).toThrow(
      /synthetic records only/,
    );
  });

  it("uses only the newest consent event and keeps research handoff disabled after revocation", () => {
    const retentionStore = makeStore();
    const retention = prepareConfirmation(retentionStore, {
      setupRunId: "setup-retention-revoked",
      founderId: "founder-retention-revoked",
      evidenceId: "evidence-retention-revoked",
    });
    retentionStore.recordConsent({
      consentId: "retention-revoked-new-event",
      setupRunId: retention.setupRunId,
      founderId: retention.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-02T12:00:00.000Z",
      revokedAt: "2026-08-02T12:00:00.000Z",
    });
    expect(() =>
      retentionStore.confirmFounderProfile({
        setupRunId: retention.setupRunId,
        expectedVersion: 3,
        idempotencyKey: "retention-revoked",
        isSynthetic: true,
        profile: retention.profile,
      }),
    ).toThrow(/retain_minimized_founder_snapshot/);
    expect(retentionStore.getFounderProfile(retention.profile.snapshotId)).toBeUndefined();

    const researchStore = makeStore();
    const research = prepareConfirmation(researchStore, {
      setupRunId: "setup-research-revoked",
      founderId: "founder-research-revoked",
      evidenceId: "evidence-research-revoked",
    });
    researchStore.recordConsent({
      consentId: "research-revoked-new-event",
      setupRunId: research.setupRunId,
      founderId: research.founderId,
      scope: "use_confirmed_founder_snapshot_for_research",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-02T12:00:00.000Z",
      revokedAt: "2026-08-02T12:00:00.000Z",
    });
    const result = researchStore.confirmFounderProfile({
      setupRunId: research.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "research-revoked",
      isSynthetic: true,
      profile: research.profile,
    });
    expect(result).toMatchObject({
      stage2HandoffEligible: false,
      run: { state: "CONFIRMED" },
    });
    expect(() =>
      researchStore.saveResearchBundle(
        buildSyntheticResearchBundle(research.profile, [research.evidence]),
        "mcp_write",
        true,
      ),
    ).toThrow(/use_confirmed_founder_snapshot_for_research/);
    expect(researchStore.getLatestResearchBundle(research.founderId)).toBeUndefined();
  });

  it("recomputes confirmation replay eligibility after research consent is revoked and restored", () => {
    for (const scenario of [
      {
        name: "mock",
        store: makeStore(),
        restoredStore: makeStore(),
        isSynthetic: true,
        initialStage2Eligibility: false,
      },
      {
        name: "persistent",
        store: makePersistentStore(),
        restoredStore: makePersistentStore(),
        isSynthetic: false,
        initialStage2Eligibility: true,
      },
    ]) {
      const prepared = prepareConfirmation(
        scenario.store,
        {
          setupRunId: `setup-replay-revocation-${scenario.name}`,
          founderId: `founder-replay-revocation-${scenario.name}`,
          evidenceId: `evidence-replay-revocation-${scenario.name}`,
        },
        scenario.isSynthetic,
      );
      const input = {
        setupRunId: prepared.setupRunId,
        expectedVersion: 3,
        idempotencyKey: "confirmation-replay-revocation",
        isSynthetic: scenario.isSynthetic,
        profile: prepared.profile,
      };
      expect(scenario.store.confirmFounderProfile(input)).toMatchObject({
        stage2HandoffEligible: scenario.initialStage2Eligibility,
        replayed: false,
      });
      scenario.store.recordConsent({
        consentId: `research-replay-revoked-${scenario.name}`,
        setupRunId: prepared.setupRunId,
        founderId: prepared.founderId,
        scope: "use_confirmed_founder_snapshot_for_research",
        status: "revoked",
        sourceUrls: [],
        recordedAt: "2026-08-30T12:00:00.000Z",
        revokedAt: "2026-08-30T12:00:00.000Z",
      });
      const snapshotWithStaleCachedEligibility = scenario.store.exportSnapshot();

      expect(scenario.store.confirmFounderProfile(input)).toMatchObject({
        stage2HandoffEligible: false,
        replayed: true,
      });

      scenario.restoredStore.restoreSnapshot(snapshotWithStaleCachedEligibility);
      expect(scenario.restoredStore.confirmFounderProfile(input)).toMatchObject({
        stage2HandoffEligible: false,
        replayed: true,
      });
    }
  });

  it("server-issues opaque snapshot IDs for real profiles and tombstones only issued IDs", () => {
    const store = makePersistentStore();
    const prepared = prepareConfirmation(
      store,
      {
        setupRunId: "setup-server-issued-snapshot",
        founderId: "founder-server-issued-snapshot",
        evidenceId: "evidence-server-issued-snapshot",
      },
      false,
    );
    const requestedSnapshotId = "client-selected-semantic-profile-id";
    const input = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "server-issued-snapshot-confirmation",
      isSynthetic: false,
      profile: { ...prepared.profile, snapshotId: requestedSnapshotId },
    } as const;
    const confirmed = store.confirmFounderProfile(input);
    const issuedSnapshotId = confirmed.profile.value.snapshotId;
    expect(issuedSnapshotId).toMatch(/^snapshot-[0-9a-f-]{36}$/);
    expect(issuedSnapshotId).not.toBe(requestedSnapshotId);
    expect(store.confirmFounderProfile(input).profile.value.snapshotId).toBe(issuedSnapshotId);

    store.recordConsent({
      consentId: "server-issued-snapshot-revoked",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-30T12:00:00.000Z",
      revokedAt: "2026-08-30T12:00:00.000Z",
    });
    const withdrawn = store.exportSnapshot();
    expect(withdrawn.withdrawnProfileSnapshotIds).toContain(issuedSnapshotId);
    expect(withdrawn.withdrawnProfileSnapshotIds).not.toContain(requestedSnapshotId);
    expect(JSON.stringify(withdrawn)).not.toContain(requestedSnapshotId);

    store.recordConsent({
      consentId: "server-issued-snapshot-regranted",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-31T12:00:00.000Z",
      grantedAt: "2026-08-31T12:00:00.000Z",
    });
    const replacement = store.confirmFounderProfile({
      ...input,
      expectedVersion: 5,
      idempotencyKey: "server-issued-snapshot-replacement",
    });
    expect(replacement.profile.value.snapshotId).toMatch(/^snapshot-[0-9a-f-]{36}$/);
    expect(replacement.profile.value.snapshotId).not.toBe(issuedSnapshotId);
    expect(replacement.profile.value.snapshotId).not.toBe(requestedSnapshotId);
  });

  it("withdraws a retained snapshot durably and permits only a new snapshot after re-consent", () => {
    const store = makeStore();
    const prepared = prepareConfirmation(store, {
      setupRunId: "setup-snapshot-retention-revoked",
      founderId: "founder-snapshot-retention-revoked",
      evidenceId: "evidence-snapshot-retention-revoked",
    });
    const withdrawnProfile = {
      ...prepared.profile,
      displayName: "WITHDRAWN-PROFILE-PAYLOAD",
    };
    store.recordConsent({
      consentId: "snapshot-withdrawal-version-history-active",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_founder_version_history",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-02T12:00:00.000Z",
      grantedAt: "2026-08-02T12:00:00.000Z",
    });
    store.transitionSetupRun({
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      targetState: "DRAFT_REVIEW",
      idempotencyKey: "snapshot-withdrawal-nested-draft",
      stateData: { draftProfile: { displayName: "WITHDRAWN-PROFILE-PAYLOAD" } },
    });
    const confirmationInput = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 4,
      idempotencyKey: "confirmation-snapshot-retention-revoked",
      isSynthetic: true,
      profile: withdrawnProfile,
    } as const;
    store.confirmFounderProfile(confirmationInput);
    const bundle = store.saveResearchBundle(
      buildSyntheticResearchBundle(withdrawnProfile, [prepared.evidence]),
      "mcp_write",
      true,
    );
    const opportunityId = bundle.value.opportunities[0]?.opportunityId;
    if (opportunityId === undefined) throw new Error("expected generated opportunity");

    const beforeBackdatedRevocation = store.exportSnapshot();
    store.recordConsent({
      consentId: "snapshot-retention-backdated-revocation",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-07-30T12:00:00.000Z",
      revokedAt: "2026-07-30T12:00:00.000Z",
    });
    expect(store.getFounderProfile(withdrawnProfile.snapshotId)?.value).toEqual(withdrawnProfile);
    expect(store.exportSnapshot().historyCleanupGeneration).toBe(
      beforeBackdatedRevocation.historyCleanupGeneration,
    );

    const revocation: ConsentRecord = {
      consentId: "snapshot-retention-revoked",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-30T12:00:00.000Z",
      revokedAt: "2026-08-30T12:00:00.000Z",
    };
    store.recordConsent(revocation);

    expect(store.getFounderProfile(withdrawnProfile.snapshotId)).toBeUndefined();
    expect(
      store.getResearchBundle(bundle.value.bundleId, bundle.value.bundleVersion),
    ).toBeUndefined();
    expect(store.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
    expect(store.getOpportunity(opportunityId)).toBeUndefined();
    expect(() => store.confirmFounderProfile(confirmationInput)).toThrow(
      /snapshot ID was withdrawn/,
    );
    expect(() =>
      store.confirmFounderProfile({
        ...confirmationInput,
        idempotencyKey: "attempt-withdrawn-snapshot-resurrection",
        profile: { ...withdrawnProfile, displayName: "Changed withdrawn payload" },
      }),
    ).toThrow(/snapshot ID was withdrawn/);

    const withdrawnSnapshot = store.exportSnapshot();
    const withdrawnRun = store.getSetupRun(prepared.setupRunId)?.value;
    expect(withdrawnRun).toMatchObject({ state: "REVISION_DRAFT", version: 6, stateData: {} });
    expect(withdrawnSnapshot.profiles).toHaveLength(0);
    expect(withdrawnSnapshot.bundles).toHaveLength(0);
    expect(withdrawnSnapshot.currentProfileSnapshotIds).toHaveLength(0);
    expect(withdrawnSnapshot.withdrawnProfileSnapshotIds).toContain(withdrawnProfile.snapshotId);
    expect(withdrawnSnapshot.profileReplacementRequiredSetupRunIds).toContain(prepared.setupRunId);
    expect(withdrawnSnapshot.historyCleanupGeneration).toBeGreaterThan(
      withdrawnSnapshot.historyCleanupCompletedGeneration,
    );
    expect(JSON.stringify(withdrawnSnapshot)).not.toContain("WITHDRAWN-PROFILE-PAYLOAD");
    expect(store.getEvidence(prepared.evidenceId)?.value).toEqual(prepared.evidence);
    expect(
      withdrawnSnapshot.confirmationKeys.find(([key]) =>
        key.endsWith(":confirmation-snapshot-retention-revoked"),
      )?.[1],
    ).toMatchObject({ status: "snapshot_withdrawn", setupRunId: prepared.setupRunId });
    const generationAfterWithdrawal = withdrawnSnapshot.historyCleanupGeneration;
    store.recordConsent(revocation);
    expect(store.exportSnapshot().historyCleanupGeneration).toBe(generationAfterWithdrawal);
    expect(store.getSetupRun(prepared.setupRunId)?.value.version).toBe(6);

    const preWithdrawalNestedDraft = beforeBackdatedRevocation.transitionKeys.find(([key]) =>
      key.endsWith(":snapshot-withdrawal-nested-draft"),
    );
    if (preWithdrawalNestedDraft?.[1].status !== "replayable") {
      throw new Error("expected pre-withdrawal nested draft replay");
    }
    const restoredHistoricalReplay = {
      ...structuredClone(withdrawnSnapshot),
      transitionKeys: withdrawnSnapshot.transitionKeys.map(([key, replay]) =>
        key === preWithdrawalNestedDraft[0]
          ? ([key, preWithdrawalNestedDraft[1]] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(restoredHistoricalReplay)).toThrow(
      /transition replay is at or before founder-snapshot withdrawal/,
    );
    const restoredWithdrawalStateData = {
      ...structuredClone(withdrawnSnapshot),
      runs: withdrawnSnapshot.runs.map(([setupRunId, record]) =>
        setupRunId === prepared.setupRunId
          ? ([
              setupRunId,
              {
                ...record,
                value: {
                  ...record.value,
                  stateData: { nestedProfile: withdrawnProfile },
                },
              },
            ] as const)
          : ([setupRunId, record] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(restoredWithdrawalStateData)).toThrow(
      /withdrawal checkpoint must have empty state data|replacement-required run retains founder draft data without consent/,
    );

    const restored = makeStore();
    restored.restoreSnapshot(withdrawnSnapshot);
    expect(restored.getFounderProfile(withdrawnProfile.snapshotId)).toBeUndefined();
    expect(
      restored.getResearchBundle(bundle.value.bundleId, bundle.value.bundleVersion),
    ).toBeUndefined();
    expect(restored.getOpportunity(opportunityId)).toBeUndefined();
    expect(() => restored.confirmFounderProfile(confirmationInput)).toThrow(
      /snapshot ID was withdrawn/,
    );
    expect(restored.getEvidence(prepared.evidenceId)?.value).toEqual(prepared.evidence);

    const rejectedReplacementDraft = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 6,
      targetState: "REVISION_DRAFT" as const,
      idempotencyKey: "replacement-draft-before-reconsent",
      stateData: { nestedProfile: withdrawnProfile },
    };
    const beforeRejectedDraft = restored.exportSnapshot();
    expect(() => restored.transitionSetupRun(rejectedReplacementDraft)).toThrow(
      /Snapshot-retention consent must be active/,
    );
    expect(() =>
      restored.transitionSetupRun({
        ...rejectedReplacementDraft,
        targetState: "DELETION_REQUESTED",
        idempotencyKey: "nonempty-deletion-before-reconsent",
      }),
    ).toThrow(/Snapshot-retention consent must be active/);
    expect(restored.exportSnapshot()).toEqual(beforeRejectedDraft);

    const emptyDeletionStore = makeStore();
    emptyDeletionStore.restoreSnapshot(withdrawnSnapshot);
    expect(
      emptyDeletionStore.transitionSetupRun({
        setupRunId: prepared.setupRunId,
        expectedVersion: 6,
        targetState: "DELETION_REQUESTED",
        idempotencyKey: "empty-deletion-before-reconsent",
        stateData: {},
      }),
    ).toMatchObject({ run: { state: "DELETION_REQUESTED", version: 7, stateData: {} } });
    expect(emptyDeletionStore.exportSnapshot().profileReplacementRequiredSetupRunIds).toContain(
      prepared.setupRunId,
    );
    const restartedEmptyDeletionStore = makeStore();
    restartedEmptyDeletionStore.restoreSnapshot(emptyDeletionStore.exportSnapshot());

    const reconsentedDraftStore = makeStore();
    reconsentedDraftStore.restoreSnapshot(withdrawnSnapshot);
    reconsentedDraftStore.recordConsent({
      consentId: "snapshot-retention-regranted-for-draft",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-31T12:00:00.000Z",
      grantedAt: "2026-08-31T12:00:00.000Z",
    });
    const reconsentedDraftInput = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 6,
      targetState: "REVISION_DRAFT" as const,
      idempotencyKey: "replacement-draft-after-reconsent",
      stateData: { draftMarker: "RECONSENTED-DRAFT-SENSITIVE" },
    };
    expect(reconsentedDraftStore.transitionSetupRun(reconsentedDraftInput)).toMatchObject({
      run: { version: 7, stateData: reconsentedDraftInput.stateData },
    });
    reconsentedDraftStore.recordConsent({
      consentId: "snapshot-retention-revoked-before-reconfirmation",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-09-01T12:00:00.000Z",
      revokedAt: "2026-09-01T12:00:00.000Z",
    });
    const twiceWithdrawnSnapshot = reconsentedDraftStore.exportSnapshot();
    expect(reconsentedDraftStore.getSetupRun(prepared.setupRunId)?.value).toMatchObject({
      state: "REVISION_DRAFT",
      version: 8,
      stateData: {},
    });
    expect(JSON.stringify(twiceWithdrawnSnapshot)).not.toContain("RECONSENTED-DRAFT-SENSITIVE");
    expect(twiceWithdrawnSnapshot.historyCleanupGeneration).toBeGreaterThan(
      withdrawnSnapshot.historyCleanupGeneration,
    );
    const restartedTwiceWithdrawn = makeStore();
    restartedTwiceWithdrawn.restoreSnapshot(twiceWithdrawnSnapshot);
    expect(() => restartedTwiceWithdrawn.transitionSetupRun(reconsentedDraftInput)).toThrow(
      /founder-snapshot retention was withdrawn/,
    );

    restored.recordConsent({
      consentId: "snapshot-retention-regranted",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-31T12:00:00.000Z",
      grantedAt: "2026-08-31T12:00:00.000Z",
    });
    const replacementProfile = {
      ...seedProfile(prepared.founderId, "snapshot-after-retention-reconsent", prepared.evidenceId),
      displayName: "Replacement Founder Profile",
      confirmedAt: "2026-08-31T12:00:00.000Z",
    };
    expect(
      restored.confirmFounderProfile({
        setupRunId: prepared.setupRunId,
        expectedVersion: 6,
        idempotencyKey: "confirmation-after-retention-reconsent",
        isSynthetic: true,
        profile: replacementProfile,
      }),
    ).toMatchObject({
      replayed: false,
      run: { state: "CONFIRMED", version: 7 },
      profile: { value: replacementProfile },
    });
    const replacedSnapshot = restored.exportSnapshot();
    expect(replacedSnapshot.withdrawnProfileSnapshotIds).toContain(withdrawnProfile.snapshotId);
    expect(replacedSnapshot.profileReplacementRequiredSetupRunIds).not.toContain(
      prepared.setupRunId,
    );
    expect(restored.getFounderProfile(replacementProfile.snapshotId)?.value).toEqual(
      replacementProfile,
    );
    const restoredHistoricalReplayAfterReplacement = {
      ...structuredClone(replacedSnapshot),
      transitionKeys: replacedSnapshot.transitionKeys.map(([key, replay]) =>
        key === preWithdrawalNestedDraft[0]
          ? ([key, preWithdrawalNestedDraft[1]] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(restoredHistoricalReplayAfterReplacement)).toThrow(
      /transition replay is at or before founder-snapshot withdrawal/,
    );
    const nonCanonicalConfirmedStateData = {
      confirmedSnapshotId: replacementProfile.snapshotId,
      nestedProfile: withdrawnProfile,
    };
    const restoredConfirmedStateData = {
      ...structuredClone(replacedSnapshot),
      runs: replacedSnapshot.runs.map(([setupRunId, record]) =>
        setupRunId === prepared.setupRunId
          ? ([
              setupRunId,
              {
                ...record,
                value: { ...record.value, stateData: nonCanonicalConfirmedStateData },
              },
            ] as const)
          : ([setupRunId, record] as const),
      ),
      transitionKeys: replacedSnapshot.transitionKeys.map(([key, replay]) =>
        replay.status === "replayable" &&
        replay.run.setupRunId === prepared.setupRunId &&
        replay.run.version === 7
          ? ([
              key,
              { ...replay, run: { ...replay.run, stateData: nonCanonicalConfirmedStateData } },
            ] as const)
          : ([key, replay] as const),
      ),
      confirmationKeys: replacedSnapshot.confirmationKeys.map(([key, replay]) =>
        replay.status === "replayable" && replay.result.run.setupRunId === prepared.setupRunId
          ? ([
              key,
              {
                ...replay,
                result: {
                  ...replay.result,
                  run: { ...replay.result.run, stateData: nonCanonicalConfirmedStateData },
                },
              },
            ] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(restoredConfirmedStateData)).toThrow(
      /confirmed (setup run|transition replay) contains non-canonical state data/,
    );
    restored.transitionSetupRun({
      setupRunId: prepared.setupRunId,
      expectedVersion: 7,
      targetState: "REVISION_DRAFT",
      idempotencyKey: "post-replacement-revision",
      stateData: { draftStatus: "clean" },
    });
    const postReplacementRevisionSnapshot = restored.exportSnapshot();
    const historicalConfirmedTransitionState = {
      ...structuredClone(postReplacementRevisionSnapshot),
      transitionKeys: postReplacementRevisionSnapshot.transitionKeys.map(([key, replay]) =>
        replay.status === "replayable" &&
        replay.run.setupRunId === prepared.setupRunId &&
        replay.run.state === "CONFIRMED"
          ? ([
              key,
              { ...replay, run: { ...replay.run, stateData: nonCanonicalConfirmedStateData } },
            ] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(historicalConfirmedTransitionState)).toThrow(
      /confirmed transition replay contains non-canonical state data/,
    );
    const historicalConfirmedConfirmationState = {
      ...structuredClone(postReplacementRevisionSnapshot),
      confirmationKeys: postReplacementRevisionSnapshot.confirmationKeys.map(([key, replay]) =>
        replay.status === "replayable" && replay.result.run.setupRunId === prepared.setupRunId
          ? ([
              key,
              {
                ...replay,
                result: {
                  ...replay.result,
                  run: { ...replay.result.run, stateData: nonCanonicalConfirmedStateData },
                },
              },
            ] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(historicalConfirmedConfirmationState)).toThrow(
      /confirmation idempotency key references missing confirmed state/,
    );
    expect(() => restored.confirmFounderProfile(confirmationInput)).toThrow(
      /snapshot ID was withdrawn/,
    );
    const restarted = makeStore();
    restarted.restoreSnapshot(replacedSnapshot);
    expect(restarted.getFounderProfile(replacementProfile.snapshotId)?.value).toEqual(
      replacementProfile,
    );
  });

  it("rejects restored state data at a DELETION_REQUESTED withdrawal checkpoint", () => {
    const store = makeStore();
    const prepared = prepareConfirmation(store, {
      setupRunId: "setup-deletion-state-withdrawal",
      founderId: "founder-deletion-state-withdrawal",
      evidenceId: "evidence-deletion-state-withdrawal",
    });
    const profile = {
      ...prepared.profile,
      displayName: "DELETION-WITHDRAWAL-NESTED-PROFILE",
    };
    store.confirmFounderProfile({
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "confirm-before-deletion-state-withdrawal",
      profile,
      isSynthetic: true,
    });
    store.transitionSetupRun({
      setupRunId: prepared.setupRunId,
      expectedVersion: 4,
      targetState: "DELETION_REQUESTED",
      idempotencyKey: "enter-deletion-requested-before-withdrawal",
      stateData: { requestStatus: "awaiting-finalization" },
    });
    store.recordConsent({
      consentId: "revoke-snapshot-in-deletion-requested",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_minimized_founder_snapshot",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-30T12:00:00.000Z",
      revokedAt: "2026-08-30T12:00:00.000Z",
    });
    const withdrawnSnapshot = store.exportSnapshot();
    expect(store.getSetupRun(prepared.setupRunId)?.value).toMatchObject({
      state: "DELETION_REQUESTED",
      version: 6,
      stateData: {},
    });
    const restoredNestedState = {
      ...structuredClone(withdrawnSnapshot),
      runs: withdrawnSnapshot.runs.map(([setupRunId, record]) =>
        setupRunId === prepared.setupRunId
          ? ([
              setupRunId,
              {
                ...record,
                value: { ...record.value, stateData: { nestedProfile: profile } },
              },
            ] as const)
          : ([setupRunId, record] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(restoredNestedState)).toThrow(
      /withdrawal checkpoint must have empty state data/,
    );
  });

  it("minimizes superseded founder history when version-history consent is absent", () => {
    const store = makeStore();
    const prepared = prepareConfirmation(store, {
      setupRunId: "setup-history-minimized",
      founderId: "founder-history-minimized",
      evidenceId: "evidence-history-minimized",
    });
    const oldProfile = {
      ...prepared.profile,
      displayName: "SUPERSEDED-PROFILE-MARKER",
    };
    const oldConfirmation = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "confirm-history-old",
      isSynthetic: true,
      profile: oldProfile,
    } as const;
    store.confirmFounderProfile(oldConfirmation);
    store.saveResearchBundle(
      buildSyntheticResearchBundle(oldProfile, [prepared.evidence]),
      "mcp_write",
      true,
    );
    const revisionTransition = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 4,
      targetState: "REVISION_DRAFT" as const,
      idempotencyKey: "history-sensitive-revision",
      stateData: { draftNote: "SUPERSEDED-STATE-MARKER" },
    };
    store.transitionSetupRun(revisionTransition);
    const currentEvidence = seedEvidence("evidence-history-current", "2026-08-30T12:00:00.000Z");
    store.putEvidence(prepared.setupRunId, currentEvidence, "mcp_write", true);
    const currentProfile = {
      ...seedProfile(prepared.founderId, "snapshot-history-current", currentEvidence.evidenceId),
      displayName: "Current Founder",
      confirmedAt: "2026-08-30T12:00:00.000Z",
    };
    const currentConfirmation = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 5,
      idempotencyKey: "confirm-history-current",
      isSynthetic: true,
      profile: currentProfile,
    } as const;
    store.confirmFounderProfile(currentConfirmation);
    store.saveResearchBundle(
      buildSyntheticResearchBundle(currentProfile, [currentEvidence]),
      "mcp_write",
      true,
    );

    expect(store.getFounderProfile(oldProfile.snapshotId)).toBeUndefined();
    expect(store.getFounderProfile(currentProfile.snapshotId)?.value).toEqual(currentProfile);
    // Evidence retention is governed by its own consent scope, independently
    // from founder version-history retention.
    expect(store.getEvidence(prepared.evidenceId)?.value).toEqual(prepared.evidence);
    expect(store.getEvidence(currentEvidence.evidenceId)?.value).toEqual(currentEvidence);
    expect(store.getLatestResearchBundle(prepared.founderId)?.value.founderProfile).toEqual(
      currentProfile,
    );

    const snapshot = store.exportSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("SUPERSEDED-PROFILE-MARKER");
    expect(serialized).not.toContain("SUPERSEDED-STATE-MARKER");
    expect(serialized).not.toContain(oldProfile.snapshotId);
    expect(
      snapshot.transitionKeys.find(([key]) => key.endsWith(":history-sensitive-revision"))?.[1],
    ).toMatchObject({ status: "history_minimized", setupRunId: prepared.setupRunId });
    expect(
      snapshot.confirmationKeys.find(([key]) => key.endsWith(":confirm-history-old"))?.[1],
    ).toMatchObject({ status: "history_minimized", setupRunId: prepared.setupRunId });
    expect(
      snapshot.transitionKeys.every(
        ([, replay]) =>
          replay.status !== "replayable" ||
          replay.run.version === currentConfirmation.expectedVersion + 1,
      ),
    ).toBe(true);

    const canonicalRun = snapshot.runs.find(
      ([setupRunId]) => setupRunId === prepared.setupRunId,
    )?.[1].value;
    if (canonicalRun === undefined) throw new Error("canonical history run missing");
    const unsafeEmptyStateReplaySnapshot = {
      ...structuredClone(snapshot),
      transitionKeys: snapshot.transitionKeys.map(([key, replay]) =>
        replay.status === "history_minimized" && key.endsWith(":interview")
          ? ([
              key,
              {
                status: "replayable" as const,
                signatureSha256: "b".repeat(64),
                run: {
                  ...canonicalRun,
                  state: "INTERVIEW" as const,
                  version: 2,
                  stateData: {},
                  updatedAt: canonicalRun.createdAt,
                },
              },
            ] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(unsafeEmptyStateReplaySnapshot)).toThrow(
      /historical transition replay/,
    );

    const futureTransitionSnapshot = {
      ...structuredClone(snapshot),
      transitionKeys: snapshot.transitionKeys.map(([key, replay]) =>
        replay.status === "replayable" && key.endsWith(":confirm-history-current")
          ? ([key, { ...replay, run: { ...replay.run, version: 999 } }] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(futureTransitionSnapshot)).toThrow(
      /future setup-run version/,
    );
    const mismatchedCurrentTransitionSnapshot = {
      ...structuredClone(snapshot),
      transitionKeys: snapshot.transitionKeys.map(([key, replay]) =>
        replay.status === "replayable" && key.endsWith(":confirm-history-current")
          ? ([
              key,
              {
                ...replay,
                run: {
                  ...replay.run,
                  version: 6,
                  stateData: { restoredSensitiveHistory: true },
                },
              },
            ] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(mismatchedCurrentTransitionSnapshot)).toThrow(
      /differs from the canonical setup run|confirmed transition replay contains non-canonical state data/,
    );
    const invalidTombstoneSnapshot = {
      ...structuredClone(snapshot),
      confirmationKeys: snapshot.confirmationKeys.map(([key, replay]) =>
        replay.status === "history_minimized"
          ? ([key, { ...replay, setupRunId: "missing-setup-run" }] as const)
          : ([key, replay] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(invalidTombstoneSnapshot)).toThrow(
      /scoped idempotency key has a different setup-run owner/,
    );

    const restored = makeStore();
    restored.restoreSnapshot(snapshot);
    expect(restored.getFounderProfile(oldProfile.snapshotId)).toBeUndefined();
    expect(restored.getFounderProfile(currentProfile.snapshotId)?.value).toEqual(currentProfile);
    expect(restored.getEvidence(prepared.evidenceId)?.value).toEqual(prepared.evidence);
    expect(restored.getEvidence(currentEvidence.evidenceId)?.value).toEqual(currentEvidence);
    expect(() => restored.transitionSetupRun(revisionTransition)).toThrow(
      /version-history consent is not active/,
    );
    expect(() => restored.confirmFounderProfile(oldConfirmation)).toThrow(
      /version-history consent is not active/,
    );
    expect(() =>
      restored.confirmFounderProfile({
        ...oldConfirmation,
        profile: { ...oldProfile, displayName: "Conflicting replay" },
      }),
    ).toThrow(/version-history consent is not active/);
    expect(restored.confirmFounderProfile(currentConfirmation)).toMatchObject({
      replayed: true,
      profile: { value: currentProfile },
    });
    expect(snapshot.historyCleanupGeneration).toBeGreaterThan(
      snapshot.historyCleanupCompletedGeneration,
    );
    restored.acknowledgeHistoryCleanup(snapshot.historyCleanupGeneration);
    expect(restored.exportSnapshot()).toMatchObject({
      historyCleanupGeneration: snapshot.historyCleanupGeneration,
      historyCleanupCompletedGeneration: snapshot.historyCleanupGeneration,
    });
    expect(() => restored.acknowledgeHistoryCleanup(snapshot.historyCleanupGeneration + 1)).toThrow(
      /has not been required/,
    );
    expect(() => restored.acknowledgeHistoryCleanup(-1)).toThrow(/nonnegative safe integer/);
  });

  it("preserves consented history, then compacts it immediately when consent is revoked", () => {
    const store = makeStore();
    const prepared = prepareConfirmation(store, {
      setupRunId: "setup-history-revoked",
      founderId: "founder-history-revoked",
      evidenceId: "evidence-history-revoked",
    });
    store.recordConsent({
      consentId: "history-active",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_founder_version_history",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-01T12:00:00.000Z",
      grantedAt: "2026-08-01T12:00:00.000Z",
    });
    const oldProfile = {
      ...prepared.profile,
      displayName: "CONSENTED-HISTORY-PROFILE",
    };
    const oldConfirmation = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "confirm-consented-history",
      isSynthetic: true,
      profile: oldProfile,
    } as const;
    store.confirmFounderProfile(oldConfirmation);
    store.transitionSetupRun({
      setupRunId: prepared.setupRunId,
      expectedVersion: 4,
      targetState: "REVISION_DRAFT",
      idempotencyKey: "consented-history-revision",
      stateData: { draftNote: "CONSENTED-HISTORY-STATE" },
    });
    const currentProfile = {
      ...prepared.profile,
      snapshotId: "snapshot-history-after-revision",
      displayName: "Current Founder",
      confirmedAt: "2026-08-30T12:00:00.000Z",
    };
    store.confirmFounderProfile({
      setupRunId: prepared.setupRunId,
      expectedVersion: 5,
      idempotencyKey: "confirm-after-history-revision",
      isSynthetic: true,
      profile: currentProfile,
    });

    const consentedSnapshot = store.exportSnapshot();
    expect(JSON.stringify(consentedSnapshot)).toContain("CONSENTED-HISTORY-PROFILE");
    expect(JSON.stringify(consentedSnapshot)).toContain("CONSENTED-HISTORY-STATE");
    const unsafeSnapshotWithoutConsent = {
      ...structuredClone(consentedSnapshot),
      consents: consentedSnapshot.consents.filter(
        ([, record]) => record.value.scope !== "retain_founder_version_history",
      ),
      consentOrder: consentedSnapshot.consentOrder.filter(
        ([consentId]) => consentId !== "history-active",
      ),
    };
    expect(() => makeStore().restoreSnapshot(unsafeSnapshotWithoutConsent)).toThrow(
      /without version-history consent retains multiple profiles/,
    );
    const duplicateConsentOrderSnapshot = {
      ...structuredClone(consentedSnapshot),
      consentOrder: consentedSnapshot.consentOrder.map(([consentId]) => [consentId, 1] as const),
    };
    expect(() => makeStore().restoreSnapshot(duplicateConsentOrderSnapshot)).toThrow(
      /Consent ordering values must be unique/,
    );
    const staleCanonicalPointerSnapshot = {
      ...structuredClone(consentedSnapshot),
      currentProfileSnapshotIds: [[prepared.setupRunId, oldProfile.snapshotId]] as const,
    };
    expect(() => makeStore().restoreSnapshot(staleCanonicalPointerSnapshot)).toThrow(
      /not the latest confirmed snapshot/,
    );
    const confirmedWithoutProfileSnapshot = {
      ...structuredClone(consentedSnapshot),
      profiles: [],
      bundles: [],
      confirmationKeys: [],
      currentProfileSnapshotIds: [],
    };
    expect(() => makeStore().restoreSnapshot(confirmedWithoutProfileSnapshot)).toThrow(
      /confirmed setup run has no current founder profile|confirmed transition replay contains non-canonical state data/,
    );
    const mismatchedConfirmedRunSnapshot = {
      ...structuredClone(consentedSnapshot),
      runs: consentedSnapshot.runs.map(([setupRunId, record]) =>
        setupRunId === prepared.setupRunId
          ? ([
              setupRunId,
              {
                ...record,
                value: {
                  ...record.value,
                  stateData: { confirmedSnapshotId: oldProfile.snapshotId },
                },
              },
            ] as const)
          : ([setupRunId, record] as const),
      ),
    };
    expect(() => makeStore().restoreSnapshot(mismatchedConfirmedRunSnapshot)).toThrow(
      /current transition replay differs|confirmation idempotency key references missing confirmed state/,
    );
    const restored = makeStore();
    restored.restoreSnapshot({
      ...structuredClone(consentedSnapshot),
      profiles: [...consentedSnapshot.profiles].reverse(),
    });
    expect(restored.getFounderProfile(oldProfile.snapshotId)?.value).toEqual(oldProfile);
    expect(restored.confirmFounderProfile(oldConfirmation)).toMatchObject({
      replayed: true,
      stage2HandoffEligible: false,
    });
    expect(() =>
      restored.saveResearchBundle(
        buildSyntheticResearchBundle(oldProfile, [prepared.evidence]),
        "mcp_write",
        true,
      ),
    ).toThrow(/current confirmed founder snapshot/);

    restored.recordConsent({
      consentId: "history-revoked",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_founder_version_history",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-31T12:00:00.000Z",
      revokedAt: "2026-08-31T12:00:00.000Z",
    });
    const minimizedSnapshot = restored.exportSnapshot();
    const minimizedSerialized = JSON.stringify(minimizedSnapshot);
    expect(minimizedSnapshot.historyCleanupGeneration).toBeGreaterThan(
      minimizedSnapshot.historyCleanupCompletedGeneration,
    );
    expect(minimizedSerialized).not.toContain("CONSENTED-HISTORY-PROFILE");
    expect(minimizedSerialized).not.toContain("CONSENTED-HISTORY-STATE");
    expect(minimizedSerialized).not.toContain(oldProfile.snapshotId);
    expect(restored.getFounderProfile(oldProfile.snapshotId)).toBeUndefined();
    expect(restored.getFounderProfile(currentProfile.snapshotId)?.value).toEqual(currentProfile);
    expect(() => restored.confirmFounderProfile(oldConfirmation)).toThrow(
      /version-history consent is not active/,
    );

    const restarted = makeStore();
    restarted.restoreSnapshot(minimizedSnapshot);
    expect(restarted.getFounderProfile(oldProfile.snapshotId)).toBeUndefined();
    expect(restarted.getFounderProfile(currentProfile.snapshotId)?.value).toEqual(currentProfile);
  });

  it("keeps confirmation independent from a later atomic bundle-save failure", () => {
    const store = makeStore();
    const prepared = prepareConfirmation(store, {
      setupRunId: "setup-atomic",
      founderId: "founder-atomic",
      evidenceId: "evidence-atomic",
    });
    const generated = buildSyntheticResearchBundle(prepared.profile, [prepared.evidence]);
    const marketEvidence = generated.evidence.find(
      ({ evidenceId }) => evidenceId !== prepared.evidenceId,
    );
    if (marketEvidence === undefined) throw new Error("synthetic market evidence missing");
    store.putEvidence(
      prepared.setupRunId,
      { ...marketEvidence, title: "Conflicting preexisting market evidence" },
      "mcp_write",
      true,
    );
    const confirmation = store.confirmFounderProfile({
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "atomic",
      isSynthetic: true,
      profile: prepared.profile,
    });
    expect(confirmation).toMatchObject({ run: { state: "CONFIRMED", version: 4 } });
    expect(store.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
    expect(() => store.saveResearchBundle(generated, "mcp_write", true)).toThrow(
      /already exists with different content/,
    );
    expect(store.getFounderProfile(prepared.profile.snapshotId)?.value).toEqual(prepared.profile);
    expect(store.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
    expect(store.getSetupRun(prepared.setupRunId)?.value).toMatchObject({
      state: "CONFIRMED",
      version: 4,
    });
    expect(
      store.exportSnapshot().transitionKeys.some(([key]) => key.endsWith(":confirm:atomic")),
    ).toBe(true);
    expect(() =>
      store.transitionSetupRun({
        setupRunId: prepared.setupRunId,
        expectedVersion: 4,
        targetState: "CONFIRMED",
        idempotencyKey: "confirm:atomic",
        stateData: { confirmedSnapshotId: prepared.profile.snapshotId },
      }),
    ).toThrow(/reserved for atomic founder-profile confirmation/);
  });

  it("fails profile publication closed when consent, state, ownership, or evidence is wrong", () => {
    const store = makeStore();
    store.createSetupRun({
      founderId: "founder-fail",
      setupRunId: "setup-fail",
      isSynthetic: true,
    });
    store.recordConsent({
      consentId: "self-report-fail",
      setupRunId: "setup-fail",
      founderId: "founder-fail",
      scope: "retain_minimized_founder_self_report",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-01T12:00:00.000Z",
      grantedAt: "2026-08-01T12:00:00.000Z",
    });
    const profile = seedProfile("founder-fail", "snapshot-fail", "evidence-fail");
    expect(() =>
      store.confirmFounderProfile({
        setupRunId: "setup-fail",
        expectedVersion: 1,
        idempotencyKey: "bad-state",
        isSynthetic: true,
        profile,
      }),
    ).toThrow(/cannot be confirmed/);

    store.transitionSetupRun({
      setupRunId: "setup-fail",
      expectedVersion: 1,
      targetState: "INTERVIEW",
      idempotencyKey: "i",
    });
    store.transitionSetupRun({
      setupRunId: "setup-fail",
      expectedVersion: 2,
      targetState: "DRAFT_REVIEW",
      idempotencyKey: "r",
    });
    expect(() =>
      store.confirmFounderProfile({
        setupRunId: "setup-fail",
        expectedVersion: 3,
        idempotencyKey: "no-consent",
        isSynthetic: true,
        profile,
      }),
    ).toThrow(/consent is required/);
    store.recordConsent({
      consentId: "retain-fail",
      setupRunId: "setup-fail",
      founderId: "founder-fail",
      scope: "retain_minimized_founder_snapshot",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-01T12:00:00.000Z",
      grantedAt: "2026-08-01T12:00:00.000Z",
    });
    expect(() =>
      store.confirmFounderProfile({
        setupRunId: "setup-fail",
        expectedVersion: 3,
        idempotencyKey: "no-evidence",
        isSynthetic: true,
        profile,
      }),
    ).toThrow(/missing from this setup run/);
    store.putEvidence("setup-fail", seedEvidence("evidence-fail"));
    expect(() =>
      store.confirmFounderProfile({
        setupRunId: "setup-fail",
        expectedVersion: 3,
        idempotencyKey: "wrong-founder",
        isSynthetic: true,
        profile: { ...profile, founderId: "someone-else" },
      }),
    ).toThrow(/does not match/);
  });

  it("requires an identical stored snapshot before a bundle can be saved", () => {
    const store = makeStore();
    seedSyntheticMockData(store);
    const bundle = store.getLatestResearchBundle("founder-synthetic-demo")?.value;
    if (bundle === undefined) throw new Error("seed bundle missing");
    const alien = {
      ...bundle,
      bundleId: "bundle-alien",
      founderProfile: { ...bundle.founderProfile, displayName: "Not identical" },
    };
    expect(() => store.saveResearchBundle(alien, "mcp_write", true)).toThrow(
      /identical stored confirmed founder snapshot/,
    );
    const conflicting = { ...bundle, warnings: ["different"] };
    expect(() => store.saveResearchBundle(conflicting, "mcp_write", true)).toThrow(
      /already exists with different content/,
    );
    const firstEvidence = bundle.evidence[0];
    if (firstEvidence === undefined) throw new Error("seed evidence missing");
    const orphanEvidence = {
      ...firstEvidence,
      evidenceId: "evidence-orphan",
      title: "Orphan evidence",
      provenance: {
        ...firstEvidence.provenance,
        sourceRecordId: "orphan-record",
      },
      rawArtifactRef: "mock://synthetic/orphan",
    };
    expect(() =>
      store.saveResearchBundle(
        { ...bundle, bundleId: "bundle-orphan", evidence: [...bundle.evidence, orphanEvidence] },
        "mcp_write",
        true,
      ),
    ).toThrow(/exactly equal the transitive set/);

    const marketEvidence = bundle.evidence.find(
      ({ evidenceId }) => evidenceId !== bundle.founderProfile.sourceEvidenceIds[0],
    );
    if (marketEvidence === undefined) throw new Error("market evidence missing");
    const inconsistentEvidenceId = "evidence-inconsistent-direct";
    const inconsistentBundle = JSON.parse(
      JSON.stringify(bundle).replaceAll(
        `"${marketEvidence.evidenceId}"`,
        `"${inconsistentEvidenceId}"`,
      ),
    ) as typeof bundle;
    inconsistentBundle.bundleId = "bundle-inconsistent-direct";
    const inconsistentEvidence = inconsistentBundle.evidence.find(
      ({ evidenceId }) => evidenceId === inconsistentEvidenceId,
    );
    if (inconsistentEvidence === undefined) throw new Error("rewritten evidence missing");
    inconsistentEvidence.provenance.collectionMethod = "user_input";
    expect(() => store.saveResearchBundle(inconsistentBundle, "mcp_write", true)).toThrow(
      /user_input evidenceType and user_input collectionMethod/,
    );
    expect(store.getEvidence(inconsistentEvidenceId)).toBeUndefined();
    expect(store.getResearchBundle(inconsistentBundle.bundleId)).toBeUndefined();

    const atomicFirstEvidenceId = "evidence-atomic-direct-first";
    const atomicConflictEvidenceId = "evidence-atomic-direct-conflict";
    const atomicBundle = JSON.parse(
      JSON.stringify(bundle).replaceAll(
        `"${marketEvidence.evidenceId}"`,
        `"${atomicFirstEvidenceId}"`,
      ),
    ) as typeof bundle;
    atomicBundle.bundleId = "bundle-atomic-direct";
    const firstInsertedEvidence = atomicBundle.evidence.find(
      ({ evidenceId }) => evidenceId === atomicFirstEvidenceId,
    );
    if (firstInsertedEvidence === undefined) throw new Error("rewritten market evidence missing");
    const desiredConflictingEvidence = {
      ...firstInsertedEvidence,
      evidenceId: atomicConflictEvidenceId,
      title: "Desired atomic bundle evidence",
      provenance: {
        ...firstInsertedEvidence.provenance,
        sourceRecordId: "atomic-direct-desired",
      },
      rawArtifactRef: "mock://synthetic/atomic-direct-desired",
    };
    atomicBundle.evidence.push(desiredConflictingEvidence);
    const atomicSignal = atomicBundle.marketSignals[0];
    if (atomicSignal === undefined) throw new Error("market signal missing");
    atomicSignal.evidenceIds.push(atomicConflictEvidenceId);
    const preexistingConflict = {
      ...desiredConflictingEvidence,
      title: "Preexisting conflicting evidence",
    };
    store.putEvidence("setup-synthetic-demo", preexistingConflict, "mcp_write", true);
    expect(() => store.saveResearchBundle(atomicBundle, "mcp_write", true)).toThrow(
      /already exists with different content/,
    );
    expect(store.getEvidence(atomicFirstEvidenceId)).toBeUndefined();
    expect(store.getEvidence(atomicConflictEvidenceId)?.value).toEqual(preexistingConflict);
    expect(store.getResearchBundle(atomicBundle.bundleId)).toBeUndefined();

    store.recordConsent({
      consentId: "research-revoked-before-direct-save",
      setupRunId: "setup-synthetic-demo",
      founderId: "founder-synthetic-demo",
      scope: "use_confirmed_founder_snapshot_for_research",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-30T12:00:00.000Z",
      revokedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(() =>
      store.saveResearchBundle({ ...bundle, bundleId: "bundle-after-revoke" }, "mcp_write", true),
    ).toThrow(/use_confirmed_founder_snapshot_for_research/);
  });

  it("deletes controllable records but keeps unresolved system obligations visible", () => {
    const store = makeStore();
    const prepared = prepareConfirmation(store, {
      setupRunId: "setup-delete",
      founderId: "founder-delete",
      evidenceId: "evidence-delete",
    });
    store.createSetupRun({
      clientRequestId: "application-create-delete",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      isSynthetic: true,
    });
    const siblingRun = store.createSetupRun({
      clientRequestId: "application-create-delete-sibling",
      setupRunId: "setup-delete-sibling",
      founderId: prepared.founderId,
      isSynthetic: true,
    });
    const confirmationInput = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "confirm-delete",
      isSynthetic: true,
      profile: prepared.profile,
    } as const;
    store.confirmFounderProfile(confirmationInput);
    store.saveResearchBundle(
      buildSyntheticResearchBundle(prepared.profile, [prepared.evidence]),
      "mcp_write",
      true,
    );
    expect(() =>
      store.requestDeletion({
        setupRunId: prepared.setupRunId,
        founderId: "wrong",
        reason: "test",
        idempotencyKey: "delete",
      }),
    ).toThrow(/does not match/);
    const deletionRecord = store.requestDeletion({
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      reason: "Synthetic test deletion",
      idempotencyKey: "delete",
    });
    const deletion = deletionRecord.value;
    expect(deletion.status).toBe("pending_expiry");
    expect(deletion.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: "in_memory_store", status: "completed" }),
        expect.objectContaining({ system: "external_providers", status: "unverifiable" }),
        expect.objectContaining({ system: "backups", status: "pending_expiry" }),
      ]),
    );
    expect(deletion.systems.find(({ system }) => system === "in_memory_store")?.reason).toContain(
      `setup run ${prepared.setupRunId}`,
    );
    expect(store.getSetupRun(prepared.setupRunId)).toBeUndefined();
    expect(store.getSetupRun(siblingRun.value.setupRunId)).toEqual(siblingRun);
    expect(
      store.createSetupRun({
        clientRequestId: "application-create-delete-sibling",
        setupRunId: siblingRun.value.setupRunId,
        founderId: prepared.founderId,
        isSynthetic: true,
      }),
    ).toEqual(siblingRun);
    expect(store.getEvidence(prepared.evidenceId)).toBeUndefined();
    expect(store.getFounderProfile(prepared.profile.snapshotId)).toBeUndefined();
    expect(store.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
    expect(store.getDeletionStatus(deletion.deletionRequestId)).toEqual(deletionRecord);
    expect(store.getDeletionStatus("missing")).toBeUndefined();
    expect(() =>
      store.createSetupRun({
        clientRequestId: "application-create-delete",
        setupRunId: prepared.setupRunId,
        founderId: prepared.founderId,
        isSynthetic: true,
      }),
    ).toThrow(/deleted setup run.*fresh clientRequestId/);
    const postDeletionCreate = store.createSetupRun({
      clientRequestId: "application-create-after-delete",
      isSynthetic: true,
    });
    expect(postDeletionCreate.value.setupRunId).not.toBe(prepared.setupRunId);
    expect(postDeletionCreate.value.founderId).not.toBe(prepared.founderId);
    expect(store.getSetupRun(prepared.setupRunId)).toBeUndefined();
    expect(
      store.requestDeletion({
        setupRunId: prepared.setupRunId,
        founderId: prepared.founderId,
        reason: "Synthetic test deletion",
        idempotencyKey: "delete",
      }),
    ).toEqual(deletionRecord);
    expect(() => store.confirmFounderProfile(confirmationInput)).toThrow(
      /snapshot ID was withdrawn/,
    );
    expect(() =>
      store.transitionSetupRun({
        setupRunId: prepared.setupRunId,
        expectedVersion: 1,
        targetState: "INTERVIEW",
        idempotencyKey: "interview",
      }),
    ).toThrow(/was not found/);
    expect(() =>
      store.requestDeletion({
        setupRunId: prepared.setupRunId,
        founderId: prepared.founderId,
        reason: "Different reason",
        idempotencyKey: "delete",
      }),
    ).toThrow(/different parameters/);
  });

  it("keeps persistent deletion pending until its durable system is finalized", () => {
    const store = makePersistentStore();
    store.createSetupRun({
      clientRequestId: "persistent-deletion-create",
      setupRunId: "setup-persistent-deletion",
      founderId: "founder-persistent-deletion",
      isSynthetic: false,
    });
    const request = {
      setupRunId: "setup-persistent-deletion",
      founderId: "founder-persistent-deletion",
      reason: "Delete this setup run",
      idempotencyKey: "persistent-deletion",
    } as const;
    const pending = store.requestDeletion(request);
    expect(pending.value.systems).toContainEqual(
      expect.objectContaining({
        system: "sqlite_store",
        status: "pending",
        reason: expect.stringContaining("setup run setup-persistent-deletion"),
      }),
    );

    const completed = store.updateDeletionSystemStatus(pending.value.deletionRequestId, {
      system: "sqlite_store",
      status: "completed",
      reason: "The committed SQLite state was compacted and verified",
      checkedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(completed.value.systems).toContainEqual(
      expect.objectContaining({ system: "sqlite_store", status: "completed" }),
    );
    expect(store.getDeletionStatus(pending.value.deletionRequestId)).toEqual(completed);
    expect(store.requestDeletion(request)).toEqual(completed);

    const restored = makePersistentStore();
    restored.restoreSnapshot(store.exportSnapshot());
    expect(restored.requestDeletion(request)).toEqual(completed);
    expect(() =>
      restored.updateDeletionSystemStatus(pending.value.deletionRequestId, {
        system: "missing_store",
        status: "completed",
        reason: "Not present",
        checkedAt: "2026-08-30T12:00:00.000Z",
      }),
    ).toThrow(/was not found on request/);
    expect(() =>
      restored.updateDeletionSystemStatus("missing-deletion", {
        system: "sqlite_store",
        status: "completed",
        reason: "Not present",
        checkedAt: "2026-08-30T12:00:00.000Z",
      }),
    ).toThrow(/was not found/);
  });
});
