import { randomUUID } from "node:crypto";

import { flattenClaimSet } from "../domain/claims.js";
import type { EvidenceItem } from "../domain/evidence.js";
import {
  ConfirmedFounderProfileSnapshotSchema,
  type ConfirmedFounderProfileSnapshot,
} from "../domain/founder-profile.js";
import { type ResearchBundle, ResearchBundleSchema } from "../domain/research-bundle.js";
import { claimSetsInOpportunity, type OpportunityDossier } from "../domain/opportunity-dossier.js";
import { assertResearchBundleEvidenceValid } from "../application/validate-research-bundle.js";
import {
  type ConsentRecord,
  ConsentRecordSchema,
  type ConsentScope,
  type DataStoreStatus,
  type DataSource,
  type DeletionRecord,
  type FounderSetupRun,
  FounderSetupRunSchema,
  type FounderSetupState,
  type RecordOrigin,
  type StoredRecord,
  type StoredEvidenceRecord,
  type StoredFounderProfileRecord,
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
  readonly mockStep2DemoEligible: boolean;
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
    founderId: string;
    setupRunId?: string;
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

interface IdempotentTransition {
  readonly signature: string;
  readonly run: FounderSetupRun;
}

interface IdempotentConfirmation {
  readonly signature: string;
  readonly result: ConfirmFounderProfileResult;
}

interface IdempotentDeletion {
  readonly signature: string;
  readonly record: StoredRecord<DeletionRecord>;
}

const allowedTransitions: Readonly<Record<FounderSetupState, readonly FounderSetupState[]>> = {
  CONSENT_PENDING: ["PUBLIC_EVIDENCE", "INTERVIEW", "DELETION_REQUESTED"],
  PUBLIC_EVIDENCE: ["INTERVIEW", "DELETION_REQUESTED"],
  INTERVIEW: ["DRAFT_REVIEW", "DELETION_REQUESTED"],
  DRAFT_REVIEW: ["DRAFT_REVIEW", "CONFIRMED", "DELETION_REQUESTED"],
  CONFIRMED: ["REVISION_DRAFT", "DELETION_REQUESTED"],
  REVISION_DRAFT: ["REVISION_DRAFT", "CONFIRMED", "DELETION_REQUESTED"],
  DELETION_REQUESTED: [],
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function signature(value: unknown): string {
  return JSON.stringify(value);
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
  readonly #transitionKeys = new Map<string, IdempotentTransition>();
  readonly #confirmationKeys = new Map<string, IdempotentConfirmation>();
  readonly #deletionKeys = new Map<string, IdempotentDeletion>();
  readonly #consentOrder = new Map<string, number>();
  #nextConsentOrder = 1;
  readonly #researchBundleFactory:
    | ((
        profile: ConfirmedFounderProfileSnapshot,
        founderEvidence: readonly EvidenceItem[],
      ) => ResearchBundle)
    | undefined;

  constructor(options?: {
    researchBundleFactory?: (
      profile: ConfirmedFounderProfileSnapshot,
      founderEvidence: readonly EvidenceItem[],
    ) => ResearchBundle;
  }) {
    this.#researchBundleFactory = options?.researchBundleFactory;
  }

  getDataStatus(): DataStoreStatus {
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
    founderId: string;
    setupRunId?: string;
    source?: DataSource;
    isSynthetic: boolean;
    now?: string;
  }): StoredRecordWithRun {
    const setupRunId = input.setupRunId ?? `setup-${randomUUID()}`;
    const requestedSynthetic = input.isSynthetic;
    this.#assertWriteOriginSupported(requestedSynthetic);
    const existing = this.#runs.get(setupRunId);
    if (existing !== undefined) {
      if (existing.value.founderId !== input.founderId) {
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
      return clone(existing);
    }

    const now = input.now ?? new Date().toISOString();
    const source = input.source ?? "mcp_write";
    const value = FounderSetupRunSchema.parse({
      schemaVersion: "1.0.0",
      setupRunId,
      founderId: input.founderId,
      state: "CONSENT_PENDING",
      version: 1,
      stateData: {},
      createdAt: now,
      updatedAt: now,
    });
    const record = { value, ...this.#origin(source, requestedSynthetic) };
    this.#runs.set(setupRunId, record);
    return clone(record);
  }

  getSetupRun(setupRunId: string): StoredRecordWithRun | undefined {
    const value = this.#runs.get(setupRunId);
    return value === undefined ? undefined : clone(value);
  }

  transitionSetupRun(input: TransitionSetupRunInput): TransitionSetupRunResult {
    const stored = requireRun(this.#runs, input.setupRunId);
    this.#assertWriteOriginSupported(stored.isSynthetic);
    const key = `${input.setupRunId}:${input.idempotencyKey}`;
    const requestSignature = signature(input);
    const replay = this.#transitionKeys.get(key);
    if (replay !== undefined) {
      if (replay.signature !== requestSignature) {
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

    const run = FounderSetupRunSchema.parse({
      ...stored.value,
      state: input.targetState,
      version: stored.value.version + 1,
      stateData: input.stateData === undefined ? stored.value.stateData : input.stateData,
      updatedAt: new Date().toISOString(),
    });
    this.#runs.set(input.setupRunId, { ...stored, value: run });
    this.#transitionKeys.set(key, { signature: requestSignature, run });
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
    const stored = existing ?? { value: parsed, ...this.#origin(source, run.isSynthetic) };
    if (existing === undefined) {
      this.#consentOrder.set(parsed.consentId, this.#nextConsentOrder);
      this.#nextConsentOrder += 1;
    }
    this.#consents.set(parsed.consentId, stored);
    return clone(stored);
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
    const key = `${input.setupRunId}:${input.idempotencyKey}`;
    const profile = ConfirmedFounderProfileSnapshotSchema.parse(input.profile);
    const requestSignature = signature({
      setupRunId: input.setupRunId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      profile,
      isSynthetic: input.isSynthetic,
    });
    const replay = this.#confirmationKeys.get(key);
    if (replay !== undefined) {
      if (replay.signature !== requestSignature) {
        throw new BizForgeStoreError(
          "idempotency_conflict",
          "The idempotency key was already used with a different founder snapshot",
        );
      }
      return { ...clone(replay.result), replayed: true };
    }

    const storedRun = requireRun(this.#runs, input.setupRunId);
    assertVersion(storedRun.value, input.expectedVersion);
    if (input.isSynthetic !== storedRun.isSynthetic) {
      throw new BizForgeStoreError(
        "synthetic_origin_mismatch",
        "Founder snapshot synthetic origin must match its setup run",
      );
    }
    if (storedRun.value.founderId !== profile.founderId) {
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
    const founderEvidence = profile.sourceEvidenceIds.map((evidenceId) => {
      const evidence = this.#evidence.get(evidenceId);
      if (evidence === undefined) {
        throw new BizForgeStoreError(
          "evidence_not_found",
          `Founder evidence ${evidenceId} is missing`,
        );
      }
      return evidence.value;
    });
    const researchConsentActive = this.#hasActiveConsent(
      input.setupRunId,
      "use_confirmed_founder_snapshot_for_research",
    );
    const isMockStore = this.getDataStatus().isMock;
    const stage2HandoffEligible = !isMockStore && researchConsentActive;
    const mockStep2DemoEligible = isMockStore && input.isSynthetic && researchConsentActive;
    const generatedBundle =
      mockStep2DemoEligible && this.#researchBundleFactory !== undefined
        ? this.#researchBundleFactory(profile, founderEvidence)
        : undefined;
    if (generatedBundle !== undefined) {
      ResearchBundleSchema.parse(generatedBundle);
      assertResearchBundleEvidenceValid(generatedBundle);
    }

    const checkpoint = {
      runs: new Map(this.#runs),
      evidence: new Map(this.#evidence),
      profiles: new Map(this.#profiles),
      bundles: new Map(this.#bundles),
      transitionKeys: new Map(this.#transitionKeys),
      confirmationKeys: new Map(this.#confirmationKeys),
    };
    try {
      const storedProfile = {
        setupRunId: input.setupRunId,
        value: clone(profile),
        ...this.#origin(input.source ?? "mcp_write", input.isSynthetic),
      };
      this.#profiles.set(profile.snapshotId, storedProfile);

      const transition = this.transitionSetupRun({
        setupRunId: input.setupRunId,
        expectedVersion: input.expectedVersion,
        targetState: "CONFIRMED",
        idempotencyKey: `confirm:${input.idempotencyKey}`,
        stateData: { confirmedSnapshotId: profile.snapshotId },
      });
      const result: ConfirmFounderProfileResult = {
        profile: storedProfile,
        run: transition.run,
        stage2HandoffEligible,
        mockStep2DemoEligible,
        replayed: false,
      };
      if (generatedBundle !== undefined) {
        this.saveResearchBundle(generatedBundle, input.source ?? "mcp_write", input.isSynthetic);
      }
      this.#confirmationKeys.set(key, { signature: requestSignature, result });
      return clone(result);
    } catch (error) {
      restoreMap(this.#runs, checkpoint.runs);
      restoreMap(this.#evidence, checkpoint.evidence);
      restoreMap(this.#profiles, checkpoint.profiles);
      restoreMap(this.#bundles, checkpoint.bundles);
      restoreMap(this.#transitionKeys, checkpoint.transitionKeys);
      restoreMap(this.#confirmationKeys, checkpoint.confirmationKeys);
      throw error;
    }
  }

  getFounderProfile(
    snapshotId: string,
  ): StoredFounderProfileRecord<ConfirmedFounderProfileSnapshot> | undefined {
    const value = this.#profiles.get(snapshotId);
    return value === undefined ? undefined : clone(value);
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
      return result === undefined ? undefined : clone(result);
    }
    const result = [...this.#bundles.values()]
      .filter(({ value }) => value.bundleId === bundleId)
      .sort((left, right) => right.value.bundleVersion - left.value.bundleVersion)[0];
    return result === undefined ? undefined : clone(result);
  }

  getLatestResearchBundle(
    founderId?: string,
  ): StoredResearchBundleRecord<ResearchBundle> | undefined {
    const result = [...this.#bundles.values()]
      .filter(
        ({ value }) => founderId === undefined || value.founderProfile.founderId === founderId,
      )
      .sort(
        (left, right) => Date.parse(right.value.generatedAt) - Date.parse(left.value.generatedAt),
      )[0];
    return result === undefined ? undefined : clone(result);
  }

  getOpportunity(opportunityId: string) {
    const bundle = [...this.#bundles.values()]
      .filter(({ value }) =>
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
    const key = `${input.setupRunId}:${input.idempotencyKey}`;
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
    removed += 1;
    const idempotencyPrefix = `${input.setupRunId}:`;
    for (const idempotencyKey of this.#transitionKeys.keys()) {
      if (idempotencyKey.startsWith(idempotencyPrefix)) {
        this.#transitionKeys.delete(idempotencyKey);
      }
    }
    for (const idempotencyKey of this.#confirmationKeys.keys()) {
      if (idempotencyKey.startsWith(idempotencyPrefix)) {
        this.#confirmationKeys.delete(idempotencyKey);
      }
    }

    const now = new Date().toISOString();
    const deletion: DeletionRecord = {
      deletionRequestId: `deletion-${randomUUID()}`,
      setupRunId: input.setupRunId,
      founderId: input.founderId,
      requestedAt: now,
      reason: input.reason,
      status: "pending_expiry",
      systems: [
        {
          system: "in_memory_store",
          status: "completed",
          reason: `Removed ${removed} controllable in-memory records`,
          checkedAt: now,
        },
        {
          system: "durable_artifact_store",
          status: "unverifiable",
          reason: "The mock adapter has no durable artifact store to inspect",
          checkedAt: now,
        },
        {
          system: "trueforge_session_transcripts",
          status: "unverifiable",
          reason: "TrueForge transcript deletion is outside this mock adapter",
          checkedAt: now,
        },
        {
          system: "external_providers",
          status: "unverifiable",
          reason: "Provider-side retention cannot be verified by this mock adapter",
          checkedAt: now,
        },
        {
          system: "backups",
          status: "pending_expiry",
          reason: "No documented backup-expiry confirmation is available in the mock adapter",
          checkedAt: now,
        },
      ],
    };
    const stored = {
      value: deletion,
      ...this.#origin("mcp_write", run.isSynthetic),
    };
    this.#deletions.set(deletion.deletionRequestId, stored);
    this.#deletionKeys.set(key, { signature: requestSignature, record: stored });
    return clone(stored);
  }

  getDeletionStatus(deletionRequestId: string): StoredRecord<DeletionRecord> | undefined {
    const value = this.#deletions.get(deletionRequestId);
    return value === undefined ? undefined : clone(value);
  }
}
