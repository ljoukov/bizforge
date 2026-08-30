import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { EvidenceItem } from "../../src/domain/evidence.js";
import type { ConfirmedFounderProfileSnapshot } from "../../src/domain/founder-profile.js";
import { type ResearchBundle, ResearchBundleSchema } from "../../src/domain/research-bundle.js";
import type { BizForgeStoreError } from "../../src/mcp/data-store.js";
import { canonicalContentSha256 } from "../../src/mcp/integrity.js";
import { SqliteBizForgeDataStore } from "../../src/mcp/sqlite-data-store.js";
import { buildSyntheticResearchBundle } from "../fixtures/mock-data.js";

const timestamp = "2026-08-29T12:00:00.000Z";
const temporaryDirectories: string[] = [];
const openStores = new Set<SqliteBizForgeDataStore>();

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "bizforge-sqlite-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "bizforge.sqlite");
}

function openStore(path: string): SqliteBizForgeDataStore {
  const store = new SqliteBizForgeDataStore(path);
  openStores.add(store);
  return store;
}

function closeStore(store: SqliteBizForgeDataStore): void {
  store.close();
  openStores.delete(store);
}

function founderEvidence(evidenceId: string, summary = "Alex builds operations automations.") {
  return {
    evidenceId,
    evidenceType: "user_input",
    title: "Founder competency",
    summary,
    provenance: {
      provider: "BizForge founder interview",
      collectionMethod: "user_input",
      sourceRecordId: `interview-${evidenceId}`,
      retrievedAt: timestamp,
      contentSha256: canonicalContentSha256(summary),
    },
    observedAt: timestamp,
    rawArtifactRef: `bizforge://evidence/${evidenceId}`,
    locator: { jsonPointer: "/competencies/0" },
    extraction: { method: "manual", version: "founder-interview-v1" },
    attributes: { suppliedByFounder: true },
    tags: ["founder-self-report"],
  } satisfies EvidenceItem;
}

function founderProfile(
  founderId: string,
  snapshotId: string,
  evidenceId: string,
): ConfirmedFounderProfileSnapshot {
  return {
    snapshotId,
    founderId,
    displayName: "Alex",
    competencies: [
      {
        name: "Workflow and operations automation",
        level: "working",
        yearsExperience: 5,
        evidenceIds: [evidenceId],
        confidence: { lower: 0.6, estimate: 0.75, upper: 0.85 },
      },
    ],
    businessAppetite: {
      hoursPerWeek: 15,
      capitalBudgetUsd: 2_500,
      timeToFirstRevenueDays: 45,
      teamSize: 1,
      preferredOfferTypes: ["hybrid"],
      preferredCustomerTypes: ["smb", "mid_market"],
      salesTolerance: "medium",
      riskTolerance: "medium",
      regulatoryTolerance: "low",
    },
    constraints: ["Avoid heavily regulated industries"],
    accessAdvantages: ["Relationships with operations leaders"],
    sourceEvidenceIds: [evidenceId],
    claims: { observed: [], inferred: [], assumptions: [] },
    capturedAt: timestamp,
    confirmedAt: timestamp,
  };
}

function recordRequiredConsents(
  store: SqliteBizForgeDataStore,
  setupRunId: string,
  founderId: string,
): void {
  for (const [consentId, scope] of [
    ["self-report", "retain_minimized_founder_self_report"],
    ["profile-evidence", "retain_minimized_profile_evidence"],
    ["snapshot", "retain_minimized_founder_snapshot"],
    ["research", "use_confirmed_founder_snapshot_for_research"],
  ] as const) {
    store.recordConsent({
      consentId: `${consentId}-${setupRunId}`,
      setupRunId,
      founderId,
      scope,
      status: "active",
      sourceUrls: [],
      recordedAt: timestamp,
      grantedAt: timestamp,
    });
  }
}

function prepareConfirmedFounder(store: SqliteBizForgeDataStore, suffix: string) {
  const setupRunId = `setup-${suffix}`;
  const founderId = `founder-${suffix}`;
  const evidenceId = `evidence-${suffix}`;
  const createInput = {
    founderId,
    setupRunId,
    clientRequestId: `create-${suffix}`,
    now: timestamp,
  } as const;
  store.createSetupRun(createInput);
  recordRequiredConsents(store, setupRunId, founderId);
  const evidence = founderEvidence(evidenceId);
  store.putEvidence(setupRunId, evidence);
  const interviewInput = {
    setupRunId,
    expectedVersion: 1,
    targetState: "INTERVIEW" as const,
    idempotencyKey: `interview-${suffix}`,
  };
  store.transitionSetupRun(interviewInput);
  store.transitionSetupRun({
    setupRunId,
    expectedVersion: 2,
    targetState: "DRAFT_REVIEW",
    idempotencyKey: `review-${suffix}`,
  });
  const requestedProfile = founderProfile(founderId, `snapshot-${suffix}`, evidenceId);
  const confirmationInput = {
    setupRunId,
    expectedVersion: 3,
    idempotencyKey: `confirm-${suffix}`,
    profile: requestedProfile,
  };
  const confirmation = store.confirmFounderProfile(confirmationInput);
  return {
    setupRunId,
    founderId,
    evidenceId,
    evidence,
    profile: confirmation.profile.value,
    requestedProfile,
    createInput,
    interviewInput,
    confirmationInput,
    confirmation,
  };
}

