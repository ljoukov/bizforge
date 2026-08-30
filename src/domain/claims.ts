import { z } from "zod";

import {
  ConfidenceBoundsSchema,
  EntityIdSchema,
  hasUniqueValues,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from "./common.js";

export const EvidenceIdSchema = EntityIdSchema;

const ClaimBaseShape = {
  claimId: EntityIdSchema,
  statement: NonEmptyStringSchema,
  createdAt: IsoDateTimeSchema,
};

const SupportedEvidenceIdsSchema = z
  .array(EvidenceIdSchema)
  .min(1)
  .refine(hasUniqueValues, "evidenceIds must not contain duplicates");

/** A direct description of supplied evidence. It must cite at least one evidence item. */
export const ObservedClaimSchema = z
  .object({
    ...ClaimBaseShape,
    kind: z.literal("observed"),
    evidenceIds: SupportedEvidenceIdsSchema,
    confidence: ConfidenceBoundsSchema,
  })
  .strict();

/** A conclusion drawn from evidence. The rationale makes that reasoning inspectable. */
export const InferredClaimSchema = z
  .object({
    ...ClaimBaseShape,
    kind: z.literal("inferred"),
    evidenceIds: SupportedEvidenceIdsSchema,
    rationale: NonEmptyStringSchema,
    confidence: ConfidenceBoundsSchema,
  })
  .strict();

/** An unverified proposition. Citing evidence would misrepresent it as an inference. */
export const AssumptionClaimSchema = z
  .object({
    ...ClaimBaseShape,
    kind: z.literal("assumption"),
    evidenceIds: z.array(EvidenceIdSchema).max(0).default([]),
    rationale: NonEmptyStringSchema,
    validationPlan: NonEmptyStringSchema,
    confidence: ConfidenceBoundsSchema,
  })
  .strict();

export const ClaimSchema = z.discriminatedUnion("kind", [
  ObservedClaimSchema,
  InferredClaimSchema,
  AssumptionClaimSchema,
]);

/**
 * Persist claims in separate collections so consumers cannot accidentally render an
 * assumption with the same evidentiary status as an observation.
 */
export const ClaimSetSchema = z
  .object({
    observed: z.array(ObservedClaimSchema).default([]),
    inferred: z.array(InferredClaimSchema).default([]),
    assumptions: z.array(AssumptionClaimSchema).default([]),
  })
  .strict()
  .superRefine(({ observed, inferred, assumptions }, context) => {
    const ids = [...observed, ...inferred, ...assumptions].map(({ claimId }) => claimId);
    if (!hasUniqueValues(ids)) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "claimIds must be unique within a claim set",
      });
    }
  });

/** A narrative claim group must not silently rely on prose without epistemic status. */
export const NonEmptyClaimSetSchema = ClaimSetSchema.refine(
  ({ observed, inferred, assumptions }) =>
    observed.length + inferred.length + assumptions.length > 0,
  "at least one observed, inferred, or assumption claim is required",
);

export function flattenClaimSet(claims: ClaimSet): Claim[] {
  return [...claims.observed, ...claims.inferred, ...claims.assumptions];
}

export type ObservedClaim = z.infer<typeof ObservedClaimSchema>;
export type InferredClaim = z.infer<typeof InferredClaimSchema>;
export type AssumptionClaim = z.infer<typeof AssumptionClaimSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimSet = z.infer<typeof ClaimSetSchema>;
