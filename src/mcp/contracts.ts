import { z } from "zod";

import { EntityIdSchema, IsoDateTimeSchema, NonEmptyStringSchema } from "../domain/common.js";

export const DataSourceSchema = z.enum(["mock_seed", "mcp_write"]);
export type DataSource = z.infer<typeof DataSourceSchema>;

export const DataStoreStatusSchema = z
  .object({
    dataMode: z.enum(["mock", "persistent"]),
    storageMode: z.enum(["mock", "persistent"]),
    storageBackend: NonEmptyStringSchema,
    persistenceStatus: z.enum(["mock_ephemeral", "persistent"]),
    isMock: z.boolean(),
    ephemeral: z.boolean(),
    writePolicy: z
      .object({
        requiresExplicitMockAcceptance: z.boolean(),
        acceptsNonSyntheticWrites: z.boolean(),
      })
      .strict(),
    fixtureVersion: NonEmptyStringSchema,
    warnings: z.array(NonEmptyStringSchema),
  })
  .strict();
export type DataStoreStatus = z.infer<typeof DataStoreStatusSchema>;

export const FounderSetupStateSchema = z.enum([
  "CONSENT_PENDING",
  "PUBLIC_EVIDENCE",
  "INTERVIEW",
  "DRAFT_REVIEW",
  "CONFIRMED",
  "REVISION_DRAFT",
  "DELETION_REQUESTED",
]);
export type FounderSetupState = z.infer<typeof FounderSetupStateSchema>;

export const FounderSetupRunSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    setupRunId: EntityIdSchema,
    founderId: EntityIdSchema,
    state: FounderSetupStateSchema,
    version: z.number().int().positive(),
    stateData: z.record(z.string(), z.unknown()),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type FounderSetupRun = z.infer<typeof FounderSetupRunSchema>;

export const ConsentScopeSchema = z.enum([
  "read_public_professional_profile",
  "retain_minimized_profile_evidence",
  "retain_minimized_founder_self_report",
  "retain_minimized_founder_snapshot",
  "retain_founder_version_history",
  "use_confirmed_founder_snapshot_for_research",
]);
export type ConsentScope = z.infer<typeof ConsentScopeSchema>;

export const ConsentStatusSchema = z.enum(["active", "revoked", "declined"]);
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

export const ConsentRecordSchema = z
  .object({
    consentId: EntityIdSchema,
    setupRunId: EntityIdSchema,
    founderId: EntityIdSchema,
    scope: ConsentScopeSchema,
    status: ConsentStatusSchema,
    sourceUrls: z.array(z.httpUrl()),
    recordedAt: IsoDateTimeSchema,
    grantedAt: IsoDateTimeSchema.optional(),
    revokedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine(({ status, grantedAt, revokedAt }, context) => {
    if (status === "active" && grantedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["grantedAt"],
        message: "active consent requires grantedAt",
      });
    }
    if (status === "revoked" && revokedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "revoked consent requires revokedAt",
      });
    }
  });
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

export const DeletionStatusSchema = z.enum([
  "pending",
  "pending_expiry",
  "completed",
  "failed",
  "unverifiable",
]);
export type DeletionStatus = z.infer<typeof DeletionStatusSchema>;

export const DeletionSystemStatusSchema = z
  .object({
    system: NonEmptyStringSchema,
    status: DeletionStatusSchema,
    reason: NonEmptyStringSchema,
    checkedAt: IsoDateTimeSchema,
  })
  .strict();
export type DeletionSystemStatus = z.infer<typeof DeletionSystemStatusSchema>;

export const DeletionRecordSchema = z
  .object({
    deletionRequestId: EntityIdSchema,
    setupRunId: EntityIdSchema,
    founderId: EntityIdSchema,
    requestedAt: IsoDateTimeSchema,
    reason: NonEmptyStringSchema,
    status: DeletionStatusSchema,
    systems: z.array(DeletionSystemStatusSchema).min(1),
  })
  .strict();
export type DeletionRecord = z.infer<typeof DeletionRecordSchema>;

export interface RecordOrigin extends DataStoreStatus {
  readonly isSynthetic: boolean;
  readonly source: DataSource;
}

export interface StoredRecord<T> extends RecordOrigin {
  readonly value: T;
}

export interface StoredEvidenceRecord<T> extends StoredRecord<T> {
  readonly setupRunId: string;
}

export interface StoredFounderProfileRecord<T> extends StoredRecord<T> {
  readonly setupRunId: string;
}

export interface StoredResearchBundleRecord<T> extends StoredRecord<T> {
  readonly setupRunId: string;
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const IDEMPOTENT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const DESTRUCTIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
