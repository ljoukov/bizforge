import { z } from "zod";
import { EvidenceIdSchema } from "./claims.js";
import {
  EntityIdSchema,
  HttpUrlSchema,
  hasUniqueValues,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from "./common.js";

export const EvidenceTypeSchema = z.enum([
  "job_posting",
  "company_profile",
  "funding_event",
  "article",
  "website",
  "market_report",
  "user_input",
  "other",
]);

export const SourceProvenanceSchema = z
  .object({
    provider: NonEmptyStringSchema,
    collectionMethod: z.enum([
      "bright_data",
      "first_party_api",
      "public_web",
      "user_input",
      "manual_import",
    ]),
    canonicalUrl: HttpUrlSchema.optional(),
    sourceRecordId: NonEmptyStringSchema.optional(),
    datasetId: NonEmptyStringSchema.optional(),
    snapshotId: NonEmptyStringSchema.optional(),
    queryId: EntityIdSchema.optional(),
    retrievedAt: IsoDateTimeSchema,
    publishedAt: IsoDateTimeSchema.optional(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 hex digest"),
  })
  .strict()
  .superRefine(({ canonicalUrl, sourceRecordId, publishedAt, retrievedAt }, context) => {
    if (canonicalUrl === undefined && sourceRecordId === undefined) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "canonicalUrl or sourceRecordId is required",
      });
    }

    if (publishedAt !== undefined && Date.parse(publishedAt) > Date.parse(retrievedAt)) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "publishedAt must not be after retrievedAt",
      });
    }
  });

const AttributeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const EvidenceLocatorSchema = z
  .object({
    jsonPointer: NonEmptyStringSchema.optional(),
    excerpt: NonEmptyStringSchema.max(1_000).optional(),
    recordIndex: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine(({ jsonPointer, excerpt, recordIndex }, context) => {
    if (jsonPointer === undefined && excerpt === undefined && recordIndex === undefined) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "at least one raw-record locator is required",
      });
    }
  });

export const ExtractionProvenanceSchema = z
  .object({
    method: z.enum(["parser", "agent", "manual"]),
    version: NonEmptyStringSchema,
    agentSessionId: EntityIdSchema.optional(),
    agentTurnId: EntityIdSchema.optional(),
  })
  .strict()
  .superRefine(({ method, agentSessionId, agentTurnId }, context) => {
    if (method === "agent" && (agentSessionId === undefined || agentTurnId === undefined)) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "agent extraction requires both agentSessionId and agentTurnId",
      });
    }
  });

export const EvidenceItemSchema = z
  .object({
    evidenceId: EvidenceIdSchema,
    evidenceType: EvidenceTypeSchema,
    title: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    provenance: SourceProvenanceSchema,
    observedAt: IsoDateTimeSchema.optional(),
    rawArtifactRef: NonEmptyStringSchema,
    locator: EvidenceLocatorSchema,
    extraction: ExtractionProvenanceSchema,
    attributes: z.record(z.string(), AttributeValueSchema).default({}),
    tags: z
      .array(NonEmptyStringSchema)
      .refine(hasUniqueValues, "tags must not contain duplicates")
      .default([]),
  })
  .strict()
  .superRefine(({ observedAt, provenance }, context) => {
    if (observedAt !== undefined && Date.parse(observedAt) > Date.parse(provenance.retrievedAt)) {
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "observedAt must not be after provenance.retrievedAt",
      });
    }
  });

export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type SourceProvenance = z.infer<typeof SourceProvenanceSchema>;
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;
export type ExtractionProvenance = z.infer<typeof ExtractionProvenanceSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
