import { z } from "zod";
import {
  type ClaimSet,
  ClaimSetSchema,
  EvidenceIdSchema,
  flattenClaimSet,
  NonEmptyClaimSetSchema,
} from "./claims.js";
import {
  ConfidenceBoundsSchema,
  EntityIdSchema,
  hasUniqueValues,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from "./common.js";

export interface ScarcityClaimSources {
  claims: ClaimSet;
  aiIntervention: { claims: ClaimSet };
  successorBottleneck: { claims: ClaimSet };
}

export function claimSetsInScarcityHypothesis(hypothesis: ScarcityClaimSources): ClaimSet[] {
  return [
    hypothesis.claims,
    hypothesis.aiIntervention.claims,
    hypothesis.successorBottleneck.claims,
  ];
}

export interface OpportunityClaimSources {
  scarcityHypothesis: ScarcityClaimSources;
  offering: { claims: ClaimSet };
  founderFit: { claims: ClaimSet };
  defensibilityClaims: ClaimSet;
  counterEvidence: { claims: ClaimSet };
}

/** The single registry of every claim-bearing section in an opportunity dossier. */
export function claimSetsInOpportunity(opportunity: OpportunityClaimSources): ClaimSet[] {
  return [
    ...claimSetsInScarcityHypothesis(opportunity.scarcityHypothesis),
    opportunity.offering.claims,
    opportunity.founderFit.claims,
    opportunity.defensibilityClaims,
    opportunity.counterEvidence.claims,
  ];
}

const EmptyClaimSetSchema = ClaimSetSchema.refine(
  (claims) => flattenClaimSet(claims).length === 0,
  "claims must be empty when no counter-evidence was found",
);

export const CounterEvidenceSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("FOUND"),
      searchSummary: NonEmptyStringSchema,
      claims: NonEmptyClaimSetSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("NOT_FOUND"),
      searchSummary: NonEmptyStringSchema,
      warning: NonEmptyStringSchema,
      claims: EmptyClaimSetSchema,
    })
    .strict(),
]);

export const ValueChainStageSchema = z
  .object({
    stageId: EntityIdSchema,
    name: NonEmptyStringSchema,
    actor: NonEmptyStringSchema,
    input: NonEmptyStringSchema,
    output: NonEmptyStringSchema,
    currentProcess: NonEmptyStringSchema,
  })
  .strict();

export const ScarcityHypothesisSchema = z
  .object({
    hypothesisId: EntityIdSchema,
    title: NonEmptyStringSchema,
    market: NonEmptyStringSchema,
    valueChain: z.array(ValueChainStageSchema).min(1),
    scarceResource: NonEmptyStringSchema,
    scarcityMechanism: NonEmptyStringSchema,
    claims: ClaimSetSchema,
    aiIntervention: z
      .object({
        description: NonEmptyStringSchema,
        makesAbundant: NonEmptyStringSchema,
        collapsedStageIds: z
          .array(EntityIdSchema)
          .refine(hasUniqueValues, "collapsedStageIds must not contain duplicates")
          .default([]),
        claims: NonEmptyClaimSetSchema,
      })
      .strict(),
    abundantOutcome: NonEmptyStringSchema,
    directBeneficiary: NonEmptyStringSchema,
    economicBuyer: NonEmptyStringSchema,
    successorBottleneck: z
      .object({
        description: NonEmptyStringSchema,
        claims: NonEmptyClaimSetSchema,
      })
      .strict(),
    confidence: ConfidenceBoundsSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((hypothesis, context) => {
    const { valueChain, claims, aiIntervention, createdAt } = hypothesis;
    const stageIds = valueChain.map(({ stageId }) => stageId);
    if (!hasUniqueValues(stageIds)) {
      context.addIssue({
        code: "custom",
        path: ["valueChain"],
        message: "stageIds must be unique within a value chain",
      });
    }

    for (const [index, stageId] of aiIntervention.collapsedStageIds.entries()) {
      if (!stageIds.includes(stageId)) {
        context.addIssue({
          code: "custom",
          path: ["aiIntervention", "collapsedStageIds", index],
          message: `unknown value-chain stage: ${stageId}`,
        });
      }
    }

    if (claims.observed.length === 0 || claims.inferred.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "a scarcity hypothesis requires both observed evidence and an explicit inference",
      });
    }

    const hypothesisClaims = claimSetsInScarcityHypothesis(hypothesis).flatMap(flattenClaimSet);
    const hypothesisClaimIds = hypothesisClaims.map(({ claimId }) => claimId);
    if (!hasUniqueValues(hypothesisClaimIds)) {
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "claimIds must be unique within a scarcity hypothesis",
      });
    }

    for (const claim of hypothesisClaims) {
      if (Date.parse(claim.createdAt) > Date.parse(createdAt)) {
        context.addIssue({
          code: "custom",
          path: ["claims", claim.claimId, "createdAt"],
          message: "claim createdAt must not be after the scarcity hypothesis",
        });
      }
    }
  });

