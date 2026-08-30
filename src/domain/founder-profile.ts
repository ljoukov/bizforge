import { z } from "zod";
import { ClaimSetSchema, EvidenceIdSchema, flattenClaimSet } from "./claims.js";
import {
  ConfidenceBoundsSchema,
  EntityIdSchema,
  HttpUrlSchema,
  hasUniqueValues,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from "./common.js";

export const FounderCompetencySchema = z
  .object({
    name: NonEmptyStringSchema,
    level: z.enum(["learning", "working", "advanced", "expert"]),
    yearsExperience: z.number().min(0).max(80).optional(),
    evidenceIds: z
      .array(EvidenceIdSchema)
      .refine(hasUniqueValues, "evidenceIds must not contain duplicates")
      .default([]),
    confidence: ConfidenceBoundsSchema,
  })
  .strict();

export const BusinessAppetiteSchema = z
  .object({
    hoursPerWeek: z.number().positive().max(168),
    capitalBudgetUsd: z.number().nonnegative(),
    timeToFirstRevenueDays: z.number().int().positive(),
    teamSize: z.number().int().positive(),
    preferredOfferTypes: z
      .array(z.enum(["software", "service", "hybrid"]))
      .min(1)
      .refine(hasUniqueValues, "preferredOfferTypes must not contain duplicates"),
    preferredCustomerTypes: z
      .array(z.enum(["consumer", "smb", "mid_market", "enterprise", "public_sector"]))
      .min(1)
      .refine(hasUniqueValues, "preferredCustomerTypes must not contain duplicates"),
    salesTolerance: z.enum(["low", "medium", "high"]),
    riskTolerance: z.enum(["low", "medium", "high"]),
    regulatoryTolerance: z.enum(["low", "medium", "high"]),
  })
  .strict();

export const FounderProfileSnapshotSchema = z
  .object({
    snapshotId: EntityIdSchema,
    founderId: EntityIdSchema,
    displayName: NonEmptyStringSchema.optional(),
    publicProfileUrl: HttpUrlSchema.optional(),
    competencies: z.array(FounderCompetencySchema).min(1),
    businessAppetite: BusinessAppetiteSchema,
    constraints: z.array(NonEmptyStringSchema).default([]),
    accessAdvantages: z.array(NonEmptyStringSchema).default([]),
    sourceEvidenceIds: z
      .array(EvidenceIdSchema)
      .refine(hasUniqueValues, "sourceEvidenceIds must not contain duplicates")
      .default([]),
    claims: ClaimSetSchema,
    capturedAt: IsoDateTimeSchema,
    confirmedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine(({ capturedAt, confirmedAt, sourceEvidenceIds, competencies, claims }, context) => {
    if (confirmedAt !== undefined && Date.parse(confirmedAt) < Date.parse(capturedAt)) {
      context.addIssue({
        code: "custom",
        path: ["confirmedAt"],
        message: "confirmedAt must be at or after capturedAt",
      });
    }

    const allowedEvidenceIds = new Set(sourceEvidenceIds);
    const nestedEvidenceReferences = [
      ...competencies.flatMap(({ evidenceIds }) => evidenceIds),
      ...flattenClaimSet(claims).flatMap(({ evidenceIds }) => evidenceIds),
    ];
    for (const evidenceId of nestedEvidenceReferences) {
      if (!allowedEvidenceIds.has(evidenceId)) {
        context.addIssue({
          code: "custom",
          path: ["sourceEvidenceIds"],
          message: `nested evidence ${evidenceId} is missing from sourceEvidenceIds`,
        });
      }
    }

    const snapshotCompleteAt = confirmedAt ?? capturedAt;
    for (const claim of flattenClaimSet(claims)) {
      if (Date.parse(claim.createdAt) > Date.parse(snapshotCompleteAt)) {
        context.addIssue({
          code: "custom",
          path: ["claims", claim.claimId, "createdAt"],
          message: "claim createdAt must not be after the founder profile snapshot",
        });
      }
    }
  });

/**
 * Stage 2 consumes only a user-confirmed snapshot. Its evidence ledger is
 * exhaustive: every confirmed competency is supported and every ledger entry
 * is used by a competency or profile claim.
 */
export const ConfirmedFounderProfileSnapshotSchema = z
  .intersection(FounderProfileSnapshotSchema, z.object({ confirmedAt: IsoDateTimeSchema }))
  .superRefine(({ competencies, sourceEvidenceIds, claims }, context) => {
    for (const [index, competency] of competencies.entries()) {
      if (competency.evidenceIds.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["competencies", index, "evidenceIds"],
          message: "a confirmed competency requires at least one evidence item",
        });
      }
    }

    const nestedEvidenceIds = new Set([
      ...competencies.flatMap(({ evidenceIds }) => evidenceIds),
      ...flattenClaimSet(claims).flatMap(({ evidenceIds }) => evidenceIds),
    ]);
    for (const [index, evidenceId] of sourceEvidenceIds.entries()) {
      if (!nestedEvidenceIds.has(evidenceId)) {
        context.addIssue({
          code: "custom",
          path: ["sourceEvidenceIds", index],
          message: `source evidence ${evidenceId} is not referenced by a competency or profile claim`,
        });
      }
    }
  });

export type FounderCompetency = z.infer<typeof FounderCompetencySchema>;
export type BusinessAppetite = z.infer<typeof BusinessAppetiteSchema>;
export type FounderProfileSnapshot = z.infer<typeof FounderProfileSnapshotSchema>;
export type ConfirmedFounderProfileSnapshot = z.infer<typeof ConfirmedFounderProfileSnapshotSchema>;
