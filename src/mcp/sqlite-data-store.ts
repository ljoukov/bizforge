import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EvidenceItem } from "../domain/evidence.js";
import type { ConfirmedFounderProfileSnapshot } from "../domain/founder-profile.js";
import type { OpportunityDossier } from "../domain/opportunity-dossier.js";
import type { ResearchBundle } from "../domain/research-bundle.js";
import type {
  ConsentRecord,
  ConsentScope,
  DataSource,
  DataStoreStatus,
  DeletionRecord,
  DeletionSystemStatus,
  StoredEvidenceRecord,
  StoredFounderProfileRecord,
  StoredRecord,
  StoredResearchBundleRecord,
} from "./contracts.js";
import {
  type BizForgeDataStore,
  BizForgeStoreError,
  type ConfirmFounderProfileInput,
  type ConfirmFounderProfileResult,
  InMemoryBizForgeDataStore,
  type RequestDeletionInput,
  type StoredRecordWithConsent,
  type StoredRecordWithRun,
  type TransitionSetupRunInput,
  type TransitionSetupRunResult,
} from "./data-store.js";

const SQLITE_SCHEMA_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

interface StateRow {
  readonly revision: number;
  readonly state_json: string;
  readonly state_sha256: string;
}

interface WalCheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

function sqliteStatus(): DataStoreStatus {
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

function stateSha256(stateJson: string): string {
  return createHash("sha256").update(stateJson).digest("hex");
}

type CreateSetupRunInput = Parameters<BizForgeDataStore["createSetupRun"]>[0];

/**
 * Persistent, concurrency-safe BizForge storage backed by a single revisioned
 * and checksummed state snapshot. Domain logic remains centralized in
 * `InMemoryBizForgeDataStore`; SQLite supplies the lock and durability boundary.
 */
export class SqliteBizForgeDataStore implements BizForgeDataStore {
  readonly #database: DatabaseSync;
  readonly #databasePath: string;
  #closed = false;

  constructor(databasePath: string) {
    if (databasePath.trim().length === 0 || databasePath === ":memory:") {
      throw new TypeError("A persistent SQLite file path is required");
    }

    this.#databasePath = resolve(databasePath);
    const parentDirectory = dirname(this.#databasePath);
    const parentExisted = existsSync(parentDirectory);
    mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
    if (!parentExisted) chmodSync(parentDirectory, 0o700);

    this.#database = new DatabaseSync(this.#databasePath, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    try {
      this.#hardenFileModes();
      this.#database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
      `);
      this.#hardenFileModes();
      this.#migrate();
      this.#loadDomainStore();
      this.#retryPendingDeletionCleanups();
      this.#tryFinalizeHistoryCleanup();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  getDataStatus(): DataStoreStatus {
    this.#tryFinalizeHistoryCleanup();
    return this.#loadDomainStore().getDataStatus();
  }

  createSetupRun(input: CreateSetupRunInput): StoredRecordWithRun {
    return this.#mutate((store) => store.createSetupRun(input));
  }

  getSetupRun(setupRunId: string): StoredRecordWithRun | undefined {
    this.#tryFinalizeHistoryCleanup();
    return this.#loadDomainStore().getSetupRun(setupRunId);
  }

  transitionSetupRun(input: TransitionSetupRunInput): TransitionSetupRunResult {
    return this.#mutate((store) => store.transitionSetupRun(input));
  }

  recordConsent(record: ConsentRecord, source: DataSource = "mcp_write"): StoredRecordWithConsent {
    return this.#mutate((store) => store.recordConsent(record, source));
  }

  getConsent(setupRunId: string, scope?: ConsentScope): StoredRecordWithConsent[] {
    this.#tryFinalizeHistoryCleanup();
    return this.#loadDomainStore().getConsent(setupRunId, scope);
  }

  putEvidence(
    setupRunId: string,
    evidence: EvidenceItem,
    source: DataSource = "mcp_write",
    isSynthetic?: boolean,
  ): StoredEvidenceRecord<EvidenceItem> {
    return this.#mutate((store) => store.putEvidence(setupRunId, evidence, source, isSynthetic));
  }

  getEvidence(evidenceId: string): StoredEvidenceRecord<EvidenceItem> | undefined {
    this.#tryFinalizeHistoryCleanup();
    return this.#loadDomainStore().getEvidence(evidenceId);
  }

  confirmFounderProfile(input: ConfirmFounderProfileInput): ConfirmFounderProfileResult {
    return this.#mutate((store) => store.confirmFounderProfile(input));
  }

  getFounderProfile(
    snapshotId: string,
  ): StoredFounderProfileRecord<ConfirmedFounderProfileSnapshot> | undefined {
    this.#tryFinalizeHistoryCleanup();
    return this.#loadDomainStore().getFounderProfile(snapshotId);
  }

  saveResearchBundle(
    bundle: ResearchBundle,
    source: DataSource,
    isSynthetic: boolean,
  ): StoredResearchBundleRecord<ResearchBundle> {
    return this.#mutate((store) => store.saveResearchBundle(bundle, source, isSynthetic));
  }

  getResearchBundle(
    bundleId: string,
    version?: number,
  ): StoredResearchBundleRecord<ResearchBundle> | undefined {
    this.#tryFinalizeHistoryCleanup();
    return this.#loadDomainStore().getResearchBundle(bundleId, version);
  }

  getLatestResearchBundle(
    founderId?: string,
  ): StoredResearchBundleRecord<ResearchBundle> | undefined {
    this.#tryFinalizeHistoryCleanup();
    return this.#loadDomainStore().getLatestResearchBundle(founderId);
  }

  getOpportunity(opportunityId: string):
    | {
        readonly opportunity: OpportunityDossier;
        readonly bundle: StoredResearchBundleRecord<ResearchBundle>;
      }
    | undefined {
    this.#tryFinalizeHistoryCleanup();
    return this.#loadDomainStore().getOpportunity(opportunityId);
  }

  requestDeletion(input: RequestDeletionInput): StoredRecord<DeletionRecord> {
    const pending = this.#mutate((store) => store.requestDeletion(input), true);
    return this.#tryFinalizeDeletionCleanup(pending);
  }

  getDeletionStatus(deletionRequestId: string): StoredRecord<DeletionRecord> | undefined {
    this.#tryFinalizeHistoryCleanup();
    const current = this.#loadDomainStore().getDeletionStatus(deletionRequestId);
    return current === undefined ? undefined : this.#tryFinalizeDeletionCleanup(current);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #newDomainStore(): InMemoryBizForgeDataStore {
    return new InMemoryBizForgeDataStore({ dataStatus: sqliteStatus() });
  }

  #migrate(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const { user_version: userVersion } = this.#database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (userVersion === 0) {
        this.#database.exec(`
          CREATE TABLE bizforge_state (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            revision INTEGER NOT NULL CHECK (revision >= 0),
            state_json TEXT NOT NULL,
            state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64),
            updated_at TEXT NOT NULL
          ) STRICT;
        `);
        const initialJson = JSON.stringify(this.#newDomainStore().exportSnapshot());
        this.#database
          .prepare(
            "INSERT INTO bizforge_state (singleton_id, revision, state_json, state_sha256, updated_at) VALUES (1, 0, ?, ?, ?)",
          )
          .run(initialJson, stateSha256(initialJson), new Date().toISOString());
        this.#database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      } else if (userVersion !== SQLITE_SCHEMA_VERSION) {
        throw new Error(`Unsupported BizForge SQLite schema version ${userVersion}`);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #loadStateRow(): StateRow {
    const row = this.#database
      .prepare(
        "SELECT revision, state_json, state_sha256 FROM bizforge_state WHERE singleton_id = 1",
      )
      .get() as StateRow | undefined;
    if (
      row === undefined ||
      !Number.isInteger(row.revision) ||
      row.revision < 0 ||
      typeof row.state_json !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.state_sha256)
    ) {
      throw new BizForgeStoreError(
        "store_integrity_error",
        "The BizForge SQLite state row is missing or malformed",
      );
    }
    if (stateSha256(row.state_json) !== row.state_sha256) {
      throw new BizForgeStoreError(
        "store_integrity_error",
        "The BizForge SQLite state checksum does not match its stored snapshot",
      );
    }
    return row;
  }

  #loadDomainStore(): InMemoryBizForgeDataStore {
    this.#assertOpen();
    const row = this.#loadStateRow();
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(row.state_json) as unknown;
    } catch {
      throw new BizForgeStoreError(
        "store_integrity_error",
        "The BizForge SQLite state snapshot is not valid JSON",
      );
    }
    const store = this.#newDomainStore();
    try {
      store.restoreSnapshot(snapshot);
    } catch (error) {
      if (error instanceof BizForgeStoreError) throw error;
      throw new BizForgeStoreError(
        "store_integrity_error",
        "The BizForge SQLite state snapshot failed schema validation",
      );
    }
    return store;
  }

  #mutate<T>(
    operation: (store: InMemoryBizForgeDataStore) => T,
    toleratePostCommitMaintenanceFailure = false,
    finalizePendingHistory = true,
  ): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      const current = this.#loadStateRow();
      const store = this.#newDomainStore();
      store.restoreSnapshot(JSON.parse(current.state_json) as unknown);
      result = operation(store);
      const nextSnapshot = store.exportSnapshot();
      const validationStore = this.#newDomainStore();
      validationStore.restoreSnapshot(nextSnapshot);
      const nextJson = JSON.stringify(validationStore.exportSnapshot());
      const update = this.#database
        .prepare(
          "UPDATE bizforge_state SET revision = ?, state_json = ?, state_sha256 = ?, updated_at = ? WHERE singleton_id = 1 AND revision = ?",
        )
        .run(
          current.revision + 1,
          nextJson,
          stateSha256(nextJson),
          new Date().toISOString(),
          current.revision,
        );
      if (Number(update.changes) !== 1) {
        throw new BizForgeStoreError(
          "store_revision_conflict",
          "The BizForge SQLite state changed while applying a mutation",
        );
      }
      this.#hardenFileModes();
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }

    try {
      this.#hardenFileModes();
    } catch (error) {
      try {
        this.#database.close();
      } catch {
        // The instance is failed closed below even if SQLite cannot cleanly
        // release the native handle after a file-permission error.
      }
      this.#closed = true;
      if (!toleratePostCommitMaintenanceFailure) throw error;
    }
    if (finalizePendingHistory && !this.#closed) this.#tryFinalizeHistoryCleanup();
    return result;
  }

  #tryFinalizeHistoryCleanup(): void {
    let generation: number;
    try {
      const snapshot = this.#loadDomainStore().exportSnapshot();
      if (snapshot.historyCleanupGeneration <= snapshot.historyCleanupCompletedGeneration) return;
      generation = snapshot.historyCleanupGeneration;
    } catch {
      return;
    }
    if (!this.#secureCleanupSucceeded()) return;

    try {
      this.#mutate((store) => store.acknowledgeHistoryCleanup(generation), false, false);
    } catch {
      // The logical minimization and its pending generation remain durable.
      // A later mutation, status read, or startup can safely retry cleanup.
    }
  }

  #retryPendingDeletionCleanups(): void {
    const snapshot = this.#loadDomainStore().exportSnapshot();
    for (const [, deletion] of snapshot.deletions) {
      if (this.#localCleanupIsPending(deletion)) {
        this.#tryFinalizeDeletionCleanup(deletion);
      }
    }
  }

  #tryFinalizeDeletionCleanup(
    deletion: StoredRecord<DeletionRecord>,
  ): StoredRecord<DeletionRecord> {
    if (!this.#localCleanupIsPending(deletion)) return deletion;
    if (!this.#secureCleanupSucceeded()) return deletion;

    const completed: DeletionSystemStatus = {
      system: "sqlite_store",
      status: "completed",
      reason: "Verified secure SQLite cleanup, WAL truncation, and database compaction completed",
      checkedAt: new Date().toISOString(),
    };
    try {
      return this.#mutate((store) => {
        const current = store.getDeletionStatus(deletion.value.deletionRequestId);
        if (current !== undefined && !this.#localCleanupIsPending(current)) return current;
        return store.updateDeletionSystemStatus(deletion.value.deletionRequestId, completed);
      });
    } catch {
      // Logical deletion is already durable. A later startup or status read can
      // safely repeat cleanup and persist the completion receipt.
      try {
        return (
          this.#loadDomainStore().getDeletionStatus(deletion.value.deletionRequestId) ?? deletion
        );
      } catch {
        return deletion;
      }
    }
  }

  #localCleanupIsPending(deletion: StoredRecord<DeletionRecord>): boolean {
    const local = deletion.value.systems.find(({ system }) => system === "sqlite_store");
    return local?.status === "pending" || local?.status === "pending_expiry";
  }

  #secureCleanupSucceeded(): boolean {
    let cleanupSucceeded = false;
    try {
      this.#database.exec("PRAGMA busy_timeout = 0");
      if (this.#checkpointTruncated()) {
        this.#database.exec("VACUUM");
        cleanupSucceeded = this.#checkpointTruncated();
      }
    } catch {
      cleanupSucceeded = false;
    }
    try {
      this.#database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      this.#hardenFileModes();
    } catch {
      // The durable maintenance obligation remains pending when cleanup cannot
      // be verified; do not turn an already-committed mutation into a failure.
      return false;
    }
    return cleanupSucceeded;
  }

  #checkpointTruncated(): boolean {
    const result = this.#database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | WalCheckpointResult
      | undefined;
    return (
      result !== undefined &&
      result.busy === 0 &&
      Number.isInteger(result.log) &&
      result.log === 0 &&
      Number.isInteger(result.checkpointed) &&
      result.checkpointed === 0
    );
  }

  #hardenFileModes(): void {
    for (const path of [
      this.#databasePath,
      `${this.#databasePath}-wal`,
      `${this.#databasePath}-shm`,
    ]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The BizForge SQLite store is closed");
  }
}