function researchBundle(
  profile: ConfirmedFounderProfileSnapshot,
  evidence: EvidenceItem,
): ResearchBundle {
  const fixture = buildSyntheticResearchBundle(profile, [evidence]);
  const preparedJson = JSON.stringify(fixture)
    .replaceAll("Synthetic", "Observed")
    .replaceAll("synthetic", "observed")
    .replaceAll("mock", "prepared")
    .replaceAll("demo-only", "research-input");
  return ResearchBundleSchema.parse(JSON.parse(preparedJson));
}

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteBizForgeDataStore", () => {
  it("requires an explicit persistent file and starts empty with real-write status", () => {
    expect(() => new SqliteBizForgeDataStore("")).toThrow(/file path/);
    expect(() => new SqliteBizForgeDataStore(":memory:")).toThrow(/file path/);

    const store = openStore(databasePath());
    expect(store.getDataStatus()).toEqual({
      dataMode: "persistent",
      storageMode: "persistent",
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
      warnings: [],
    });
    expect(store.getLatestResearchBundle()).toBeUndefined();
    expect(store.getSetupRun("not-seeded")).toBeUndefined();

    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => store.getDataStatus()).toThrow(/closed/);
  });

  it("restores real setup, evidence, an atomic confirmed snapshot, and research after restart", () => {
    const path = databasePath();
    const first = openStore(path);
    const prepared = prepareConfirmedFounder(first, "restart");
    const bundle = researchBundle(prepared.profile, prepared.evidence);
    const savedBundle = first.saveResearchBundle(bundle);
    const runBeforeRestart = first.getSetupRun(prepared.setupRunId);
    const profileBeforeRestart = first.getFounderProfile(prepared.profile.snapshotId);

    expect(prepared.confirmation).toMatchObject({
      stage2HandoffEligible: true,
      replayed: false,
      profile: {
        storageBackend: "sqlite",
        persistenceStatus: "persistent",
        source: "mcp_write",
      },
    });
    expect(savedBundle).toMatchObject({
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
      source: "mcp_write",
    });

    closeStore(first);
    const restarted = openStore(path);
    expect(restarted.getSetupRun(prepared.setupRunId)).toEqual(runBeforeRestart);
    expect(restarted.getEvidence(prepared.evidenceId)?.value).toEqual(prepared.evidence);
    expect(restarted.getFounderProfile(prepared.profile.snapshotId)).toEqual(profileBeforeRestart);
    expect(restarted.getLatestResearchBundle(prepared.founderId)).toEqual(savedBundle);
    expect(restarted.getResearchBundle(bundle.bundleId, bundle.bundleVersion)).toEqual(savedBundle);
    expect(restarted.getOpportunity(bundle.opportunities[0]?.opportunityId ?? "missing")).toEqual({
      opportunity: bundle.opportunities[0],
      bundle: savedBundle,
    });

    expect(restarted.createSetupRun(prepared.createInput)).toEqual(
      restarted.getSetupRun(prepared.setupRunId),
    );
    expect(() => restarted.transitionSetupRun(prepared.interviewInput)).toThrow(
      /version-history consent is not active/,
    );
    expect(restarted.confirmFounderProfile(prepared.confirmationInput)).toMatchObject({
      replayed: true,
      stage2HandoffEligible: true,
    });
    expect(() =>
      restarted.createSetupRun({
        ...prepared.createInput,
        founderId: "founder-idempotency-conflict",
      }),
    ).toThrow(/clientRequestId was already used/);
  });

  it("reloads under the SQLite write lock so multiple instances cannot bypass CAS", () => {
    const path = databasePath();
    const first = openStore(path);
    const second = openStore(path);
    const createInput = {
      founderId: "founder-concurrent",
      setupRunId: "setup-concurrent",
      clientRequestId: "create-concurrent",
      now: timestamp,
    } as const;
    const created = first.createSetupRun(createInput);

    expect(second.getSetupRun("setup-concurrent")).toEqual(created);
    expect(second.createSetupRun(createInput)).toEqual(created);
    first.transitionSetupRun({
      setupRunId: "setup-concurrent",
      expectedVersion: 1,
      targetState: "INTERVIEW",
      idempotencyKey: "concurrent-first",
    });
    expect(() =>
      second.transitionSetupRun({
        setupRunId: "setup-concurrent",
        expectedVersion: 1,
        targetState: "INTERVIEW",
        idempotencyKey: "concurrent-stale",
      }),
    ).toThrow(/current version is 2/);
    second.transitionSetupRun({
      setupRunId: "setup-concurrent",
      expectedVersion: 2,
      targetState: "INTERVIEW",
      idempotencyKey: "concurrent-second",
    });
    expect(first.getSetupRun("setup-concurrent")?.value.version).toBe(3);
  });

  it("persists effective consent revocation and continues enforcing the purpose gate", () => {
    const path = databasePath();
    const first = openStore(path);
    const setupRunId = "setup-revocation";
    const founderId = "founder-revocation";
    first.createSetupRun({ setupRunId, founderId, now: timestamp });
    first.recordConsent({
      consentId: "consent-active-revocation",
      setupRunId,
      founderId,
      scope: "retain_minimized_founder_self_report",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-29T12:00:00.000Z",
      grantedAt: "2026-08-29T12:00:00.000Z",
    });
    const retainedEvidence = founderEvidence("evidence-before-revocation");
    first.putEvidence(setupRunId, retainedEvidence);
    first.recordConsent({
      consentId: "consent-revoked-revocation",
      setupRunId,
      founderId,
      scope: "retain_minimized_founder_self_report",
      status: "revoked",
      sourceUrls: [],
      recordedAt: "2026-08-29T12:01:00.000Z",
      revokedAt: "2026-08-29T12:01:00.000Z",
    });

    closeStore(first);
    const restarted = openStore(path);
    expect(
      restarted.getConsent(setupRunId, "retain_minimized_founder_self_report")[0]?.value.status,
    ).toBe("revoked");
    expect(restarted.getEvidence(retainedEvidence.evidenceId)?.value).toEqual(retainedEvidence);
    expect(() =>
      restarted.putEvidence(setupRunId, founderEvidence("evidence-after-revocation")),
    ).toThrow(/Active retain_minimized_founder_self_report consent is required/);
  });

  it("keeps physical history cleanup pending behind a reader and retries it on ordinary reads", () => {
    const path = databasePath();
    const first = openStore(path);
    const setupRunId = "setup-history-cleanup";
    const founderId = "founder-history-cleanup";
    const evidenceId = "evidence-history-cleanup";
    const profileMarker = "SUPERSEDED-SQLITE-PROFILE-MARKER-71";
    const stateMarker = "SUPERSEDED-SQLITE-STATE-MARKER-84";
    first.createSetupRun({ setupRunId, founderId, now: timestamp });
    recordRequiredConsents(first, setupRunId, founderId);
    first.recordConsent({
      consentId: "history-active-sqlite",
      setupRunId,
      founderId,
      scope: "retain_founder_version_history",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-29T11:00:00.000Z",
      grantedAt: "2026-08-29T11:00:00.000Z",
    });
    const evidence = founderEvidence(evidenceId);
    first.putEvidence(setupRunId, evidence);
    first.transitionSetupRun({
      setupRunId,
      expectedVersion: 1,
      targetState: "INTERVIEW",
      idempotencyKey: "history-interview",
    });
    first.transitionSetupRun({
      setupRunId,
      expectedVersion: 2,
      targetState: "DRAFT_REVIEW",
      idempotencyKey: "history-review",
    });
    const requestedOldProfile = {
      ...founderProfile(founderId, "snapshot-history-old", evidenceId),
      displayName: profileMarker,
    };
    const oldProfile = first.confirmFounderProfile({
      setupRunId,
      expectedVersion: 3,
      idempotencyKey: "history-confirm-old",
      profile: requestedOldProfile,
    }).profile.value;
    first.transitionSetupRun({
      setupRunId,
      expectedVersion: 4,
      targetState: "REVISION_DRAFT",
      idempotencyKey: "history-revision",
      stateData: { draftNote: stateMarker },
    });
    const requestedCurrentProfile = {
      ...founderProfile(founderId, "snapshot-history-current", evidenceId),
      displayName: "Current Founder",
      confirmedAt: "2026-08-30T12:00:00.000Z",
    };
    const currentProfile = first.confirmFounderProfile({
      setupRunId,
      expectedVersion: 5,
      idempotencyKey: "history-confirm-current",
      profile: requestedCurrentProfile,
    }).profile.value;
    expect(first.getFounderProfile(oldProfile.snapshotId)?.value).toEqual(oldProfile);
    const second = openStore(path);

    let reader: DatabaseSync | undefined = new DatabaseSync(path, { timeout: 0 });
    try {
      reader.exec("PRAGMA query_only = ON; BEGIN");
      const pinned = reader
        .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
        .get() as { state_json: string };
      expect(pinned.state_json).toContain(profileMarker);
      expect(pinned.state_json).toContain(stateMarker);

      first.recordConsent({
        consentId: "history-revoked-sqlite",
        setupRunId,
        founderId,
        scope: "retain_founder_version_history",
        status: "revoked",
        sourceUrls: [],
        recordedAt: "2026-08-31T12:00:00.000Z",
        revokedAt: "2026-08-31T12:00:00.000Z",
      });

      expect(first.getFounderProfile(oldProfile.snapshotId)).toBeUndefined();
      expect(second.getFounderProfile(oldProfile.snapshotId)).toBeUndefined();
      expect(second.getFounderProfile(currentProfile.snapshotId)?.value).toEqual(currentProfile);
      const stillPinned = reader
        .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
        .get() as { state_json: string };
      expect(stillPinned.state_json).toContain(profileMarker);
      expect(stillPinned.state_json).toContain(stateMarker);
      const observer = new DatabaseSync(path, { timeout: 0 });
      try {
        const latest = observer
          .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
          .get() as { state_json: string };
        const snapshot = JSON.parse(latest.state_json) as {
          historyCleanupGeneration: number;
          historyCleanupCompletedGeneration: number;
        };
        expect(latest.state_json).not.toContain(profileMarker);
        expect(latest.state_json).not.toContain(stateMarker);
        expect(snapshot.historyCleanupGeneration).toBeGreaterThan(
          snapshot.historyCleanupCompletedGeneration,
        );
      } finally {
        observer.close();
      }
      for (const marker of [profileMarker, stateMarker]) {
        expect(
          [path, `${path}-wal`, `${path}-shm`].some(
            (candidate) =>
              existsSync(candidate) && readFileSync(candidate).includes(Buffer.from(marker)),
          ),
        ).toBe(true);
      }

      reader.exec("COMMIT");
      reader.close();
      reader = undefined;

      expect(second.getFounderProfile(currentProfile.snapshotId)?.value).toEqual(currentProfile);
      const retried = new DatabaseSync(path, { timeout: 0 });
      try {
        const latest = retried
          .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
          .get() as { state_json: string };
        const snapshot = JSON.parse(latest.state_json) as {
          historyCleanupGeneration: number;
          historyCleanupCompletedGeneration: number;
        };
        expect(snapshot.historyCleanupCompletedGeneration).toBe(snapshot.historyCleanupGeneration);
      } finally {
        retried.close();
      }
      closeStore(first);
      closeStore(second);

      const restarted = openStore(path);
      expect(restarted.getFounderProfile(oldProfile.snapshotId)).toBeUndefined();
      expect(restarted.getFounderProfile(currentProfile.snapshotId)?.value).toEqual(currentProfile);
      const verified = new DatabaseSync(path, { timeout: 0 });
      try {
        const latest = verified
          .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
          .get() as { state_json: string };
        const snapshot = JSON.parse(latest.state_json) as {
          historyCleanupGeneration: number;
          historyCleanupCompletedGeneration: number;
        };
        expect(snapshot.historyCleanupCompletedGeneration).toBe(snapshot.historyCleanupGeneration);
      } finally {
        verified.close();
      }

      closeStore(restarted);
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(candidate)) {
          const contents = readFileSync(candidate);
          expect(contents.includes(Buffer.from(profileMarker))).toBe(false);
          expect(contents.includes(Buffer.from(stateMarker))).toBe(false);
        }
      }
    } finally {
      if (reader !== undefined) {
        if (reader.isTransaction) reader.exec("ROLLBACK");
        reader.close();
      }
    }
  });

  it("withdraws a retained snapshot durably and securely removes its bytes after a pinned reader releases", () => {
    const path = databasePath();
    const first = openStore(path);
    const prepared = prepareConfirmedFounder(first, "snapshot-withdrawal");
    const sensitiveProfileMarker = "WITHDRAWN-SQLITE-PROFILE-MARKER-63";
    const requestedSnapshotIdMarker = "CALLER-SUPPLIED-SNAPSHOT-ID-MARKER-29";
    const requestedWithdrawnProfile = {
      ...prepared.profile,
      snapshotId: requestedSnapshotIdMarker,
      displayName: sensitiveProfileMarker,
      confirmedAt: "2026-08-30T11:00:00.000Z",
    };

    first.recordConsent({
      consentId: "snapshot-withdrawal-version-history",
      setupRunId: prepared.setupRunId,
      founderId: prepared.founderId,
      scope: "retain_founder_version_history",
      status: "active",
      sourceUrls: [],
      recordedAt: "2026-08-30T10:00:00.000Z",
      grantedAt: "2026-08-30T10:00:00.000Z",
    });
    first.transitionSetupRun({
      setupRunId: prepared.setupRunId,
      expectedVersion: 4,
      targetState: "REVISION_DRAFT",
      idempotencyKey: "snapshot-withdrawal-revision",
      stateData: {
        privateDraft: {
          founderProfileCopy: requestedWithdrawnProfile,
          marker: sensitiveProfileMarker,
        },
      },
    });
    const withdrawnConfirmationInput = {
      setupRunId: prepared.setupRunId,
      expectedVersion: 5,
      idempotencyKey: "snapshot-withdrawal-confirmation",
      profile: requestedWithdrawnProfile,
    };
    const withdrawnConfirmation = first.confirmFounderProfile(withdrawnConfirmationInput);
    const withdrawnProfile = withdrawnConfirmation.profile.value;
    expect(withdrawnProfile.snapshotId).toMatch(/^snapshot-/);
    expect(withdrawnProfile.snapshotId).not.toBe(requestedSnapshotIdMarker);
    const bundle = researchBundle(withdrawnProfile, prepared.evidence);
    const savedBundle = first.saveResearchBundle(bundle);
    const opportunityId = bundle.opportunities[0]?.opportunityId;
    if (opportunityId === undefined) throw new Error("expected a research opportunity");
    const second = openStore(path);

    let reader: DatabaseSync | undefined = new DatabaseSync(path, { timeout: 0 });
    try {
      reader.exec("PRAGMA query_only = ON; BEGIN");
      const pinned = reader
        .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
        .get() as { state_json: string };
      expect(pinned.state_json).toContain(sensitiveProfileMarker);

      first.recordConsent({
        consentId: "snapshot-retention-revoked-sqlite",
        setupRunId: prepared.setupRunId,
        founderId: prepared.founderId,
        scope: "retain_minimized_founder_snapshot",
        status: "revoked",
        sourceUrls: [],
        recordedAt: "2026-08-30T12:00:00.000Z",
        revokedAt: "2026-08-30T12:00:00.000Z",
      });

      expect(first.getFounderProfile(withdrawnProfile.snapshotId)).toBeUndefined();
      expect(second.getFounderProfile(withdrawnProfile.snapshotId)).toBeUndefined();
      expect(second.getResearchBundle(bundle.bundleId, bundle.bundleVersion)).toBeUndefined();
      expect(second.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
      expect(second.getOpportunity(opportunityId)).toBeUndefined();
      expect(second.getEvidence(prepared.evidenceId)?.value).toEqual(prepared.evidence);
      expect(first.getSetupRun(prepared.setupRunId)?.value).toMatchObject({
        state: "REVISION_DRAFT",
        version: 7,
        stateData: {},
      });
      expect(() => first.confirmFounderProfile(withdrawnConfirmationInput)).toThrow(
        /snapshot was withdrawn/,
      );

      const stillPinned = reader
        .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
        .get() as { state_json: string };
      expect(stillPinned.state_json).toContain(sensitiveProfileMarker);
      const observer = new DatabaseSync(path, { timeout: 0 });
      try {
        const latest = observer
          .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
          .get() as { state_json: string };
        const snapshot = JSON.parse(latest.state_json) as {
          historyCleanupGeneration: number;
          historyCleanupCompletedGeneration: number;
          withdrawnProfileSnapshotIds: string[];
          profileReplacementRequiredSetupRunIds: string[];
        };
        expect(latest.state_json).not.toContain(sensitiveProfileMarker);
        expect(latest.state_json).not.toContain(requestedSnapshotIdMarker);
        expect(snapshot.withdrawnProfileSnapshotIds).toContain(withdrawnProfile.snapshotId);
        expect(snapshot.profileReplacementRequiredSetupRunIds).toContain(prepared.setupRunId);
        expect(snapshot.historyCleanupGeneration).toBeGreaterThan(
          snapshot.historyCleanupCompletedGeneration,
        );
      } finally {
        observer.close();
      }
      for (const marker of [sensitiveProfileMarker, requestedSnapshotIdMarker]) {
        expect(
          [path, `${path}-wal`, `${path}-shm`].some(
            (candidate) =>
              existsSync(candidate) && readFileSync(candidate).includes(Buffer.from(marker)),
          ),
        ).toBe(true);
      }

      reader.exec("COMMIT");
      reader.close();
      reader = undefined;

      // Any ordinary adapter read retries the persistent cleanup obligation.
      expect(second.getEvidence(prepared.evidenceId)?.value).toEqual(prepared.evidence);
      const finalized = new DatabaseSync(path, { timeout: 0 });
      try {
        const latest = finalized
          .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
          .get() as { state_json: string };
        const snapshot = JSON.parse(latest.state_json) as {
          historyCleanupGeneration: number;
          historyCleanupCompletedGeneration: number;
        };
        expect(snapshot.historyCleanupCompletedGeneration).toBe(snapshot.historyCleanupGeneration);
      } finally {
        finalized.close();
      }

      closeStore(first);
      closeStore(second);
      const restarted = openStore(path);
      expect(restarted.getFounderProfile(withdrawnProfile.snapshotId)).toBeUndefined();
      expect(restarted.getResearchBundle(bundle.bundleId, bundle.bundleVersion)).toBeUndefined();
      expect(restarted.getLatestResearchBundle(prepared.founderId)).toBeUndefined();
      expect(restarted.getOpportunity(opportunityId)).toBeUndefined();
      expect(restarted.getEvidence(prepared.evidenceId)?.value).toEqual(prepared.evidence);
      const withdrawnRun = restarted.getSetupRun(prepared.setupRunId);
      expect(withdrawnRun?.value).toMatchObject({
        state: "REVISION_DRAFT",
        version: 7,
        stateData: {},
      });
      const blockedDraftMarker = "REVOKED-SNAPSHOT-DRAFT-BYPASS-MARKER-52";
      expect(() =>
        restarted.transitionSetupRun({
          setupRunId: prepared.setupRunId,
          expectedVersion: withdrawnRun?.value.version ?? 7,
          targetState: "REVISION_DRAFT",
          idempotencyKey: "snapshot-withdrawal-blocked-draft",
          stateData: {
            restoredDraft: {
              founderProfileCopy: requestedWithdrawnProfile,
              marker: blockedDraftMarker,
            },
          },
        }),
      ).toThrowError(
        expect.objectContaining<Partial<BizForgeStoreError>>({ code: "consent_required" }),
      );
      expect(restarted.getSetupRun(prepared.setupRunId)).toEqual(withdrawnRun);
      const afterRejectedDraft = new DatabaseSync(path, { timeout: 0 });
      try {
        const latest = afterRejectedDraft
          .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
          .get() as { state_json: string };
        expect(latest.state_json).not.toContain(blockedDraftMarker);
        expect(latest.state_json).not.toContain(requestedSnapshotIdMarker);
        expect(latest.state_json).not.toContain("snapshot-withdrawal-blocked-draft");
      } finally {
        afterRejectedDraft.close();
      }
      expect(() => restarted.confirmFounderProfile(withdrawnConfirmationInput)).toThrow(
        /snapshot was withdrawn/,
      );

      restarted.recordConsent({
        consentId: "snapshot-retention-regranted-sqlite",
        setupRunId: prepared.setupRunId,
        founderId: prepared.founderId,
        scope: "retain_minimized_founder_snapshot",
        status: "active",
        sourceUrls: [],
        recordedAt: "2026-08-31T12:00:00.000Z",
        grantedAt: "2026-08-31T12:00:00.000Z",
      });
      const requestedReplacementProfile = {
        ...founderProfile(
          prepared.founderId,
          "snapshot-after-retention-reconsent-sqlite",
          prepared.evidenceId,
        ),
        displayName: "Replacement Founder Profile",
        confirmedAt: "2026-08-31T12:00:00.000Z",
      };
      const replacementConfirmation = restarted.confirmFounderProfile({
        setupRunId: prepared.setupRunId,
        expectedVersion: withdrawnRun?.value.version ?? 7,
        idempotencyKey: "snapshot-withdrawal-replacement",
        profile: requestedReplacementProfile,
      });
      const replacementProfile = replacementConfirmation.profile.value;
      expect(replacementConfirmation).toMatchObject({
        replayed: false,
        run: { state: "CONFIRMED", version: 8 },
        profile: {
          value: {
            displayName: requestedReplacementProfile.displayName,
            founderId: prepared.founderId,
          },
        },
      });
      expect(replacementProfile.snapshotId).toMatch(/^snapshot-/);
      expect(replacementProfile.snapshotId).not.toBe(requestedReplacementProfile.snapshotId);
      expect(replacementProfile.snapshotId).not.toBe(withdrawnProfile.snapshotId);
      expect(restarted.getFounderProfile(replacementProfile.snapshotId)?.value).toEqual(
        replacementProfile,
      );
      expect(() => restarted.confirmFounderProfile(withdrawnConfirmationInput)).toThrow(
        /snapshot was withdrawn/,
      );

      closeStore(restarted);
      const persisted = new DatabaseSync(path, { timeout: 0 });
      try {
        const latest = persisted
          .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
          .get() as { state_json: string };
        const snapshot = JSON.parse(latest.state_json) as {
          withdrawnProfileSnapshotIds: string[];
          profileReplacementRequiredSetupRunIds: string[];
        };
        expect(snapshot.withdrawnProfileSnapshotIds).toContain(withdrawnProfile.snapshotId);
        expect(snapshot.profileReplacementRequiredSetupRunIds).not.toContain(prepared.setupRunId);
      } finally {
        persisted.close();
      }
      for (const marker of [sensitiveProfileMarker, requestedSnapshotIdMarker]) {
        for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
          if (existsSync(candidate)) {
            expect(readFileSync(candidate).includes(Buffer.from(marker))).toBe(false);
          }
        }
      }
      expect(savedBundle.value.founderProfile.displayName).toBe(sensitiveProfileMarker);
    } finally {
      if (reader !== undefined) {
        if (reader.isTransaction) reader.exec("ROLLBACK");
        reader.close();
      }
    }
  });

  it("persists deletion receipts and idempotency while purging founder state", () => {
    const path = databasePath();
    const first = openStore(path);
    const sensitiveMarker = "UNIQUE-FOUNDER-MARKER-DELETE-42";
    const setupRunId = "setup-delete";
    const founderId = "founder-delete";
    const createInput = {
      setupRunId,
      founderId,
      clientRequestId: "create-delete",
      now: timestamp,
    } as const;
    first.createSetupRun(createInput);
    first.recordConsent({
      consentId: "consent-delete",
      setupRunId,
      founderId,
      scope: "retain_minimized_founder_self_report",
      status: "active",
      sourceUrls: [],
      recordedAt: timestamp,
      grantedAt: timestamp,
    });
    const evidence = founderEvidence("evidence-delete", sensitiveMarker);
    first.putEvidence(setupRunId, evidence);
    const deletionInput = {
      setupRunId,
      founderId,
      reason: "Founder requested erasure",
      idempotencyKey: "delete-once",
    } as const;
    const deleted = first.requestDeletion(deletionInput);

    expect(deleted).toMatchObject({
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
      source: "mcp_write",
      value: {
        setupRunId,
        status: "pending_expiry",
      },
    });
    expect(deleted.value.systems).toContainEqual(
      expect.objectContaining({ system: "sqlite_store", status: "completed" }),
    );
    expect(first.getSetupRun(setupRunId)).toBeUndefined();
    expect(first.getEvidence(evidence.evidenceId)).toBeUndefined();
    expect(first.getDeletionStatus(deleted.value.deletionRequestId)).toEqual(deleted);

    closeStore(first);
    const restarted = openStore(path);
    expect(restarted.getSetupRun(setupRunId)).toBeUndefined();
    expect(restarted.getEvidence(evidence.evidenceId)).toBeUndefined();
    expect(restarted.getDeletionStatus(deleted.value.deletionRequestId)).toEqual(deleted);
    expect(restarted.requestDeletion(deletionInput)).toEqual(deleted);
    expect(() =>
      restarted.requestDeletion({ ...deletionInput, reason: "Different request" }),
    ).toThrow(/idempotency key/);
    expect(() => restarted.createSetupRun(createInput)).toThrowError(
      expect.objectContaining<Partial<BizForgeStoreError>>({ code: "setup_creation_deleted" }),
    );
    expect(() =>
      restarted.createSetupRun({
        setupRunId,
        founderId,
        clientRequestId: "fresh-key-must-not-resurrect",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<BizForgeStoreError>>({ code: "setup_run_deleted" }),
    );

    closeStore(restarted);
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) {
        expect(readFileSync(candidate).includes(Buffer.from(sensitiveMarker))).toBe(false);
      }
    }
  });

  it("keeps SQLite cleanup pending behind a reader and finalizes it after restart", () => {
    const path = databasePath();
    const first = openStore(path);
    const sensitiveMarker = "PINNED-READER-FOUNDER-MARKER-93";
    const setupRunId = "setup-pinned-reader";
    const founderId = "founder-pinned-reader";
    first.createSetupRun({ setupRunId, founderId, now: timestamp });
    first.recordConsent({
      consentId: "consent-pinned-reader",
      setupRunId,
      founderId,
      scope: "retain_minimized_founder_self_report",
      status: "active",
      sourceUrls: [],
      recordedAt: timestamp,
      grantedAt: timestamp,
    });
    const evidence = founderEvidence("evidence-pinned-reader", sensitiveMarker);
    first.putEvidence(setupRunId, evidence);
    const second = openStore(path);

    let reader: DatabaseSync | undefined = new DatabaseSync(path, { timeout: 0 });
    try {
      reader.exec("PRAGMA query_only = ON; BEGIN");
      const pinned = reader
        .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
        .get() as { state_json: string };
      expect(pinned.state_json).toContain(sensitiveMarker);

      const deletionInput = {
        setupRunId,
        founderId,
        reason: "Founder requested erasure while a reader was active",
        idempotencyKey: "delete-pinned-reader",
      } as const;
      const pending = first.requestDeletion(deletionInput);
      expect(pending.value.systems).toContainEqual(
        expect.objectContaining({ system: "sqlite_store", status: "pending" }),
      );
      expect(first.getSetupRun(setupRunId)).toBeUndefined();
      expect(first.getEvidence(evidence.evidenceId)).toBeUndefined();
      expect(second.getEvidence(evidence.evidenceId)).toBeUndefined();
      expect(
        second.getDeletionStatus(pending.value.deletionRequestId)?.value.systems,
      ).toContainEqual(expect.objectContaining({ system: "sqlite_store", status: "pending" }));
      expect(readFileSync(`${path}-wal`).includes(Buffer.from(sensitiveMarker))).toBe(true);

      reader.exec("COMMIT");
      reader.close();
      reader = undefined;
      const completedBySecond = second.getDeletionStatus(pending.value.deletionRequestId);
      expect(completedBySecond?.value.systems).toContainEqual(
        expect.objectContaining({ system: "sqlite_store", status: "completed" }),
      );
      expect(first.getDeletionStatus(pending.value.deletionRequestId)).toEqual(completedBySecond);
      closeStore(first);
      closeStore(second);

      const restarted = openStore(path);
      const completed = restarted.getDeletionStatus(pending.value.deletionRequestId);
      expect(completed).toMatchObject({
        value: {
          deletionRequestId: pending.value.deletionRequestId,
          requestedAt: pending.value.requestedAt,
          systems: expect.arrayContaining([
            expect.objectContaining({ system: "sqlite_store", status: "completed" }),
          ]),
        },
      });
      expect(completed).toEqual(completedBySecond);
      expect(restarted.requestDeletion(deletionInput)).toEqual(completed);
      expect(restarted.getSetupRun(setupRunId)).toBeUndefined();
      expect(restarted.getEvidence(evidence.evidenceId)).toBeUndefined();

      closeStore(restarted);
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(candidate)) {
          expect(readFileSync(candidate).includes(Buffer.from(sensitiveMarker))).toBe(false);
        }
      }
    } finally {
      if (reader !== undefined) {
        if (reader.isTransaction) reader.exec("ROLLBACK");
        reader.close();
      }
    }
  });

  it("rejects an invalid mutation before committing an unreadable snapshot", () => {
    const path = databasePath();
    const first = openStore(path);
    const setupRunId = "setup-invalid-mutation";
    const founderId = "founder-invalid-mutation";
    first.createSetupRun({ setupRunId, founderId, now: timestamp });
    first.recordConsent({
      consentId: "consent-invalid-mutation",
      setupRunId,
      founderId,
      scope: "retain_minimized_founder_self_report",
      status: "active",
      sourceUrls: [],
      recordedAt: timestamp,
      grantedAt: timestamp,
    });
    const validEvidence = founderEvidence("evidence-before-invalid-mutation");
    first.putEvidence(setupRunId, validEvidence);
    const malformedEvidence = {
      ...founderEvidence("evidence-invalid-mutation"),
      summary: 42,
    } as unknown as EvidenceItem;

    expect(() => first.putEvidence(setupRunId, malformedEvidence)).toThrow();
    expect(first.getEvidence(malformedEvidence.evidenceId)).toBeUndefined();
    expect(first.getEvidence(validEvidence.evidenceId)?.value).toEqual(validEvidence);

    closeStore(first);
    const restarted = openStore(path);
    expect(restarted.getEvidence(malformedEvidence.evidenceId)).toBeUndefined();
    expect(restarted.getEvidence(validEvidence.evidenceId)?.value).toEqual(validEvidence);
  });

  it("creates private storage and refuses corrupted, invalid, or future-version state", () => {
    const baseDirectory = mkdtempSync(join(tmpdir(), "bizforge-sqlite-security-test-"));
    temporaryDirectories.push(baseDirectory);
    const privateDirectory = join(baseDirectory, "private-state");
    const path = join(privateDirectory, "bizforge.sqlite");
    const store = openStore(path);
    store.createSetupRun({
      founderId: "founder-integrity",
      setupRunId: "setup-integrity",
      now: timestamp,
    });
    closeStore(store);

    expect(statSync(privateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const corrupt = new DatabaseSync(path);
    corrupt.prepare("UPDATE bizforge_state SET state_json = state_json || ' '").run();
    corrupt.close();
    expect(() => new SqliteBizForgeDataStore(path)).toThrow(/checksum/);

    const invalidPath = join(privateDirectory, "invalid.sqlite");
    const initialized = openStore(invalidPath);
    closeStore(initialized);
    const invalid = new DatabaseSync(invalidPath);
    const invalidSnapshotJson = JSON.stringify({ schemaVersion: "1.0.0", invalid: true });
    const invalidHash = createHash("sha256").update(invalidSnapshotJson).digest("hex");
    invalid
      .prepare("UPDATE bizforge_state SET state_json = ?, state_sha256 = ?")
      .run(invalidSnapshotJson, invalidHash);
    invalid.close();
    expect(() => new SqliteBizForgeDataStore(invalidPath)).toThrow();

    const invalidJsonPath = join(privateDirectory, "invalid-json.sqlite");
    const validBeforeInvalidJson = openStore(invalidJsonPath);
    closeStore(validBeforeInvalidJson);
    const invalidJsonDatabase = new DatabaseSync(invalidJsonPath);
    const malformedJson = "{";
    invalidJsonDatabase
      .prepare("UPDATE bizforge_state SET state_json = ?, state_sha256 = ?")
      .run(malformedJson, createHash("sha256").update(malformedJson).digest("hex"));
    invalidJsonDatabase.close();
    expect(() => new SqliteBizForgeDataStore(invalidJsonPath)).toThrow(/not valid JSON/);

    const wrongOriginPath = join(privateDirectory, "wrong-origin.sqlite");
    const validBeforeWrongOrigin = openStore(wrongOriginPath);
    closeStore(validBeforeWrongOrigin);
    const wrongOriginDatabase = new DatabaseSync(wrongOriginPath);
    const stateRow = wrongOriginDatabase
      .prepare("SELECT state_json FROM bizforge_state WHERE singleton_id = 1")
      .get() as { state_json: string };
    const wrongOriginSnapshot = JSON.parse(stateRow.state_json) as {
      dataStatus: { storageBackend: string };
    };
    wrongOriginSnapshot.dataStatus.storageBackend = "different-sqlite-store";
    const wrongOriginJson = JSON.stringify(wrongOriginSnapshot);
    wrongOriginDatabase
      .prepare("UPDATE bizforge_state SET state_json = ?, state_sha256 = ?")
      .run(wrongOriginJson, createHash("sha256").update(wrongOriginJson).digest("hex"));
    wrongOriginDatabase.close();
    expect(() => new SqliteBizForgeDataStore(wrongOriginPath)).toThrow(/data status/);

    const missingRowPath = join(privateDirectory, "missing-row.sqlite");
    const validBeforeMissingRow = openStore(missingRowPath);
    closeStore(validBeforeMissingRow);
    const missingRowDatabase = new DatabaseSync(missingRowPath);
    missingRowDatabase.exec("DELETE FROM bizforge_state");
    missingRowDatabase.close();
    expect(() => new SqliteBizForgeDataStore(missingRowPath)).toThrow(/missing or malformed/);

    const futurePath = join(privateDirectory, "future.sqlite");
    const future = new DatabaseSync(futurePath);
    future.exec("PRAGMA user_version = 99");
    future.close();
    expect(() => new SqliteBizForgeDataStore(futurePath)).toThrow(/Unsupported/);
  });
});
