import { describe, expect, it } from "vitest";

import type { EvidenceItem } from "../../src/domain/evidence.js";
import type { ConfirmedFounderProfileSnapshot } from "../../src/domain/founder-profile.js";
import { BizForgeStoreError, InMemoryBizForgeDataStore } from "../../src/mcp/data-store.js";
import { ConsentRecordSchema } from "../../src/mcp/contracts.js";
import { buildSyntheticResearchBundle, seedSyntheticMockData } from "../../src/mcp/mock-data.js";

function makeStore() {
  return new InMemoryBizForgeDataStore({ researchBundleFactory: buildSyntheticResearchBundle });
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
) {
  store.createSetupRun({ ...ids, isSynthetic: true, now: "2026-08-01T12:00:00.000Z" });
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
  store.putEvidence(ids.setupRunId, evidence, "mcp_write", true);
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
    ).toThrow(/Cannot transition/);
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

  it("publishes a synthetic profile, keeps production handoff false, and regenerates Step 2", () => {
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
      mockStep2DemoEligible: true,
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

    const generated = store.getLatestResearchBundle(prepared.founderId);
    expect(generated?.value.founderProfile).toEqual(prepared.profile);
    expect(generated?.value.opportunities[0]?.founderProfileSnapshotId).toBe(
      prepared.profile.snapshotId,
    );
    expect(generated?.isSynthetic).toBe(true);
    if (generated === undefined) throw new Error("expected generated bundle");
    expect(store.saveResearchBundle(generated.value, "mcp_write", true)).toEqual(generated);
    expect(() => store.saveResearchBundle(generated.value, "mcp_write", false)).toThrow(
      /synthetic records only/,
    );
  });

  it("uses only the newest consent event and does not synthesize research after revocation", () => {
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
      mockStep2DemoEligible: false,
      run: { state: "CONFIRMED" },
    });
    expect(researchStore.getLatestResearchBundle(research.founderId)).toBeUndefined();
  });

  it("rolls back profile, run, bundle, evidence, and idempotency state on confirmation failure", () => {
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
    expect(() =>
      store.confirmFounderProfile({
        setupRunId: prepared.setupRunId,
        expectedVersion: 3,
        idempotencyKey: "atomic",
        isSynthetic: true,
        profile: prepared.profile,
      }),
    ).toThrow(/already exists with different content/);
    expect(store.getFounderProfile(prepared.profile.snapshotId)).toBeUndefined();
    expect(store.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
    expect(store.getSetupRun(prepared.setupRunId)?.value).toMatchObject({
      state: "DRAFT_REVIEW",
      version: 3,
    });
    expect(
      store.transitionSetupRun({
        setupRunId: prepared.setupRunId,
        expectedVersion: 3,
        targetState: "CONFIRMED",
        idempotencyKey: "confirm:atomic",
        stateData: { confirmedSnapshotId: prepared.profile.snapshotId },
      }).replayed,
    ).toBe(false);
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
    const confirmationInput = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 3,
      idempotencyKey: "confirm-delete",
      isSynthetic: true,
      profile: prepared.profile,
    } as const;
    store.confirmFounderProfile(confirmationInput);
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
    expect(store.getSetupRun(prepared.setupRunId)).toBeUndefined();
    expect(store.getEvidence(prepared.evidenceId)).toBeUndefined();
    expect(store.getFounderProfile(prepared.profile.snapshotId)).toBeUndefined();
    expect(store.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
    expect(store.getDeletionStatus(deletion.deletionRequestId)).toEqual(deletionRecord);
    expect(store.getDeletionStatus("missing")).toBeUndefined();
    expect(
      store.requestDeletion({
        setupRunId: prepared.setupRunId,
        founderId: prepared.founderId,
        reason: "Synthetic test deletion",
        idempotencyKey: "delete",
      }),
    ).toEqual(deletionRecord);
    expect(() => store.confirmFounderProfile(confirmationInput)).toThrow(/was not found/);
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
});