export const OpportunityDossierSchema = z
  .object({
    opportunityId: EntityIdSchema,
    founderProfileSnapshotId: EntityIdSchema,
    title: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    marketSignalIds: z
      .array(EntityIdSchema)
      .min(1)
      .refine(hasUniqueValues, "marketSignalIds must not contain duplicates"),
    evidenceIds: z
      .array(EvidenceIdSchema)
      .min(1)
      .refine(hasUniqueValues, "evidenceIds must not contain duplicates"),
    scarcityHypothesis: ScarcityHypothesisSchema,
    offering: z
      .object({
        description: NonEmptyStringSchema,
        smallestSellableWedge: NonEmptyStringSchema,
        revenueModel: NonEmptyStringSchema,
        valueCaptureMechanism: NonEmptyStringSchema,
        claims: NonEmptyClaimSetSchema,
      })
      .strict(),
    founderFit: z
      .object({
        rating: z.enum(["weak", "plausible", "strong"]),
        explanation: NonEmptyStringSchema,
        claims: NonEmptyClaimSetSchema,
      })
      .strict(),
    defensibilityClaims: NonEmptyClaimSetSchema,
    counterEvidence: CounterEvidenceSchema,
    falsificationExperiment: z
      .object({
        assumptionClaimIds: z
          .array(EntityIdSchema)
          .min(1)
          .refine(hasUniqueValues, "assumptionClaimIds must not contain duplicates"),
        method: NonEmptyStringSchema,
        successCriterion: NonEmptyStringSchema,
        failureCriterion: NonEmptyStringSchema,
        maximumDurationDays: z.number().int().positive(),
        maximumBudgetUsd: z.number().nonnegative(),
      })
      .strict(),
    confidence: ConfidenceBoundsSchema,
    generatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((dossier, context) => {
    const claimSets = claimSetsInOpportunity(dossier);
    const claims = claimSets.flatMap(flattenClaimSet);
    const assumptionIds = new Set(
      claims.filter(({ kind }) => kind === "assumption").map(({ claimId }) => claimId),
    );

    const claimIds = claims.map(({ claimId }) => claimId);
    if (!hasUniqueValues(claimIds)) {
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "claimIds must be unique within an opportunity dossier",
      });
    }

    const allowedEvidenceIds = new Set(dossier.evidenceIds);
    for (const claim of claims) {
      for (const evidenceId of claim.evidenceIds) {
        if (!allowedEvidenceIds.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            path: ["claims", claim.claimId, "evidenceIds"],
            message: `claim evidence ${evidenceId} is missing from the opportunity evidenceIds`,
          });
        }
      }

      if (Date.parse(claim.createdAt) > Date.parse(dossier.generatedAt)) {
        context.addIssue({
          code: "custom",
          path: ["claims", claim.claimId, "createdAt"],
          message: "claim createdAt must not be after the opportunity dossier",
        });
      }
    }

    if (Date.parse(dossier.scarcityHypothesis.createdAt) > Date.parse(dossier.generatedAt)) {
      context.addIssue({
        code: "custom",
        path: ["generatedAt"],
        message: "generatedAt must be at or after the scarcity hypothesis",
      });
    }

    for (const [index, claimId] of dossier.falsificationExperiment.assumptionClaimIds.entries()) {
      if (!assumptionIds.has(claimId)) {
        context.addIssue({
          code: "custom",
          path: ["falsificationExperiment", "assumptionClaimIds", index],
          message: `unknown assumption claim: ${claimId}`,
        });
      }
    }
  });

export type ValueChainStage = z.infer<typeof ValueChainStageSchema>;
export type ScarcityHypothesis = z.infer<typeof ScarcityHypothesisSchema>;
export type CounterEvidence = z.infer<typeof CounterEvidenceSchema>;
export type OpportunityDossier = z.infer<typeof OpportunityDossierSchema>;
