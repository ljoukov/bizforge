import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";
import { assertResearchBundleEvidenceValid } from "../application/validate-research-bundle.js";
import { flattenClaimSet } from "../domain/claims.js";
import { type EvidenceItem, EvidenceItemSchema } from "../domain/evidence.js";
import {
  type ConfirmedFounderProfileSnapshot,
  ConfirmedFounderProfileSnapshotSchema,
} from "../domain/founder-profile.js";
import { claimSetsInOpportunity, type OpportunityDossier } from "../domain/opportunity-dossier.js";
import { type ResearchBundle, ResearchBundleSchema } from "../domain/research-bundle.js";
import {
  type ConsentRecord,
  ConsentRecordSchema,
  type ConsentScope,
  type DataSource,
  DataSourceSchema,
  type DataStoreStatus,
  DataStoreStatusSchema,
  type DeletionRecord,
  DeletionRecordSchema,
  type DeletionSystemStatus,
  DeletionSystemStatusSchema,
  type FounderSetupRun,
  FounderSetupRunSchema,
  type FounderSetupState,
  type RecordOrigin,
  type StoredEvidenceRecord,
  type StoredFounderProfileRecord,
  type StoredRecord,
  type StoredResearchBundleRecord,
} from "./contracts.js";

export class BizForgeStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BizForgeStoreError";
    this.code = code;
  }
}

export interface TransitionSetupRunInput {
  readonly setupRunId: string;
  readonly expectedVersion: number;
  readonly targetState: FounderSetupState;
  readonly idempotencyKey: string;
  readonly stateData?: Readonly<Record<string, unknown>>;
}

export interface TransitionSetupRunResult {
  readonly run: FounderSetupRun;
  readonly replayed: boolean;
}

export interface ConfirmFounderProfileInput {
  readonly setupRunId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly profile: ConfirmedFounderProfileSnapshot;
  readonly isSynthetic: boolean;
  readonly source?: DataSource;
}

export interface ConfirmFounderProfileResult {
  readonly profile: StoredFounderProfileRecord<ConfirmedFounderProfileSnapshot>;
  readonly run: FounderSetupRun;
  readonly stage2HandoffEligible: boolean;
  readonly replayed: boolean;
}

export interface RequestDeletionInput {
  readonly setupRunId: string;
  readonly founderId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface BizForgeDataStore {
  getDataStatus(): DataStoreStatus;
  createSetupRun(input: {
    founderId?: string;
    setupRunId?: string;
    clientRequestId?: string;
    source?: DataSource;
    isSynthetic: boolean;
    now?: string;
  }): StoredRecordWithRun;
  getSetupRun(setupRunId: string): StoredRecordWithRun | undefined;
  transitionSetupRun(input: TransitionSetupRunInput): TransitionSetupRunResult;
  recordConsent(record: ConsentRecord, source?: DataSource): StoredRecordWithConsent;
  getConsent(setupRunId: string, scope?: ConsentScope): StoredRecordWithConsent[];
  putEvidence(
    setupRunId: string,
    evidence: EvidenceItem,
    source?: DataSource,
    isSynthetic?: boolean,
  ): StoredEvidenceRecord<EvidenceItem>;
  getEvidence(evidenceId: string): StoredEvidenceRecord<EvidenceItem> | undefined;
  confirmFounderProfile(input: ConfirmFounderProfileInput): ConfirmFounderProfileResult;
  getFounderProfile(
    snapshotId: string,
  ): StoredFounderProfileRecord<ConfirmedFounderProfileSnapshot> | undefined;
  saveResearchBundle(
    bundle: ResearchBundle,
    source: DataSource,
    isSynthetic: boolean,
  ): StoredResearchBundleRecord<ResearchBundle>;
  getResearchBundle(
    bundleId: string,
    version?: number,
  ): StoredResearchBundleRecord<ResearchBundle> | undefined;
  getLatestResearchBundle(
    founderId?: string,
  ): StoredResearchBundleRecord<ResearchBundle> | undefined;
  getOpportunity(opportunityId: string):
    | {
        readonly opportunity: OpportunityDossier;
        readonly bundle: StoredResearchBundleRecord<ResearchBundle>;
      }
    | undefined;
  requestDeletion(input: RequestDeletionInput): StoredRecord<DeletionRecord>;
  getDeletionStatus(deletionRequestId: string): StoredRecord<DeletionRecord> | undefined;
}

export interface StoredRecordWithRun extends RecordOrigin {
  readonly value: FounderSetupRun;
}

export interface StoredRecordWithConsent extends RecordOrigin {
  readonly value: ConsentRecord;
}

export type IdempotentTransition =
  | {
      readonly status: "replayable";
      readonly signatureSha256: string;
      readonly run: FounderSetupRun;
    }
  | {
      readonly status: "history_minimized";
      readonly setupRunId: string;
    }
  | {
      readonly status: "snapshot_withdrawn";
      readonly setupRunId: string;
      readonly withdrawnAtRunVersion: number;
    };

export type IdempotentSetupCreation =
  | {
      readonly status: "active";
      readonly signatureSha256: string;
      readonly setupRunId: string;
    }
  | {
      readonly status: "deleted";
      readonly signatureSha256: string;
    };

export type IdempotentConfirmation =
  | {
      readonly status: "replayable";
      readonly signatureSha256: string;
      readonly result: ConfirmFounderProfileResult;
    }
  | {
      readonly status: "history_minimized";
      readonly setupRunId: string;
    }
  | {
      readonly status: "snapshot_withdrawn";
      readonly setupRunId: string;
      readonly withdrawnAtRunVersion: number;
    };

export interface IdempotentDeletion {
  readonly signature: string;
  readonly record: StoredRecord<DeletionRecord>;
}

export interface BizForgeDataStoreSnapshot {
  readonly schemaVersion: "1.0.0";
  readonly dataStatus: DataStoreStatus;
  readonly runs: readonly (readonly [string, StoredRecordWithRun])[];
  readonly consents: readonly (readonly [string, StoredRecordWithConsent])[];
  readonly evidence: readonly (readonly [string, StoredEvidenceRecord<EvidenceItem>])[];
  readonly profiles: readonly (readonly [
    string,
    StoredFounderProfileRecord<ConfirmedFounderProfileSnapshot>,
  ])[];
  readonly bundles: readonly (readonly [string, StoredResearchBundleRecord<ResearchBundle>])[];
  readonly deletions: readonly (readonly [string, StoredRecord<DeletionRecord>])[];
  readonly creationKeys: readonly (readonly [string, IdempotentSetupCreation])[];
  readonly transitionKeys: readonly (readonly [string, IdempotentTransition])[];
  readonly confirmationKeys: readonly (readonly [string, IdempotentConfirmation])[];
  readonly deletionKeys: readonly (readonly [string, IdempotentDeletion])[];
  readonly consentOrder: readonly (readonly [string, number])[];
  readonly nextConsentOrder: number;
  readonly deletedSetupRunIds: readonly string[];
  readonly currentProfileSnapshotIds: readonly (readonly [string, string])[];
  readonly withdrawnProfileSnapshotIds: readonly string[];
  readonly profileReplacementRequiredSetupRunIds: readonly string[];
  readonly historyCleanupGeneration: number;
  readonly historyCleanupCompletedGeneration: number;
}

const RecordOriginSchema = DataStoreStatusSchema.extend({
  isSynthetic: z.boolean(),
  source: DataSourceSchema,
});
const StoredRunSchema = RecordOriginSchema.extend({ value: FounderSetupRunSchema });
const StoredConsentSchema = RecordOriginSchema.extend({ value: ConsentRecordSchema });
const StoredEvidenceSchema = RecordOriginSchema.extend({
  setupRunId: z.string().min(1),
  value: EvidenceItemSchema,
});
const StoredProfileSchema = RecordOriginSchema.extend({
  setupRunId: z.string().min(1),
  value: ConfirmedFounderProfileSnapshotSchema,
});
const StoredBundleSchema = RecordOriginSchema.extend({
  setupRunId: z.string().min(1),
  value: ResearchBundleSchema,
});
const StoredDeletionSchema = RecordOriginSchema.extend({ value: DeletionRecordSchema });
const ConfirmationResultSchema = z
  .object({
    profile: StoredProfileSchema,
    run: FounderSetupRunSchema,
    stage2HandoffEligible: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();

function uniqueEntryKeys(entries: readonly (readonly [string, unknown])[]): boolean {
  return new Set(entries.map(([key]) => key)).size === entries.length;
}

export const BizForgeDataStoreSnapshotSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    dataStatus: DataStoreStatusSchema,
    runs: z.array(z.tuple([z.string().min(1), StoredRunSchema])),
    consents: z.array(z.tuple([z.string().min(1), StoredConsentSchema])),
    evidence: z.array(z.tuple([z.string().min(1), StoredEvidenceSchema])),
    profiles: z.array(z.tuple([z.string().min(1), StoredProfileSchema])),
    bundles: z.array(z.tuple([z.string().min(1), StoredBundleSchema])),
    deletions: z.array(z.tuple([z.string().min(1), StoredDeletionSchema])),
    creationKeys: z.array(
      z.tuple([
        z.string().min(1),
        z.discriminatedUnion("status", [
          z
            .object({
              status: z.literal("active"),
              signatureSha256: z.string().regex(/^[a-f0-9]{64}$/),
              setupRunId: z.string().min(1),
            })
            .strict(),
          z
            .object({
              status: z.literal("deleted"),
              signatureSha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        ]),
      ]),
    ),
    transitionKeys: z.array(
      z.tuple([
        z.string().min(1),
        z.discriminatedUnion("status", [
          z
            .object({
              status: z.literal("replayable"),
              signatureSha256: z.string().regex(/^[a-f0-9]{64}$/),
              run: FounderSetupRunSchema,
            })
            .strict(),
          z
            .object({
              status: z.literal("history_minimized"),
              setupRunId: z.string().min(1),
            })
            .strict(),
          z
            .object({
              status: z.literal("snapshot_withdrawn"),
              setupRunId: z.string().min(1),
              withdrawnAtRunVersion: z.number().int().positive(),
            })
            .strict(),
        ]),
      ]),
    ),
    confirmationKeys: z.array(
      z.tuple([
        z.string().min(1),
        z.discriminatedUnion("status", [
          z
            .object({
              status: z.literal("replayable"),
              signatureSha256: z.string().regex(/^[a-f0-9]{64}$/),
              result: ConfirmationResultSchema,
            })
            .strict(),
          z
            .object({
              status: z.literal("history_minimized"),
              setupRunId: z.string().min(1),
            })
            .strict(),
          z
            .object({
              status: z.literal("snapshot_withdrawn"),
              setupRunId: z.string().min(1),
              withdrawnAtRunVersion: z.number().int().positive(),
            })
            .strict(),
        ]),
      ]),
    ),
    deletionKeys: z.array(
      z.tuple([
        z.string().min(1),
        z.object({ signature: z.string(), record: StoredDeletionSchema }).strict(),
      ]),
    ),
    consentOrder: z.array(z.tuple([z.string().min(1), z.number().int().positive()])),
    nextConsentOrder: z.number().int().positive(),
    deletedSetupRunIds: z
      .array(z.string().min(1))
      .refine((ids) => new Set(ids).size === ids.length),
    currentProfileSnapshotIds: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
    withdrawnProfileSnapshotIds: z
      .array(z.string().min(1))
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
    profileReplacementRequiredSetupRunIds: z
      .array(z.string().min(1))
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
    historyCleanupGeneration: z.number().int().nonnegative(),
    historyCleanupCompletedGeneration: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    for (const [field, entries] of [
      ["runs", snapshot.runs],
      ["consents", snapshot.consents],
      ["evidence", snapshot.evidence],
      ["profiles", snapshot.profiles],
      ["bundles", snapshot.bundles],
      ["deletions", snapshot.deletions],
      ["creationKeys", snapshot.creationKeys],
      ["transitionKeys", snapshot.transitionKeys],
      ["confirmationKeys", snapshot.confirmationKeys],
      ["deletionKeys", snapshot.deletionKeys],
      ["consentOrder", snapshot.consentOrder],
      ["currentProfileSnapshotIds", snapshot.currentProfileSnapshotIds],
    ] as const) {
      if (!uniqueEntryKeys(entries)) {
        context.addIssue({ code: "custom", path: [field], message: "map keys must be unique" });
      }
    }
  });

const allowedTransitions: Readonly<Record<FounderSetupState, readonly FounderSetupState[]>> = {
  CONSENT_PENDING: ["PUBLIC_EVIDENCE", "INTERVIEW", "DELETION_REQUESTED"],
  PUBLIC_EVIDENCE: ["INTERVIEW", "DELETION_REQUESTED"],
  INTERVIEW: ["INTERVIEW", "DRAFT_REVIEW", "DELETION_REQUESTED"],
  DRAFT_REVIEW: ["DRAFT_REVIEW", "CONFIRMED", "DELETION_REQUESTED"],
  CONFIRMED: ["REVISION_DRAFT", "DELETION_REQUESTED"],
  REVISION_DRAFT: ["REVISION_DRAFT", "CONFIRMED", "DELETION_REQUESTED"],
  DELETION_REQUESTED: [],
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mockDataStatus(): DataStoreStatus {
  return {
    dataMode: "mock",
    storageMode: "mock",
    storageBackend: "memory",
    persistenceStatus: "mock_ephemeral",
    isMock: true,
    ephemeral: true,
    writePolicy: {
      requiresExplicitMockAcceptance: true,
      acceptsNonSyntheticWrites: false,
    },
    fixtureVersion: "synthetic-v1",
    warnings: [
      "Mock in-memory storage is ephemeral and all data is lost when the MCP process restarts.",
    ],
  };
}

function signature(value: unknown): string {
  return JSON.stringify(value);
}

function signatureSha256(value: unknown): string {
  return createHash("sha256").update(signature(value)).digest("hex");
}

function assertNonBlankRequestKey(
  value: string,
  kind: "idempotency key" | "clientRequestId",
): void {
  if (value.trim().length === 0) {
    throw new BizForgeStoreError(
      kind === "idempotency key" ? "invalid_idempotency_key" : "invalid_client_request_id",
      `${kind} must contain at least one non-whitespace character`,
    );
  }
}

function scopedIdempotencyKey(setupRunId: string, idempotencyKey: string): string {
  assertNonBlankRequestKey(idempotencyKey, "idempotency key");
  return `@1:${setupRunId.length}:${setupRunId}:${idempotencyKey}`;
}

function scopedIdempotencyKeyBelongsTo(key: string, setupRunId: string): boolean {
  const prefix = `@1:${setupRunId.length}:${setupRunId}:`;
  return key.startsWith(prefix) && key.slice(prefix.length).trim().length > 0;
}

function normalizeScopedIdempotencyKey(key: string, setupRunId: string): string {
  const canonicalPrefix = `@1:${setupRunId.length}:${setupRunId}:`;
  if (key.startsWith(canonicalPrefix)) {
    if (key.slice(canonicalPrefix.length).trim().length === 0) {
      invalidSnapshot("A scoped idempotency key suffix cannot be empty");
    }
    return key;
  }
  if (key.startsWith("@1:")) {
    invalidSnapshot("A scoped idempotency key has a different setup-run owner");
  }
  const legacyPrefix = `${setupRunId}:`;
  if (!key.startsWith(legacyPrefix)) {
    invalidSnapshot("A legacy idempotency key has a different setup-run owner");
  }
  const idempotencyKey = key.slice(legacyPrefix.length);
  if (idempotencyKey.trim().length === 0) {
    invalidSnapshot("A legacy idempotency key suffix cannot be empty");
  }
  return scopedIdempotencyKey(setupRunId, idempotencyKey);
}

function requireRun(
  runs: ReadonlyMap<string, StoredRecordWithRun>,
  setupRunId: string,
): StoredRecordWithRun {
  const run = runs.get(setupRunId);
  if (run === undefined) {
    throw new BizForgeStoreError("setup_run_not_found", `Setup run ${setupRunId} was not found`);
  }
  return run;
}

function assertVersion(run: FounderSetupRun, expectedVersion: number): void {
  if (run.version !== expectedVersion) {
    throw new BizForgeStoreError(
      "version_conflict",
      `Expected setup run version ${expectedVersion}, but current version is ${run.version}`,
    );
  }
}

function restoreMap<K, V>(target: Map<K, V>, snapshot: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

function restoreSet<T>(target: Set<T>, snapshot: ReadonlySet<T>): void {
  target.clear();
  for (const value of snapshot) target.add(value);
}

function referencedEvidenceIds(bundle: ResearchBundle): Set<string> {
  const ids = new Set(bundle.founderProfile.sourceEvidenceIds);
  for (const competency of bundle.founderProfile.competencies) {
    for (const evidenceId of competency.evidenceIds) ids.add(evidenceId);
  }
  for (const claim of flattenClaimSet(bundle.founderProfile.claims)) {
    for (const evidenceId of claim.evidenceIds) ids.add(evidenceId);
  }
  for (const signal of bundle.marketSignals) {
    for (const evidenceId of signal.evidenceIds) ids.add(evidenceId);
    for (const claim of flattenClaimSet(signal.claims)) {
      for (const evidenceId of claim.evidenceIds) ids.add(evidenceId);
    }
  }
  for (const opportunity of bundle.opportunities) {
    for (const evidenceId of opportunity.evidenceIds) ids.add(evidenceId);
    for (const claimSet of claimSetsInOpportunity(opportunity)) {
      for (const claim of flattenClaimSet(claimSet)) {
        for (const evidenceId of claim.evidenceIds) ids.add(evidenceId);
      }
    }
  }
  return ids;
}

function referencedFounderEvidenceIds(profile: ConfirmedFounderProfileSnapshot): Set<string> {
  const ids = new Set(profile.sourceEvidenceIds);
  for (const competency of profile.competencies) {
    for (const evidenceId of competency.evidenceIds) ids.add(evidenceId);
  }
  for (const claim of flattenClaimSet(profile.claims)) {
    for (const evidenceId of claim.evidenceIds) ids.add(evidenceId);
  }
  return ids;
}

function evidenceConsentScope(evidence: EvidenceItem): ConsentScope {
  const classifiedAsSelfReport = evidence.evidenceType === "user_input";
  const collectedAsSelfReport = evidence.provenance.collectionMethod === "user_input";
  if (classifiedAsSelfReport !== collectedAsSelfReport) {
    throw new BizForgeStoreError(
      "inconsistent_evidence_classification",
      "user_input evidenceType and user_input collectionMethod must be used together",
    );
  }
  return collectedAsSelfReport
    ? "retain_minimized_founder_self_report"
    : "retain_minimized_profile_evidence";
}

function statusFromOrigin(origin: RecordOrigin): DataStoreStatus {
  return {
    dataMode: origin.dataMode,
    storageMode: origin.storageMode,
    storageBackend: origin.storageBackend,
    persistenceStatus: origin.persistenceStatus,
    isMock: origin.isMock,
    ephemeral: origin.ephemeral,
    writePolicy: clone(origin.writePolicy),
    fixtureVersion: origin.fixtureVersion,
    warnings: clone(origin.warnings),
  };
}

function invalidSnapshot(message: string): never {
  throw new BizForgeStoreError("invalid_store_snapshot", message);
}

function normalizeSnapshotScopedKeys(
  snapshot: BizForgeDataStoreSnapshot,
): BizForgeDataStoreSnapshot {
  const normalized = {
    ...snapshot,
    transitionKeys: snapshot.transitionKeys.map(([key, transition]) => {
      const setupRunId =
        transition.status === "replayable" ? transition.run.setupRunId : transition.setupRunId;
      return [normalizeScopedIdempotencyKey(key, setupRunId), transition] as const;
    }),
    confirmationKeys: snapshot.confirmationKeys.map(([key, confirmation]) => {
      const setupRunId =
        confirmation.status === "replayable"
          ? confirmation.result.run.setupRunId
          : confirmation.setupRunId;
      return [normalizeScopedIdempotencyKey(key, setupRunId), confirmation] as const;
    }),
    deletionKeys: snapshot.deletionKeys.map(
      ([key, deletion]) =>
        [normalizeScopedIdempotencyKey(key, deletion.record.value.setupRunId), deletion] as const,
    ),
  };
  for (const [field, entries] of [
    ["transitionKeys", normalized.transitionKeys],
    ["confirmationKeys", normalized.confirmationKeys],
    ["deletionKeys", normalized.deletionKeys],
  ] as const) {
    if (!uniqueEntryKeys(entries)) {
      invalidSnapshot(`Normalized ${field} keys must be unique`);
    }
  }
  return normalized;
}

function snapshotHasActiveConsent(
  snapshot: BizForgeDataStoreSnapshot,
  setupRunId: string,
  scope: ConsentScope,
): boolean {
  const consentOrder = new Map(snapshot.consentOrder);
  const latest = snapshot.consents
    .map(([, record]) => record.value)
    .filter((consent) => consent.setupRunId === setupRunId && consent.scope === scope)
    .sort((left, right) => {
      const timeDifference = Date.parse(right.recordedAt) - Date.parse(left.recordedAt);
      return timeDifference !== 0
        ? timeDifference
        : (consentOrder.get(right.consentId) ?? 0) - (consentOrder.get(left.consentId) ?? 0);
    })[0];
  return latest?.status === "active";
}

function assertSnapshotInvariants(
  snapshot: BizForgeDataStoreSnapshot,
  expectedStatus: DataStoreStatus,
): void {
  if (signature(snapshot.dataStatus) !== signature(expectedStatus)) {
    invalidSnapshot("Snapshot data status does not match the active store configuration");
  }

  const runs = new Map(snapshot.runs);
  const evidence = new Map(snapshot.evidence);
  const profiles = new Map(snapshot.profiles);
  const deletions = new Map(snapshot.deletions);
  const currentProfileSnapshotIds = new Map(snapshot.currentProfileSnapshotIds);
  const deletedSetupRunIds = new Set(snapshot.deletedSetupRunIds);
  const withdrawnProfileSnapshotIds = new Set(snapshot.withdrawnProfileSnapshotIds);
  const profileReplacementRequiredSetupRunIds = new Set(
    snapshot.profileReplacementRequiredSetupRunIds,
  );
  const snapshotWithdrawalCutoffs = new Map<string, number>();
  for (const receipt of [...snapshot.transitionKeys, ...snapshot.confirmationKeys].map(
    ([, value]) => value,
  )) {
    if (receipt.status !== "snapshot_withdrawn") continue;
    const run = runs.get(receipt.setupRunId);
    if (run === undefined || receipt.withdrawnAtRunVersion > run.value.version) {
      invalidSnapshot("A founder-snapshot withdrawal cutoff references an invalid setup run");
    }
    snapshotWithdrawalCutoffs.set(
      receipt.setupRunId,
      Math.max(
        snapshotWithdrawalCutoffs.get(receipt.setupRunId) ?? 0,
        receipt.withdrawnAtRunVersion,
      ),
    );
  }
  const originRecords: RecordOrigin[] = [
    ...snapshot.runs.map(([, record]) => record),
    ...snapshot.consents.map(([, record]) => record),
    ...snapshot.evidence.map(([, record]) => record),
    ...snapshot.profiles.map(([, record]) => record),
    ...snapshot.bundles.map(([, record]) => record),
    ...snapshot.deletions.map(([, record]) => record),
  ];
  for (const record of originRecords) {
    if (signature(statusFromOrigin(record)) !== signature(expectedStatus)) {
      invalidSnapshot("A stored record has origin metadata from a different data store");
    }
  }

  for (const [key, record] of snapshot.runs) {
    if (key !== record.value.setupRunId)
      invalidSnapshot("A setup run map key does not match its ID");
    if (deletedSetupRunIds.has(key)) invalidSnapshot("A deleted setup run is still active");
  }
  for (const [key, record] of snapshot.consents) {
    if (key !== record.value.consentId) invalidSnapshot("A consent map key does not match its ID");
    const run = runs.get(record.value.setupRunId);
    if (run === undefined || run.value.founderId !== record.value.founderId) {
      invalidSnapshot("A consent record is not owned by its active setup run");
    }
  }
  for (const [key, record] of snapshot.evidence) {
    if (key !== record.value.evidenceId)
      invalidSnapshot("An evidence map key does not match its ID");
    if (!runs.has(record.setupRunId)) invalidSnapshot("Evidence references a missing setup run");
  }
  for (const [key, record] of snapshot.profiles) {
    if (key !== record.value.snapshotId) invalidSnapshot("A profile map key does not match its ID");
    if (withdrawnProfileSnapshotIds.has(key)) {
      invalidSnapshot("A withdrawn founder snapshot is still retained");
    }
    const run = runs.get(record.setupRunId);
    if (run === undefined || run.value.founderId !== record.value.founderId) {
      invalidSnapshot("A founder profile is not owned by its active setup run");
    }
    for (const evidenceId of record.value.sourceEvidenceIds) {
      if (evidence.get(evidenceId)?.setupRunId !== record.setupRunId) {
        invalidSnapshot("A founder profile references evidence outside its setup run");
      }
    }
  }
  for (const [key, record] of snapshot.bundles) {
    if (key !== `${record.value.bundleId}:${record.value.bundleVersion}`) {
      invalidSnapshot("A research bundle map key does not match its identity");
    }
    const profile = profiles.get(record.value.founderProfile.snapshotId);
    if (
      profile === undefined ||
      profile.setupRunId !== record.setupRunId ||
      signature(profile.value) !== signature(record.value.founderProfile)
    ) {
      invalidSnapshot("A research bundle references a missing or different founder profile");
    }
    if (withdrawnProfileSnapshotIds.has(record.value.founderProfile.snapshotId)) {
      invalidSnapshot("A research bundle embeds a withdrawn founder snapshot");
    }
    assertResearchBundleEvidenceValid(record.value);
  }
  for (const [key, record] of snapshot.deletions) {
    if (key !== record.value.deletionRequestId) {
      invalidSnapshot("A deletion map key does not match its ID");
    }
    if (!deletedSetupRunIds.has(record.value.setupRunId)) {
      invalidSnapshot("A deletion receipt is missing its setup-run tombstone");
    }
  }
  for (const [clientRequestId, creation] of snapshot.creationKeys) {
    if (clientRequestId.trim().length === 0) {
      invalidSnapshot("A setup creation clientRequestId cannot be empty");
    }
    if (creation.status === "active") {
      if (!runs.has(creation.setupRunId) || deletedSetupRunIds.has(creation.setupRunId)) {
        invalidSnapshot("An active creation key references a missing setup run");
      }
    }
  }
  for (const [key, transition] of snapshot.transitionKeys) {
    if (transition.status !== "replayable") {
      if (
        !scopedIdempotencyKeyBelongsTo(key, transition.setupRunId) ||
        !runs.has(transition.setupRunId)
      ) {
        invalidSnapshot("A minimized transition key references a missing setup run");
      }
      continue;
    }
    const run = runs.get(transition.run.setupRunId);
    if (run === undefined || !scopedIdempotencyKeyBelongsTo(key, transition.run.setupRunId)) {
      invalidSnapshot("A transition idempotency key references a missing setup run");
    }
    if (
      typeof transition.run.stateData.confirmedSnapshotId === "string" &&
      withdrawnProfileSnapshotIds.has(transition.run.stateData.confirmedSnapshotId)
    ) {
      invalidSnapshot("A transition replay references a withdrawn founder snapshot");
    }
    if (transition.run.version > run.value.version) {
      invalidSnapshot("A transition idempotency key references a future setup-run version");
    }
    const withdrawalCutoff = snapshotWithdrawalCutoffs.get(transition.run.setupRunId);
    if (withdrawalCutoff !== undefined && transition.run.version <= withdrawalCutoff) {
      invalidSnapshot("A transition replay is at or before founder-snapshot withdrawal");
    }
    if (transition.run.state === "CONFIRMED") {
      const confirmedSnapshotId = transition.run.stateData.confirmedSnapshotId;
      const confirmedProfile =
        typeof confirmedSnapshotId === "string" ? profiles.get(confirmedSnapshotId) : undefined;
      if (
        confirmedProfile === undefined ||
        confirmedProfile.setupRunId !== transition.run.setupRunId ||
        signature(transition.run.stateData) !== signature({ confirmedSnapshotId })
      ) {
        invalidSnapshot("A confirmed transition replay contains non-canonical state data");
      }
    }
    if (
      transition.run.version === run.value.version &&
      signature(transition.run) !== signature(run.value)
    ) {
      invalidSnapshot("A current transition replay differs from the canonical setup run");
    }
  }
  for (const [key, confirmation] of snapshot.confirmationKeys) {
    if (confirmation.status !== "replayable") {
      if (
        !scopedIdempotencyKeyBelongsTo(key, confirmation.setupRunId) ||
        !runs.has(confirmation.setupRunId)
      ) {
        invalidSnapshot("A minimized confirmation key references a missing setup run");
      }
    } else {
      const { result } = confirmation;
      const canonicalProfile = profiles.get(result.profile.value.snapshotId);
      const currentRun = runs.get(result.run.setupRunId);
      if (
        !scopedIdempotencyKeyBelongsTo(key, result.run.setupRunId) ||
        canonicalProfile === undefined ||
        canonicalProfile.setupRunId !== result.run.setupRunId ||
        signature(canonicalProfile) !== signature(result.profile) ||
        currentRun === undefined ||
        result.run.version > currentRun.value.version ||
        (result.run.version === currentRun.value.version &&
          signature(result.run) !== signature(currentRun.value)) ||
        result.run.state !== "CONFIRMED" ||
        result.run.founderId !== result.profile.value.founderId ||
        signature(result.run.stateData) !==
          signature({ confirmedSnapshotId: result.profile.value.snapshotId })
      ) {
        invalidSnapshot("A confirmation idempotency key references missing confirmed state");
      }
      const withdrawalCutoff = snapshotWithdrawalCutoffs.get(result.run.setupRunId);
      if (withdrawalCutoff !== undefined && result.run.version <= withdrawalCutoff) {
        invalidSnapshot("A confirmation replay is at or before founder-snapshot withdrawal");
      }
      if (withdrawnProfileSnapshotIds.has(result.profile.value.snapshotId)) {
        invalidSnapshot("A confirmation replay contains a withdrawn founder snapshot");
      }
    }
  }
  for (const [key, deletion] of snapshot.deletionKeys) {
    if (!scopedIdempotencyKeyBelongsTo(key, deletion.record.value.setupRunId)) {
      invalidSnapshot("A deletion idempotency key has a different setup-run owner");
    }
    const canonicalRecord = deletions.get(deletion.record.value.deletionRequestId);
    if (canonicalRecord === undefined) {
      invalidSnapshot("A deletion idempotency key references a missing receipt");
    }
    if (signature(canonicalRecord) !== signature(deletion.record)) {
      invalidSnapshot("A deletion idempotency key contains a stale receipt");
    }
  }

  const consentIds = new Set(snapshot.consents.map(([consentId]) => consentId));
  const orderedConsentIds = new Set(snapshot.consentOrder.map(([consentId]) => consentId));
  if (
    consentIds.size !== orderedConsentIds.size ||
    [...consentIds].some((consentId) => !orderedConsentIds.has(consentId))
  ) {
    invalidSnapshot("Consent ordering does not exactly cover stored consent records");
  }
  const maximumConsentOrder = Math.max(0, ...snapshot.consentOrder.map(([, order]) => order));
  if (
    new Set(snapshot.consentOrder.map(([, order]) => order)).size !== snapshot.consentOrder.length
  ) {
    invalidSnapshot("Consent ordering values must be unique");
  }
  if (snapshot.nextConsentOrder <= maximumConsentOrder) {
    invalidSnapshot("The next consent order must be greater than every stored order");
  }
  if (snapshot.historyCleanupCompletedGeneration > snapshot.historyCleanupGeneration) {
    invalidSnapshot("Completed history cleanup cannot exceed the required generation");
  }

  for (const [setupRunId, snapshotId] of snapshot.currentProfileSnapshotIds) {
    if (withdrawnProfileSnapshotIds.has(snapshotId)) {
      invalidSnapshot("A current profile identity references a withdrawn founder snapshot");
    }
    const profile = profiles.get(snapshotId);
    const run = runs.get(setupRunId);
    if (profile === undefined || profile.setupRunId !== setupRunId || run === undefined) {
      invalidSnapshot("A current profile identity references missing confirmed state");
    }
    const confirmationVersions = snapshot.confirmationKeys.flatMap(([, confirmation]) =>
      confirmation.status === "replayable" && confirmation.result.run.setupRunId === setupRunId
        ? [
            {
              version: confirmation.result.run.version,
              snapshotId: confirmation.result.profile.value.snapshotId,
            },
          ]
        : [],
    );
    const latestConfirmationVersion = Math.max(
      0,
      ...confirmationVersions.map(({ version }) => version),
    );
    const latestSnapshotIds = new Set(
      confirmationVersions
        .filter(({ version }) => version === latestConfirmationVersion)
        .map((confirmation) => confirmation.snapshotId),
    );
    if (latestSnapshotIds.size !== 1 || !latestSnapshotIds.has(snapshotId)) {
      invalidSnapshot("A current profile identity is not the latest confirmed snapshot");
    }
    if (run.value.state === "CONFIRMED" && run.value.stateData.confirmedSnapshotId !== snapshotId) {
      invalidSnapshot("A confirmed setup run does not reference its current founder profile");
    }
  }
  for (const [, profile] of snapshot.profiles) {
    if (currentProfileSnapshotIds.get(profile.setupRunId) === undefined) {
      invalidSnapshot("A retained founder profile has no current profile identity");
    }
    if (
      !snapshotHasActiveConsent(snapshot, profile.setupRunId, "retain_minimized_founder_snapshot")
    ) {
      invalidSnapshot("A retained founder profile lacks active snapshot-retention consent");
    }
  }

  for (const setupRunId of profileReplacementRequiredSetupRunIds) {
    const run = runs.get(setupRunId);
    if (run === undefined || !["REVISION_DRAFT", "DELETION_REQUESTED"].includes(run.value.state)) {
      invalidSnapshot("A profile-replacement marker references an invalid setup run");
    }
    if (
      currentProfileSnapshotIds.has(setupRunId) ||
      snapshot.profiles.some(([, profile]) => profile.setupRunId === setupRunId) ||
      snapshot.bundles.some(([, bundle]) => bundle.setupRunId === setupRunId) ||
      snapshot.confirmationKeys.some(
        ([, confirmation]) =>
          confirmation.status === "replayable" && confirmation.result.run.setupRunId === setupRunId,
      )
    ) {
      invalidSnapshot("A profile-replacement run still retains confirmed founder data");
    }
    const withdrawalCutoff = snapshotWithdrawalCutoffs.get(setupRunId);
    if (withdrawalCutoff === undefined) {
      invalidSnapshot("A profile-replacement run lacks a founder-snapshot withdrawal cutoff");
    }
    if (
      !snapshotHasActiveConsent(snapshot, setupRunId, "retain_minimized_founder_snapshot") &&
      (Object.keys(run.value.stateData).length > 0 ||
        snapshot.transitionKeys.some(
          ([, transition]) =>
            transition.status === "replayable" &&
            transition.run.setupRunId === setupRunId &&
            Object.keys(transition.run.stateData).length > 0,
        ))
    ) {
      invalidSnapshot("A replacement-required run retains founder draft data without consent");
    }
  }

  for (const [setupRunId, run] of runs) {
    const hasCanonicalProfile = currentProfileSnapshotIds.has(setupRunId);
    const replacementRequired = profileReplacementRequiredSetupRunIds.has(setupRunId);
    const withdrawalCutoff = snapshotWithdrawalCutoffs.get(setupRunId);
    if (
      run.value.version === withdrawalCutoff &&
      signature(run.value.stateData) !== signature({})
    ) {
      invalidSnapshot("A founder-snapshot withdrawal checkpoint must have empty state data");
    }
    if (
      typeof run.value.stateData.confirmedSnapshotId === "string" &&
      withdrawnProfileSnapshotIds.has(run.value.stateData.confirmedSnapshotId)
    ) {
      invalidSnapshot("A setup run references a withdrawn founder snapshot");
    }
    if (run.value.state === "CONFIRMED" && (!hasCanonicalProfile || replacementRequired)) {
      invalidSnapshot("A confirmed setup run has no current founder profile");
    }
    if (
      run.value.state === "CONFIRMED" &&
      signature(run.value.stateData) !==
        signature({ confirmedSnapshotId: currentProfileSnapshotIds.get(setupRunId) })
    ) {
      invalidSnapshot("A confirmed setup run contains non-canonical state data");
    }
    if (run.value.state === "REVISION_DRAFT" && hasCanonicalProfile === replacementRequired) {
      invalidSnapshot(
        "A revision draft must retain a current profile or require a withdrawn-profile replacement",
      );
    }
    if (
      ["CONSENT_PENDING", "PUBLIC_EVIDENCE", "INTERVIEW", "DRAFT_REVIEW"].includes(
        run.value.state,
      ) &&
      (hasCanonicalProfile || replacementRequired)
    ) {
      invalidSnapshot("A pre-confirmation setup run retains confirmed founder state");
    }
  }

  for (const setupRunId of runs.keys()) {
    if (snapshotHasActiveConsent(snapshot, setupRunId, "retain_founder_version_history")) {
      continue;
    }
    const retainedProfiles = snapshot.profiles.filter(
      ([, record]) => record.setupRunId === setupRunId,
    );
    if (retainedProfiles.length > 1) {
      invalidSnapshot("A setup run without version-history consent retains multiple profiles");
    }
    if (
      retainedProfiles.length === 1 &&
      currentProfileSnapshotIds.get(setupRunId) !== retainedProfiles[0]?.[0]
    ) {
      invalidSnapshot("A minimized founder profile is not the current confirmed snapshot");
    }
    for (const [, transition] of snapshot.transitionKeys) {
      if (
        transition.status === "replayable" &&
        transition.run.setupRunId === setupRunId &&
        transition.run.version !== runs.get(setupRunId)?.value.version
      ) {
        invalidSnapshot(
          "A setup run without version-history consent retains a historical transition replay",
        );
      }
    }
  }
}

export class InMemoryBizForgeDataStore implements BizForgeDataStore {
  readonly #runs = new Map<string, StoredRecordWithRun>();
  readonly #consents = new Map<string, StoredRecordWithConsent>();
  readonly #evidence = new Map<string, StoredEvidenceRecord<EvidenceItem>>();
  readonly #profiles = new Map<
    string,
    StoredFounderProfileRecord<ConfirmedFounderProfileSnapshot>
  >();
  readonly #bundles = new Map<string, StoredResearchBundleRecord<ResearchBundle>>();
  readonly #deletions = new Map<string, StoredRecord<DeletionRecord>>();
  readonly #creationKeys = new Map<string, IdempotentSetupCreation>();
  readonly #transitionKeys = new Map<string, IdempotentTransition>();
  readonly #confirmationKeys = new Map<string, IdempotentConfirmation>();
  readonly #deletionKeys = new Map<string, IdempotentDeletion>();
  readonly #consentOrder = new Map<string, number>();
  readonly #deletedSetupRunIds = new Set<string>();
  readonly #currentProfileSnapshotIds = new Map<string, string>();
  readonly #withdrawnProfileSnapshotIds = new Set<string>();
  readonly #profileReplacementRequiredSetupRunIds = new Set<string>();
  #nextConsentOrder = 1;
  #historyCleanupGeneration = 0;
  #historyCleanupCompletedGeneration = 0;
  readonly #dataStatus: DataStoreStatus;

  constructor(options?: {
    dataStatus?: DataStoreStatus;
  }) {
    this.#dataStatus = DataStoreStatusSchema.parse(options?.dataStatus ?? mockDataStatus());
  }

  getDataStatus(): DataStoreStatus {
    return clone(this.#dataStatus);
  }

  acknowledgeHistoryCleanup(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new BizForgeStoreError(
        "invalid_history_cleanup_generation",
        "History cleanup generation must be a nonnegative safe integer",
      );
    }
    if (generation > this.#historyCleanupGeneration) {
      throw new BizForgeStoreError(
        "invalid_history_cleanup_generation",
        "History cleanup cannot acknowledge a generation that has not been required",
      );
    }
    this.#historyCleanupCompletedGeneration = Math.max(
      this.#historyCleanupCompletedGeneration,
      generation,
    );
  }

  exportSnapshot(): BizForgeDataStoreSnapshot {
    for (const setupRunId of this.#runs.keys()) {
      this.#minimizeFounderVersionHistory(setupRunId);
    }
    return clone({
      schemaVersion: "1.0.0" as const,
      dataStatus: this.#dataStatus,
      runs: [...this.#runs.entries()],
      consents: [...this.#consents.entries()],
      evidence: [...this.#evidence.entries()],
      profiles: [...this.#profiles.entries()],
      bundles: [...this.#bundles.entries()],
      deletions: [...this.#deletions.entries()],
      creationKeys: [...this.#creationKeys.entries()],
      transitionKeys: [...this.#transitionKeys.entries()],
      confirmationKeys: [...this.#confirmationKeys.entries()],
      deletionKeys: [...this.#deletionKeys.entries()],
      consentOrder: [...this.#consentOrder.entries()],
      nextConsentOrder: this.#nextConsentOrder,
      deletedSetupRunIds: [...this.#deletedSetupRunIds],
      currentProfileSnapshotIds: [...this.#currentProfileSnapshotIds.entries()],
      withdrawnProfileSnapshotIds: [...this.#withdrawnProfileSnapshotIds],
      profileReplacementRequiredSetupRunIds: [...this.#profileReplacementRequiredSetupRunIds],
      historyCleanupGeneration: this.#historyCleanupGeneration,
      historyCleanupCompletedGeneration: this.#historyCleanupCompletedGeneration,
    });
  }

  restoreSnapshot(input: unknown): void {
    const parsedSnapshot = BizForgeDataStoreSnapshotSchema.parse(
      input,
    ) as unknown as BizForgeDataStoreSnapshot;
    const snapshot = normalizeSnapshotScopedKeys(parsedSnapshot);
    assertSnapshotInvariants(snapshot, this.#dataStatus);

    restoreMap(this.#runs, new Map(snapshot.runs.map(([key, value]) => [key, clone(value)])));
    restoreMap(
      this.#consents,
      new Map(snapshot.consents.map(([key, value]) => [key, clone(value)])),
    );
    restoreMap(
      this.#evidence,
      new Map(snapshot.evidence.map(([key, value]) => [key, clone(value)])),
    );
    restoreMap(
      this.#profiles,
      new Map(snapshot.profiles.map(([key, value]) => [key, clone(value)])),
    );
    restoreMap(this.#bundles, new Map(snapshot.bundles.map(([key, value]) => [key, clone(value)])));
    restoreMap(
      this.#deletions,
      new Map(snapshot.deletions.map(([key, value]) => [key, clone(value)])),
    );
    restoreMap(
      this.#creationKeys,
      new Map(snapshot.creationKeys.map(([key, value]) => [key, clone(value)])),
    );
    restoreMap(
      this.#transitionKeys,
      new Map(snapshot.transitionKeys.map(([key, value]) => [key, clone(value)])),
    );
    restoreMap(
      this.#confirmationKeys,
      new Map(snapshot.confirmationKeys.map(([key, value]) => [key, clone(value)])),
    );
    restoreMap(
      this.#deletionKeys,
      new Map(snapshot.deletionKeys.map(([key, value]) => [key, clone(value)])),
    );
    restoreMap(this.#consentOrder, new Map(snapshot.consentOrder));
    this.#nextConsentOrder = snapshot.nextConsentOrder;
    this.#deletedSetupRunIds.clear();
    for (const setupRunId of snapshot.deletedSetupRunIds) {
      this.#deletedSetupRunIds.add(setupRunId);
    }
    restoreMap(this.#currentProfileSnapshotIds, new Map(snapshot.currentProfileSnapshotIds));
    this.#withdrawnProfileSnapshotIds.clear();
    for (const snapshotId of snapshot.withdrawnProfileSnapshotIds) {
      this.#withdrawnProfileSnapshotIds.add(snapshotId);
    }
    this.#profileReplacementRequiredSetupRunIds.clear();
    for (const setupRunId of snapshot.profileReplacementRequiredSetupRunIds) {
      this.#profileReplacementRequiredSetupRunIds.add(setupRunId);
    }
    this.#historyCleanupGeneration = snapshot.historyCleanupGeneration;
    this.#historyCleanupCompletedGeneration = snapshot.historyCleanupCompletedGeneration;
  }

  #origin(source: DataSource, isSynthetic = source === "mock_seed"): RecordOrigin {
    return { ...this.getDataStatus(), isSynthetic, source };
  }

  #assertWriteOriginSupported(isSynthetic: boolean): void {
    if (!isSynthetic && !this.getDataStatus().writePolicy.acceptsNonSyntheticWrites) {
      throw new BizForgeStoreError(
        "non_synthetic_writes_unsupported",
        "The active storage adapter accepts synthetic records only",
      );
    }
  }

  createSetupRun(input: {
    founderId?: string;
    setupRunId?: string;
    clientRequestId?: string;
    source?: DataSource;
    isSynthetic: boolean;
    now?: string;
  }): StoredRecordWithRun {
    if (input.clientRequestId !== undefined) {
      assertNonBlankRequestKey(input.clientRequestId, "clientRequestId");
    }
    const requestedSynthetic = input.isSynthetic;
    const source = input.source ?? "mcp_write";
    const requestSignatureSha256 = signatureSha256({
      founderId: input.founderId ?? null,
      setupRunId: input.setupRunId ?? null,
      source,
      isSynthetic: requestedSynthetic,
      now: input.now ?? null,
    });
    if (input.clientRequestId !== undefined) {
      const replay = this.#creationKeys.get(input.clientRequestId);
      if (replay !== undefined) {
        if (replay.status === "deleted") {
          throw new BizForgeStoreError(
            "setup_creation_deleted",
            "This clientRequestId belongs to a deleted setup run and cannot be replayed; use a fresh clientRequestId for intentional re-onboarding",
          );
        }
        if (replay.signatureSha256 !== requestSignatureSha256) {
          throw new BizForgeStoreError(
            "idempotency_conflict",
            "The setup creation clientRequestId was already used with different parameters",
          );
        }
        const replayedRun = this.#runs.get(replay.setupRunId);
        if (replayedRun === undefined) {
          throw new BizForgeStoreError(
            "setup_run_not_found",
            "The setup run for this clientRequestId no longer exists",
          );
        }
        this.#assertWriteOriginSupported(replayedRun.isSynthetic);
        return clone(replayedRun);
      }
    }

    this.#assertWriteOriginSupported(requestedSynthetic);
    const setupRunId = input.setupRunId ?? `setup-${randomUUID()}`;
    if (this.#deletedSetupRunIds.has(setupRunId)) {
      throw new BizForgeStoreError(
        "setup_run_deleted",
        "This setupRunId belongs to a deleted setup run and cannot be recreated; omit setupRunId to begin intentional re-onboarding with a new opaque ID",
      );
    }
    const existing = this.#runs.get(setupRunId);
    if (existing !== undefined) {
      if (input.founderId !== undefined && existing.value.founderId !== input.founderId) {
        throw new BizForgeStoreError(
          "setup_run_conflict",
          `Setup run ${setupRunId} already belongs to another founder`,
        );
      }
      if (existing.isSynthetic !== requestedSynthetic) {
        throw new BizForgeStoreError(
          "synthetic_origin_mismatch",
          `Setup run ${setupRunId} synthetic origin does not match the request`,
        );
      }
      if (input.clientRequestId !== undefined) {
        this.#creationKeys.set(input.clientRequestId, {
          status: "active",
          signatureSha256: requestSignatureSha256,
          setupRunId,
        });
      }
      return clone(existing);
    }

    const now = input.now ?? new Date().toISOString();
    const founderId = input.founderId ?? `founder-${randomUUID()}`;
    const value = FounderSetupRunSchema.parse({
      schemaVersion: "1.0.0",
      setupRunId,
      founderId,
      state: "CONSENT_PENDING",
      version: 1,
      stateData: {},
      createdAt: now,
      updatedAt: now,
    });
    const record = { value, ...this.#origin(source, requestedSynthetic) };
    this.#runs.set(setupRunId, record);
    if (input.clientRequestId !== undefined) {
      this.#creationKeys.set(input.clientRequestId, {
        status: "active",
        signatureSha256: requestSignatureSha256,
        setupRunId,
      });
    }
    return clone(record);
  }

  getSetupRun(setupRunId: string): StoredRecordWithRun | undefined {
    const value = this.#runs.get(setupRunId);
    return value === undefined ? undefined : clone(value);
  }

  transitionSetupRun(input: TransitionSetupRunInput): TransitionSetupRunResult {
    return this.#transitionSetupRun(input, false);
  }

  #transitionSetupRun(
    input: TransitionSetupRunInput,
    allowProfileConfirmation: boolean,
  ): TransitionSetupRunResult {
    if (input.targetState === "CONFIRMED" && !allowProfileConfirmation) {
      throw new BizForgeStoreError(
        "profile_confirmation_required",
        "CONFIRMED is reserved for atomic founder-profile confirmation",
      );
    }
    const stored = requireRun(this.#runs, input.setupRunId);
    this.#assertWriteOriginSupported(stored.isSynthetic);
    const key = scopedIdempotencyKey(input.setupRunId, input.idempotencyKey);
    const requestSignatureSha256 = signatureSha256(input);
    const replay = this.#transitionKeys.get(key);
    if (replay !== undefined) {
      if (replay.status !== "replayable") {
        const reason =
          replay.status === "snapshot_withdrawn"
            ? "founder-snapshot retention was withdrawn"
            : "founder version-history consent is not active";
        throw new BizForgeStoreError(
          "idempotency_replay_history_minimized",
          `This transition succeeded previously, but its replay payload was minimized because ${reason}`,
        );
      }
      if (replay.signatureSha256 !== requestSignatureSha256) {
        throw new BizForgeStoreError(
          "idempotency_conflict",
          "The idempotency key was already used with different transition parameters",
        );
      }
      return { run: clone(replay.run), replayed: true };
    }

    assertVersion(stored.value, input.expectedVersion);
    if (!allowedTransitions[stored.value.state].includes(input.targetState)) {
      throw new BizForgeStoreError(
        "invalid_transition",
        `Cannot transition setup run from ${stored.value.state} to ${input.targetState}`,
      );
    }

    const nextStateData = input.stateData === undefined ? stored.value.stateData : input.stateData;
    if (
      this.#profileReplacementRequiredSetupRunIds.has(input.setupRunId) &&
      !this.#hasActiveConsent(input.setupRunId, "retain_minimized_founder_snapshot") &&
      Object.keys(nextStateData).length > 0
    ) {
      throw new BizForgeStoreError(
        "consent_required",
        "Snapshot-retention consent must be active before storing replacement founder draft data",
      );
    }

    const run = FounderSetupRunSchema.parse({
      ...stored.value,
      state: input.targetState,
      version: stored.value.version + 1,
      stateData: nextStateData,
      updatedAt: new Date().toISOString(),
    });
    this.#runs.set(input.setupRunId, { ...stored, value: run });
    this.#transitionKeys.set(key, {
      status: "replayable",
      signatureSha256: requestSignatureSha256,
      run,
    });
    this.#minimizeFounderVersionHistory(input.setupRunId);
    return { run: clone(run), replayed: false };
  }

  recordConsent(record: ConsentRecord, source: DataSource = "mcp_write"): StoredRecordWithConsent {
    const parsed = ConsentRecordSchema.parse(record);
    const run = requireRun(this.#runs, parsed.setupRunId);
    this.#assertWriteOriginSupported(run.isSynthetic);
    if (run.value.founderId !== parsed.founderId) {
      throw new BizForgeStoreError(
        "founder_mismatch",
        "Consent founderId does not match the setup run founderId",
      );
    }
    const existing = this.#consents.get(parsed.consentId);
    if (existing !== undefined && signature(existing.value) !== signature(parsed)) {
      throw new BizForgeStoreError(
        "consent_conflict",
        `Consent record ${parsed.consentId} is immutable and already has different content`,
      );
    }
    const snapshotRetentionWasActive = this.#hasActiveConsent(
      parsed.setupRunId,
      "retain_minimized_founder_snapshot",
    );
    const checkpoint = {
      runs: new Map(this.#runs),
      consents: new Map(this.#consents),
      profiles: new Map(this.#profiles),
      bundles: new Map(this.#bundles),
      transitionKeys: new Map(this.#transitionKeys),
      confirmationKeys: new Map(this.#confirmationKeys),
      consentOrder: new Map(this.#consentOrder),
      currentProfileSnapshotIds: new Map(this.#currentProfileSnapshotIds),
      withdrawnProfileSnapshotIds: new Set(this.#withdrawnProfileSnapshotIds),
      profileReplacementRequiredSetupRunIds: new Set(this.#profileReplacementRequiredSetupRunIds),
      nextConsentOrder: this.#nextConsentOrder,
      historyCleanupGeneration: this.#historyCleanupGeneration,
      historyCleanupCompletedGeneration: this.#historyCleanupCompletedGeneration,
    };
    const stored = existing ?? { value: parsed, ...this.#origin(source, run.isSynthetic) };
    try {
      if (existing === undefined) {
        this.#consentOrder.set(parsed.consentId, this.#nextConsentOrder);
        this.#nextConsentOrder += 1;
      }
      this.#consents.set(parsed.consentId, stored);
      const snapshotRetentionIsActive = this.#hasActiveConsent(
        parsed.setupRunId,
        "retain_minimized_founder_snapshot",
      );
      if (snapshotRetentionWasActive && !snapshotRetentionIsActive) {
        this.#withdrawFounderSnapshots(parsed.setupRunId);
      }
      this.#minimizeFounderVersionHistory(parsed.setupRunId);
      return clone(stored);
    } catch (error) {
      restoreMap(this.#runs, checkpoint.runs);
      restoreMap(this.#consents, checkpoint.consents);
      restoreMap(this.#profiles, checkpoint.profiles);
      restoreMap(this.#bundles, checkpoint.bundles);
      restoreMap(this.#transitionKeys, checkpoint.transitionKeys);
      restoreMap(this.#confirmationKeys, checkpoint.confirmationKeys);
      restoreMap(this.#consentOrder, checkpoint.consentOrder);
      restoreMap(this.#currentProfileSnapshotIds, checkpoint.currentProfileSnapshotIds);
      restoreSet(this.#withdrawnProfileSnapshotIds, checkpoint.withdrawnProfileSnapshotIds);
      restoreSet(
        this.#profileReplacementRequiredSetupRunIds,
        checkpoint.profileReplacementRequiredSetupRunIds,
      );
      this.#nextConsentOrder = checkpoint.nextConsentOrder;
      this.#historyCleanupGeneration = checkpoint.historyCleanupGeneration;
      this.#historyCleanupCompletedGeneration = checkpoint.historyCleanupCompletedGeneration;
      throw error;
    }
  }

  getConsent(setupRunId: string, scope?: ConsentScope): StoredRecordWithConsent[] {
    requireRun(this.#runs, setupRunId);
    return [...this.#consents.values()]
      .filter(
        ({ value }) =>
          value.setupRunId === setupRunId && (scope === undefined || value.scope === scope),
      )
      .sort((left, right) => {
        const timeDifference =
          Date.parse(right.value.recordedAt) - Date.parse(left.value.recordedAt);
        return timeDifference !== 0
          ? timeDifference
          : (this.#consentOrder.get(right.value.consentId) ?? 0) -
              (this.#consentOrder.get(left.value.consentId) ?? 0);
      })
      .map(clone);
  }

  #hasActiveConsent(setupRunId: string, scope: ConsentScope): boolean {
    return this.getConsent(setupRunId, scope)[0]?.value.status === "active";
  }

  #withdrawFounderSnapshots(setupRunId: string): void {
    const runRecord = requireRun(this.#runs, setupRunId);
    const profilesToWithdraw = [...this.#profiles.entries()].filter(
      ([, profile]) => profile.setupRunId === setupRunId,
    );
    const bundlesToWithdraw = [...this.#bundles.entries()].filter(
      ([, bundle]) => bundle.setupRunId === setupRunId,
    );
    const confirmationsToWithdraw = [...this.#confirmationKeys.entries()].filter(
      ([, confirmation]) =>
        confirmation.status === "replayable" && confirmation.result.run.setupRunId === setupRunId,
    );
    const transitionsToWithdraw = [...this.#transitionKeys.entries()].filter(
      ([, transition]) =>
        transition.status === "replayable" && transition.run.setupRunId === setupRunId,
    );
    const withdrawnSnapshotIds = new Set(profilesToWithdraw.map(([snapshotId]) => snapshotId));
    const currentSnapshotId = this.#currentProfileSnapshotIds.get(setupRunId);
    if (currentSnapshotId !== undefined) withdrawnSnapshotIds.add(currentSnapshotId);
    for (const [, bundle] of bundlesToWithdraw) {
      withdrawnSnapshotIds.add(bundle.value.founderProfile.snapshotId);
    }
    for (const [, confirmation] of confirmationsToWithdraw) {
      if (confirmation.status === "replayable") {
        withdrawnSnapshotIds.add(confirmation.result.profile.value.snapshotId);
      }
    }
    const replacementDraftHistoryExists =
      this.#profileReplacementRequiredSetupRunIds.has(setupRunId) &&
      (Object.keys(runRecord.value.stateData).length > 0 ||
        transitionsToWithdraw.some(
          ([, transition]) =>
            transition.status === "replayable" && Object.keys(transition.run.stateData).length > 0,
        ));
    if (withdrawnSnapshotIds.size === 0 && !replacementDraftHistoryExists) return;
    if (!["CONFIRMED", "REVISION_DRAFT", "DELETION_REQUESTED"].includes(runRecord.value.state)) {
      throw new BizForgeStoreError(
        "invalid_snapshot_withdrawal_state",
        `Founder snapshots cannot be withdrawn while setup is ${runRecord.value.state}`,
      );
    }

    const nextCleanupGeneration = this.#historyCleanupGeneration + 1;
    const nextRunVersion = runRecord.value.version + 1;
    if (!Number.isSafeInteger(nextCleanupGeneration)) {
      throw new BizForgeStoreError(
        "history_cleanup_generation_exhausted",
        "History cleanup generation cannot be advanced safely",
      );
    }
    if (!Number.isSafeInteger(nextRunVersion)) {
      throw new BizForgeStoreError(
        "setup_run_version_exhausted",
        "The setup-run version cannot be advanced safely during snapshot withdrawal",
      );
    }

    const bundleKeysToDelete = bundlesToWithdraw.map(([key]) => key);
    const transitionKeysToMinimize = transitionsToWithdraw.map(([key]) => key);
    const confirmationKeysToMinimize = confirmationsToWithdraw.map(([key]) => key);
    const updatedRun = FounderSetupRunSchema.parse({
      ...runRecord.value,
      state:
        runRecord.value.state === "DELETION_REQUESTED" ? "DELETION_REQUESTED" : "REVISION_DRAFT",
      version: nextRunVersion,
      stateData: {},
      updatedAt: new Date().toISOString(),
    });

    for (const snapshotId of withdrawnSnapshotIds) {
      this.#profiles.delete(snapshotId);
      this.#withdrawnProfileSnapshotIds.add(snapshotId);
    }
    for (const bundleKey of bundleKeysToDelete) this.#bundles.delete(bundleKey);
    for (const key of transitionKeysToMinimize) {
      this.#transitionKeys.set(key, {
        status: "snapshot_withdrawn",
        setupRunId,
        withdrawnAtRunVersion: nextRunVersion,
      });
    }
    for (const key of confirmationKeysToMinimize) {
      this.#confirmationKeys.set(key, {
        status: "snapshot_withdrawn",
        setupRunId,
        withdrawnAtRunVersion: nextRunVersion,
      });
    }
    this.#currentProfileSnapshotIds.delete(setupRunId);
    if (updatedRun.state === "REVISION_DRAFT") {
      this.#profileReplacementRequiredSetupRunIds.add(setupRunId);
    } else {
      this.#profileReplacementRequiredSetupRunIds.delete(setupRunId);
    }
    this.#runs.set(setupRunId, { ...runRecord, value: updatedRun });
    this.#historyCleanupGeneration = nextCleanupGeneration;
  }

  #minimizeFounderVersionHistory(setupRunId: string): void {
    if (this.#hasActiveConsent(setupRunId, "retain_founder_version_history")) return;

    const profilesForRun = [...this.#profiles.entries()].filter(
      ([, record]) => record.setupRunId === setupRunId,
    );
    const retainedProfileId = this.#currentProfileSnapshotIds.get(setupRunId);
    const profileIdsToDelete = profilesForRun
      .map(([snapshotId]) => snapshotId)
      .filter((snapshotId) => snapshotId !== retainedProfileId);
    const bundleKeysToDelete = [...this.#bundles.entries()]
      .filter(
        ([, bundle]) =>
          bundle.setupRunId === setupRunId &&
          bundle.value.founderProfile.snapshotId !== retainedProfileId,
      )
      .map(([bundleKey]) => bundleKey);

    const currentRun = requireRun(this.#runs, setupRunId).value;
    const transitionKeysToMinimize = [...this.#transitionKeys.entries()]
      .filter(
        ([, transition]) =>
          transition.status === "replayable" &&
          transition.run.setupRunId === setupRunId &&
          transition.run.version !== currentRun.version,
      )
      .map(([key]) => key);
    const confirmationKeysToMinimize = [...this.#confirmationKeys.entries()]
      .filter(
        ([, confirmation]) =>
          confirmation.status === "replayable" &&
          confirmation.result.profile.setupRunId === setupRunId &&
          confirmation.result.profile.value.snapshotId !== retainedProfileId,
      )
      .map(([key]) => key);
    const discardedHistory =
      profileIdsToDelete.length > 0 ||
      bundleKeysToDelete.length > 0 ||
      transitionKeysToMinimize.length > 0 ||
      confirmationKeysToMinimize.length > 0;
    if (!discardedHistory) return;
    const nextCleanupGeneration = this.#historyCleanupGeneration + 1;
    if (!Number.isSafeInteger(nextCleanupGeneration)) {
      throw new BizForgeStoreError(
        "history_cleanup_generation_exhausted",
        "History cleanup generation cannot be advanced safely",
      );
    }

    for (const snapshotId of profileIdsToDelete) this.#profiles.delete(snapshotId);
    for (const bundleKey of bundleKeysToDelete) this.#bundles.delete(bundleKey);
    for (const key of transitionKeysToMinimize) {
      this.#transitionKeys.set(key, { status: "history_minimized", setupRunId });
    }
    for (const key of confirmationKeysToMinimize) {
      this.#confirmationKeys.set(key, { status: "history_minimized", setupRunId });
    }
    this.#historyCleanupGeneration = nextCleanupGeneration;
  }

  #confirmationEligibility(
    setupRunId: string,
    snapshotId: string,
    prospectiveCanonical = false,
  ): Pick<ConfirmFounderProfileResult, "stage2HandoffEligible"> {
    const canonicalSnapshotId = this.#currentProfileSnapshotIds.get(setupRunId);
    const isCanonical = prospectiveCanonical || canonicalSnapshotId === snapshotId;
    const downstreamConsentActive =
      this.#hasActiveConsent(setupRunId, "retain_minimized_founder_snapshot") &&
      this.#hasActiveConsent(setupRunId, "use_confirmed_founder_snapshot_for_research");
    const isMockStore = this.getDataStatus().isMock;
    return {
      stage2HandoffEligible: !isMockStore && isCanonical && downstreamConsentActive,
    };
  }

  #storeEvidence(
    setupRunId: string,
    evidence: EvidenceItem,
    source: DataSource,
    isSynthetic: boolean,
  ): StoredEvidenceRecord<EvidenceItem> {
    evidenceConsentScope(evidence);
    const existing = this.#evidence.get(evidence.evidenceId);
    if (
      existing !== undefined &&
      (existing.setupRunId !== setupRunId ||
        existing.isSynthetic !== isSynthetic ||
        signature(existing.value) !== signature(evidence))
    ) {
      throw new BizForgeStoreError(
        "evidence_conflict",
        `Evidence ${evidence.evidenceId} already exists with different content or ownership`,
      );
    }
    const stored = existing ?? {
      setupRunId,
      value: clone(evidence),
      ...this.#origin(source, isSynthetic),
    };
    this.#evidence.set(evidence.evidenceId, stored);
    return clone(stored);
  }

  putEvidence(
    setupRunId: string,
    evidence: EvidenceItem,
    source: DataSource = "mcp_write",
    isSynthetic?: boolean,
  ): StoredEvidenceRecord<EvidenceItem> {
    const run = requireRun(this.#runs, setupRunId);
    const recordIsSynthetic = isSynthetic ?? run.isSynthetic;
    this.#assertWriteOriginSupported(recordIsSynthetic);
    if (recordIsSynthetic !== run.isSynthetic) {
      throw new BizForgeStoreError(
        "synthetic_origin_mismatch",
        "Evidence synthetic origin must match its setup run",
      );
    }
    const requiredScope = evidenceConsentScope(evidence);
    if (!this.#hasActiveConsent(setupRunId, requiredScope)) {
      throw new BizForgeStoreError(
        "consent_required",
        `Active ${requiredScope} consent is required to store this evidence`,
      );
    }
    return this.#storeEvidence(setupRunId, evidence, source, recordIsSynthetic);
  }

  getEvidence(evidenceId: string): StoredEvidenceRecord<EvidenceItem> | undefined {
    const value = this.#evidence.get(evidenceId);
    return value === undefined ? undefined : clone(value);
  }

  confirmFounderProfile(input: ConfirmFounderProfileInput): ConfirmFounderProfileResult {
    this.#assertWriteOriginSupported(input.isSynthetic);
    const key = scopedIdempotencyKey(input.setupRunId, input.idempotencyKey);
    const requestedProfile = ConfirmedFounderProfileSnapshotSchema.parse(input.profile);
    if (this.#withdrawnProfileSnapshotIds.has(requestedProfile.snapshotId)) {
      throw new BizForgeStoreError(
        "founder_snapshot_withdrawn",
        "This founder snapshot ID was withdrawn and cannot be reused; confirm a new snapshot ID",
      );
    }
    const requestSignatureSha256 = signatureSha256({
      setupRunId: input.setupRunId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      profile: requestedProfile,
      isSynthetic: input.isSynthetic,
    });
    const replay = this.#confirmationKeys.get(key);
    if (replay !== undefined) {
      if (replay.status !== "replayable") {
        const withdrawn = replay.status === "snapshot_withdrawn";
        throw new BizForgeStoreError(
          withdrawn ? "founder_snapshot_withdrawn" : "idempotency_replay_history_minimized",
          withdrawn
            ? "This founder snapshot was withdrawn and cannot be replayed; re-consent and confirm a new snapshot ID"
            : "This confirmation succeeded previously, but its superseded profile was minimized because founder version-history consent is not active",
        );
      }
      if (!this.#hasActiveConsent(input.setupRunId, "retain_minimized_founder_snapshot")) {
        throw new BizForgeStoreError(
          "consent_required",
          "Active retain_minimized_founder_snapshot consent is required to replay a founder snapshot",
        );
      }
      if (replay.signatureSha256 !== requestSignatureSha256) {
        throw new BizForgeStoreError(
          "idempotency_conflict",
          "The idempotency key was already used with a different founder snapshot",
        );
      }
      const liveEligibility = this.#confirmationEligibility(
        input.setupRunId,
        replay.result.profile.value.snapshotId,
      );
      const currentResult = { ...replay.result, ...liveEligibility, replayed: false };
      this.#confirmationKeys.set(key, { ...replay, result: currentResult });
      return { ...clone(currentResult), replayed: true };
    }

    const storedRun = requireRun(this.#runs, input.setupRunId);
    assertVersion(storedRun.value, input.expectedVersion);
    if (input.isSynthetic !== storedRun.isSynthetic) {
      throw new BizForgeStoreError(
        "synthetic_origin_mismatch",
        "Founder snapshot synthetic origin must match its setup run",
      );
    }
    if (storedRun.value.founderId !== requestedProfile.founderId) {
      throw new BizForgeStoreError(
        "founder_mismatch",
        "Founder snapshot founderId does not match the setup run founderId",
      );
    }
    if (!["DRAFT_REVIEW", "REVISION_DRAFT"].includes(storedRun.value.state)) {
      throw new BizForgeStoreError(
        "invalid_transition",
        `A founder snapshot cannot be confirmed from ${storedRun.value.state}`,
      );
    }

    if (!this.#hasActiveConsent(input.setupRunId, "retain_minimized_founder_snapshot")) {
      throw new BizForgeStoreError(
        "consent_required",
        "Active retain_minimized_founder_snapshot consent is required",
      );
    }
    const profile = input.isSynthetic
      ? requestedProfile
      : ConfirmedFounderProfileSnapshotSchema.parse({
          ...requestedProfile,
          snapshotId: `snapshot-${randomUUID()}`,
        });
    if (
      this.#profiles.has(profile.snapshotId) ||
      this.#withdrawnProfileSnapshotIds.has(profile.snapshotId)
    ) {
      throw new BizForgeStoreError(
        "snapshot_id_generation_conflict",
        "A unique founder snapshot ID could not be issued; retry the confirmation",
      );
    }
    for (const evidenceId of profile.sourceEvidenceIds) {
      const evidence = this.#evidence.get(evidenceId);
      if (
        evidence === undefined ||
        evidence.setupRunId !== input.setupRunId ||
        evidence.isSynthetic !== input.isSynthetic
      ) {
        throw new BizForgeStoreError(
          "evidence_not_found",
          `Founder evidence ${evidenceId} is missing from this setup run`,
        );
      }
    }

    const existing = this.#profiles.get(profile.snapshotId);
    if (existing !== undefined) {
      throw new BizForgeStoreError(
        "snapshot_conflict",
        `Confirmed snapshot ${profile.snapshotId} is immutable and already exists`,
      );
    }
    // Every evidence reference has already been verified against this setup run
    // and origin above. Research bundles are persisted through their explicit
    // write boundary after profile confirmation.
    const { stage2HandoffEligible } = this.#confirmationEligibility(
      input.setupRunId,
      profile.snapshotId,
      true,
    );

    const checkpoint = {
      runs: new Map(this.#runs),
      evidence: new Map(this.#evidence),
      profiles: new Map(this.#profiles),
      bundles: new Map(this.#bundles),
      transitionKeys: new Map(this.#transitionKeys),
      confirmationKeys: new Map(this.#confirmationKeys),
      currentProfileSnapshotIds: new Map(this.#currentProfileSnapshotIds),
      profileReplacementRequiredSetupRunIds: new Set(this.#profileReplacementRequiredSetupRunIds),
      historyCleanupGeneration: this.#historyCleanupGeneration,
      historyCleanupCompletedGeneration: this.#historyCleanupCompletedGeneration,
    };
    try {
      const storedProfile = {
        setupRunId: input.setupRunId,
        value: clone(profile),
        ...this.#origin(input.source ?? "mcp_write", input.isSynthetic),
      };
      this.#profiles.set(profile.snapshotId, storedProfile);
      this.#currentProfileSnapshotIds.set(input.setupRunId, profile.snapshotId);
      this.#profileReplacementRequiredSetupRunIds.delete(input.setupRunId);

      const transition = this.#transitionSetupRun(
        {
          setupRunId: input.setupRunId,
          expectedVersion: input.expectedVersion,
          targetState: "CONFIRMED",
          idempotencyKey: `confirm:${input.idempotencyKey}`,
          stateData: { confirmedSnapshotId: profile.snapshotId },
        },
        true,
      );
      const result: ConfirmFounderProfileResult = {
        profile: storedProfile,
        run: transition.run,
        stage2HandoffEligible,
        replayed: false,
      };
      this.#confirmationKeys.set(key, {
        status: "replayable",
        signatureSha256: requestSignatureSha256,
        result,
      });
      this.#minimizeFounderVersionHistory(input.setupRunId);
      return clone(result);
    } catch (error) {
      restoreMap(this.#runs, checkpoint.runs);
      restoreMap(this.#evidence, checkpoint.evidence);
      restoreMap(this.#profiles, checkpoint.profiles);
      restoreMap(this.#bundles, checkpoint.bundles);
      restoreMap(this.#transitionKeys, checkpoint.transitionKeys);
      restoreMap(this.#confirmationKeys, checkpoint.confirmationKeys);
      restoreMap(this.#currentProfileSnapshotIds, checkpoint.currentProfileSnapshotIds);
      restoreSet(
        this.#profileReplacementRequiredSetupRunIds,
        checkpoint.profileReplacementRequiredSetupRunIds,
      );
      this.#historyCleanupGeneration = checkpoint.historyCleanupGeneration;
      this.#historyCleanupCompletedGeneration = checkpoint.historyCleanupCompletedGeneration;
      throw error;
    }
  }

  getFounderProfile(
    snapshotId: string,
  ): StoredFounderProfileRecord<ConfirmedFounderProfileSnapshot> | undefined {
    const value = this.#profiles.get(snapshotId);
    return value === undefined || !this.#canReadFounderProfile(value.setupRunId)
      ? undefined
      : clone(value);
  }

  #canReadFounderProfile(setupRunId: string): boolean {
    return this.#hasActiveConsent(setupRunId, "retain_minimized_founder_snapshot");
  }

  #canReadResearchOutput(setupRunId: string): boolean {
    return (
      this.#canReadFounderProfile(setupRunId) &&
      this.#hasActiveConsent(setupRunId, "use_confirmed_founder_snapshot_for_research")
    );
  }

  saveResearchBundle(
    input: ResearchBundle,
    source: DataSource,
    isSynthetic: boolean,
  ): StoredResearchBundleRecord<ResearchBundle> {
    this.#assertWriteOriginSupported(isSynthetic);
    const bundle = ResearchBundleSchema.parse(input);
    assertResearchBundleEvidenceValid(bundle);
    const referencedIds = referencedEvidenceIds(bundle);
    const suppliedIds = new Set(bundle.evidence.map(({ evidenceId }) => evidenceId));
    if (
      referencedIds.size !== suppliedIds.size ||
      [...suppliedIds].some((evidenceId) => !referencedIds.has(evidenceId))
    ) {
      throw new BizForgeStoreError(
        "orphan_evidence",
        "Research bundle evidence must exactly equal the transitive set of referenced evidence IDs",
      );
    }
    const profile = this.#profiles.get(bundle.founderProfile.snapshotId);
    if (profile === undefined || signature(profile.value) !== signature(bundle.founderProfile)) {
      throw new BizForgeStoreError(
        "founder_snapshot_not_found",
        "Research bundle must reference an identical stored confirmed founder snapshot",
      );
    }
    if (profile.isSynthetic !== isSynthetic) {
      throw new BizForgeStoreError(
        "synthetic_origin_mismatch",
        "Research bundle synthetic origin must match its founder snapshot",
      );
    }
    if (this.#currentProfileSnapshotIds.get(profile.setupRunId) !== profile.value.snapshotId) {
      throw new BizForgeStoreError(
        "founder_snapshot_superseded",
        "Research bundles can only be published for the current confirmed founder snapshot",
      );
    }
    if (!this.#hasActiveConsent(profile.setupRunId, "retain_minimized_founder_snapshot")) {
      throw new BizForgeStoreError(
        "consent_required",
        "Active retain_minimized_founder_snapshot consent is required",
      );
    }
    if (
      !this.#hasActiveConsent(profile.setupRunId, "use_confirmed_founder_snapshot_for_research")
    ) {
      throw new BizForgeStoreError(
        "consent_required",
        "Active use_confirmed_founder_snapshot_for_research consent is required",
      );
    }
    const founderEvidenceIds = referencedFounderEvidenceIds(bundle.founderProfile);
    for (const evidence of bundle.evidence) {
      const requiredScope = evidenceConsentScope(evidence);
      if (
        (requiredScope === "retain_minimized_founder_self_report" ||
          founderEvidenceIds.has(evidence.evidenceId)) &&
        !this.#hasActiveConsent(profile.setupRunId, requiredScope)
      ) {
        throw new BizForgeStoreError(
          "consent_required",
          `Active ${requiredScope} consent is required to publish this bundle evidence`,
        );
      }
    }
    const key = `${bundle.bundleId}:${bundle.bundleVersion}`;
    const existing = this.#bundles.get(key);
    if (existing !== undefined && signature(existing.value) !== signature(bundle)) {
      throw new BizForgeStoreError(
        "research_bundle_conflict",
        `Research bundle ${key} already exists with different content`,
      );
    }
    const checkpoint = {
      evidence: new Map(this.#evidence),
      bundles: new Map(this.#bundles),
    };
    try {
      for (const evidence of bundle.evidence) {
        this.#storeEvidence(profile.setupRunId, evidence, source, isSynthetic);
      }
      const stored = existing ?? {
        setupRunId: profile.setupRunId,
        value: clone(bundle),
        ...this.#origin(source, isSynthetic),
      };
      this.#bundles.set(key, stored);
      return clone(stored);
    } catch (error) {
      restoreMap(this.#evidence, checkpoint.evidence);
      restoreMap(this.#bundles, checkpoint.bundles);
      throw error;
    }
  }

  getResearchBundle(
    bundleId: string,
    version?: number,
  ): StoredResearchBundleRecord<ResearchBundle> | undefined {
    if (version !== undefined) {
      const result = this.#bundles.get(`${bundleId}:${version}`);
      return result === undefined || !this.#canReadResearchOutput(result.setupRunId)
        ? undefined
        : clone(result);
    }
    const result = [...this.#bundles.values()]
      .filter(
        ({ setupRunId, value }) =>
          value.bundleId === bundleId && this.#canReadResearchOutput(setupRunId),
      )
      .sort((left, right) => right.value.bundleVersion - left.value.bundleVersion)[0];
    return result === undefined ? undefined : clone(result);
  }

  getLatestResearchBundle(
    founderId?: string,
  ): StoredResearchBundleRecord<ResearchBundle> | undefined {
    const result = [...this.#bundles.values()]
      .filter(
        ({ setupRunId, value }) =>
          this.#canReadResearchOutput(setupRunId) &&
          (founderId === undefined || value.founderProfile.founderId === founderId),
      )
      .sort(
        (left, right) => Date.parse(right.value.generatedAt) - Date.parse(left.value.generatedAt),
      )[0];
    return result === undefined ? undefined : clone(result);
  }

  getOpportunity(opportunityId: string) {
    const bundle = [...this.#bundles.values()]
      .filter(
        ({ setupRunId, value }) =>
          this.#canReadResearchOutput(setupRunId) &&
          value.opportunities.some((opportunity) => opportunity.opportunityId === opportunityId),
      )
      .sort(
        (left, right) => Date.parse(right.value.generatedAt) - Date.parse(left.value.generatedAt),
      )[0];
    if (bundle === undefined) return undefined;
    const opportunity = bundle.value.opportunities.find(
      (candidate) => candidate.opportunityId === opportunityId,
    );
    return opportunity === undefined ? undefined : clone({ opportunity, bundle });
  }

  requestDeletion(input: RequestDeletionInput): StoredRecord<DeletionRecord> {
    const key = scopedIdempotencyKey(input.setupRunId, input.idempotencyKey);
    const requestSignature = signature(input);
    const replay = this.#deletionKeys.get(key);
    if (replay !== undefined) {
      this.#assertWriteOriginSupported(replay.record.isSynthetic);
      if (replay.signature !== requestSignature) {
        throw new BizForgeStoreError(
          "idempotency_conflict",
          "The deletion idempotency key was already used with different parameters",
        );
      }
      return clone(replay.record);
    }
    const run = requireRun(this.#runs, input.setupRunId);
    this.#assertWriteOriginSupported(run.isSynthetic);
    if (run.value.founderId !== input.founderId) {
      throw new BizForgeStoreError(
        "founder_mismatch",
        "Deletion founderId does not match the setup run founderId",
      );
    }

    if (run.value.state !== "DELETION_REQUESTED") {
      this.transitionSetupRun({
        setupRunId: input.setupRunId,
        expectedVersion: run.value.version,
        targetState: "DELETION_REQUESTED",
        idempotencyKey: `delete:${input.idempotencyKey}`,
      });
    }

    let removed = 0;
    for (const [id, record] of this.#evidence) {
      if (record.setupRunId === input.setupRunId) {
        this.#evidence.delete(id);
        removed += 1;
      }
    }
    for (const [id, record] of this.#profiles) {
      if (record.setupRunId === input.setupRunId) {
        this.#profiles.delete(id);
        this.#withdrawnProfileSnapshotIds.add(id);
        removed += 1;
      }
    }
    for (const [id, record] of this.#bundles) {
      if (record.setupRunId === input.setupRunId) {
        this.#bundles.delete(id);
        removed += 1;
      }
    }
    for (const [id, record] of this.#consents) {
      if (record.value.setupRunId === input.setupRunId) {
        this.#consents.delete(id);
        this.#consentOrder.delete(id);
        removed += 1;
      }
    }
    this.#runs.delete(input.setupRunId);
    this.#currentProfileSnapshotIds.delete(input.setupRunId);
    this.#profileReplacementRequiredSetupRunIds.delete(input.setupRunId);
    removed += 1;
    for (const [idempotencyKey, transition] of this.#transitionKeys) {
      const ownerSetupRunId =
        transition.status === "replayable" ? transition.run.setupRunId : transition.setupRunId;
      if (ownerSetupRunId === input.setupRunId) {
        this.#transitionKeys.delete(idempotencyKey);
      }
    }
    for (const [idempotencyKey, confirmation] of this.#confirmationKeys) {
      const ownerSetupRunId =
        confirmation.status === "replayable"
          ? confirmation.result.run.setupRunId
          : confirmation.setupRunId;
      if (ownerSetupRunId === input.setupRunId) {
        this.#confirmationKeys.delete(idempotencyKey);
      }
    }
    for (const [clientRequestId, creation] of this.#creationKeys) {
      if (creation.status === "active" && creation.setupRunId === input.setupRunId) {
        this.#creationKeys.set(clientRequestId, {
          status: "deleted",
          signatureSha256: creation.signatureSha256,
        });
      }
    }
    this.#deletedSetupRunIds.add(input.setupRunId);

    const now = new Date().toISOString();
    const dataStatus = this.getDataStatus();
    const systems = dataStatus.isMock
      ? [
          {
            system: "in_memory_store",
            status: "completed" as const,
            reason: `Removed ${removed} controllable in-memory records for setup run ${input.setupRunId}`,
            checkedAt: now,
          },
          {
            system: "durable_artifact_store",
            status: "unverifiable" as const,
            reason: "The mock adapter has no durable artifact store to inspect",
            checkedAt: now,
          },
          {
            system: "trueforge_session_transcripts",
            status: "unverifiable" as const,
            reason: "TrueForge transcript deletion is outside this mock adapter",
            checkedAt: now,
          },
          {
            system: "external_providers",
            status: "unverifiable" as const,
            reason: "Provider-side retention cannot be verified by this mock adapter",
            checkedAt: now,
          },
          {
            system: "backups",
            status: "pending_expiry" as const,
            reason: "No documented backup-expiry confirmation is available in the mock adapter",
            checkedAt: now,
          },
        ]
      : [
          {
            system: `${dataStatus.storageBackend}_store`,
            status: "pending" as const,
            reason: `Removed ${removed} records for setup run ${input.setupRunId} from the domain snapshot; durable storage finalization is pending`,
            checkedAt: now,
          },
          {
            system: "trueforge_session_transcripts",
            status: "unverifiable" as const,
            reason: "TrueForge transcript deletion is outside this storage adapter",
            checkedAt: now,
          },
          {
            system: "external_providers",
            status: "unverifiable" as const,
            reason: "Provider-side retention cannot be verified by this storage adapter",
            checkedAt: now,
          },
          {
            system: "backups",
            status: "pending_expiry" as const,
            reason: "Independently managed backups remain subject to their retention policy",
            checkedAt: now,
          },
        ];
    const deletion: DeletionRecord = {
      deletionRequestId: `deletion-${randomUUID()}`,
      setupRunId: input.setupRunId,
      founderId: input.founderId,
      requestedAt: now,
      reason: input.reason,
      status: "pending_expiry",
      systems,
    };
    const stored = {
      value: deletion,
      ...this.#origin("mcp_write", run.isSynthetic),
    };
    this.#deletions.set(deletion.deletionRequestId, stored);
    this.#deletionKeys.set(key, { signature: requestSignature, record: stored });
    return clone(stored);
  }

  updateDeletionSystemStatus(
    deletionRequestId: string,
    update: DeletionSystemStatus,
  ): StoredRecord<DeletionRecord> {
    const parsedUpdate = DeletionSystemStatusSchema.parse(update);
    const stored = this.#deletions.get(deletionRequestId);
    if (stored === undefined) {
      throw new BizForgeStoreError(
        "deletion_not_found",
        `Deletion request ${deletionRequestId} was not found`,
      );
    }
    const systemIndex = stored.value.systems.findIndex(
      ({ system }) => system === parsedUpdate.system,
    );
    if (systemIndex === -1) {
      throw new BizForgeStoreError(
        "deletion_system_not_found",
        `Deletion system ${parsedUpdate.system} was not found on request ${deletionRequestId}`,
      );
    }
    const systems = [...stored.value.systems];
    systems[systemIndex] = parsedUpdate;
    const updated: StoredRecord<DeletionRecord> = {
      ...stored,
      value: DeletionRecordSchema.parse({ ...stored.value, systems }),
    };
    this.#deletions.set(deletionRequestId, updated);
    for (const [key, replay] of this.#deletionKeys) {
      if (replay.record.value.deletionRequestId === deletionRequestId) {
        this.#deletionKeys.set(key, { ...replay, record: updated });
      }
    }
    return clone(updated);
  }

  getDeletionStatus(deletionRequestId: string): StoredRecord<DeletionRecord> | undefined {
    const value = this.#deletions.get(deletionRequestId);
    return value === undefined ? undefined : clone(value);
  }
}
