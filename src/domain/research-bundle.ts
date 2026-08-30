import { z } from "zod";
import { type ClaimSet, flattenClaimSet } from "./claims.js";
import {
  DateRangeSchema,
  EntityIdSchema,
  hasUniqueValues,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from "./common.js";
import { type EvidenceItem, EvidenceItemSchema } from "./evidence.js";
import { ConfirmedFounderProfileSnapshotSchema } from "./founder-profile.js";
import { MarketSignalSchema } from "./market-signal.js";
import {
  claimSetsInOpportunity,
  type OpportunityClaimSources,
  OpportunityDossierSchema,
} from "./opportunity-dossier.js";

interface BundleClaimSources {
  founderProfile: { claims: ClaimSet };
  marketSignals: Array<{ claims: ClaimSet }>;
  opportunities: OpportunityClaimSources[];
}

function claimSetsInBundle(bundle: BundleClaimSources): ClaimSet[] {
  return [
    bundle.founderProfile.claims,
    ...bundle.marketSignals.map(({ claims }) => claims),
    ...bundle.opportunities.flatMap(claimSetsInOpportunity),
  ];
}

interface TimedEvidenceReference {
  readonly id: string;
  readonly path: (string | number)[];
  readonly consumedAt: string;
  readonly postdatedMessage: string;
}

function findPostdatedEvidence(
  evidenceById: ReadonlyMap<string, EvidenceItem>,
  references: readonly TimedEvidenceReference[],
): Array<Pick<TimedEvidenceReference, "path" | "postdatedMessage">> {
  return references.flatMap((reference) => {
    const evidence = evidenceById.get(reference.id);
    return evidence !== undefined &&
      Date.parse(evidence.provenance.retrievedAt) > Date.parse(reference.consumedAt)
      ? [{ path: reference.path, postdatedMessage: reference.postdatedMessage }]
      : [];
  });
}

export const ResearchBundleSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    bundleId: EntityIdSchema,
    bundleVersion: z.number().int().positive(),
    runId: EntityIdSchema,
    founderProfile: ConfirmedFounderProfileSnapshotSchema,
    researchWindow: DateRangeSchema,
    evidence: z.array(EvidenceItemSchema),
    marketSignals: z.array(MarketSignalSchema),
    opportunities: z.array(OpportunityDossierSchema),
    generatedAt: IsoDateTimeSchema,
    warnings: z.array(NonEmptyStringSchema).default([]),
  })
  .strict()
  .superRefine((bundle, context) => {
    const evidenceIds = bundle.evidence.map(({ evidenceId }) => evidenceId);
    const signalIds = bundle.marketSignals.map(({ signalId }) => signalId);
    const opportunityIds = bundle.opportunities.map(({ opportunityId }) => opportunityId);
    const hypothesisIds = bundle.opportunities.map(
      ({ scarcityHypothesis }) => scarcityHypothesis.hypothesisId,
    );

    for (const [path, ids] of [
      [["evidence"], evidenceIds],
      [["marketSignals"], signalIds],
      [["opportunities"], opportunityIds],
      [["opportunities"], hypothesisIds],
    ] as const) {
      if (!hasUniqueValues(ids)) {
        context.addIssue({ code: "custom", path: [...path], message: "entity IDs must be unique" });
      }
    }

    const knownEvidenceIds = new Set(evidenceIds);
    const referencedEvidence: Array<{ id: string; path: (string | number)[] }> = [
      ...bundle.founderProfile.sourceEvidenceIds.map((id, index) => ({
        id,
        path: ["founderProfile", "sourceEvidenceIds", index],
      })),
      ...bundle.founderProfile.competencies.flatMap((competency, competencyIndex) =>
        competency.evidenceIds.map((id, index) => ({
          id,
          path: ["founderProfile", "competencies", competencyIndex, "evidenceIds", index],
        })),
      ),
      ...bundle.marketSignals.flatMap((signal, signalIndex) =>
        signal.evidenceIds.map((id, index) => ({
          id,
          path: ["marketSignals", signalIndex, "evidenceIds", index],
        })),
      ),
      ...bundle.opportunities.flatMap((opportunity, opportunityIndex) =>
        opportunity.evidenceIds.map((id, index) => ({
          id,
          path: ["opportunities", opportunityIndex, "evidenceIds", index],
        })),
      ),
      ...claimSetsInBundle(bundle).flatMap((claimSet) =>
        flattenClaimSet(claimSet).flatMap((claim) =>
          claim.evidenceIds.map((id) => ({ id, path: ["claims", claim.claimId, "evidenceIds"] })),
        ),
      ),
    ];

    for (const reference of referencedEvidence) {
      if (!knownEvidenceIds.has(reference.id)) {
        context.addIssue({
          code: "custom",
          path: reference.path,
          message: `unknown evidenceId: ${reference.id}`,
        });
      }
    }

    const evidenceById = new Map(
      bundle.evidence.map((evidence) => [evidence.evidenceId, evidence]),
    );
    // Each artifact schema requires every nested claim citation to be present
    // in its aggregate evidenceIds, so these checks cover direct and nested
    // evidence without relying on the weaker bundle.generatedAt boundary.
    const timedEvidenceReferences: TimedEvidenceReference[] = [
      ...bundle.founderProfile.sourceEvidenceIds.map((evidenceId, index) => ({
        id: evidenceId,
        path: ["founderProfile", "sourceEvidenceIds", index],
        consumedAt: bundle.founderProfile.confirmedAt,
        postdatedMessage: `founder evidence ${evidenceId} was retrieved after the profile was confirmed`,
      })),
      ...bundle.marketSignals.flatMap((signal, signalIndex) =>
        signal.evidenceIds.map((evidenceId, evidenceIndex) => ({
          id: evidenceId,
          path: ["marketSignals", signalIndex, "evidenceIds", evidenceIndex],
          consumedAt: signal.calculatedAt,
          postdatedMessage: `signal evidence ${evidenceId} was retrieved after the signal was calculated`,
        })),
      ),
      ...bundle.opportunities.flatMap((opportunity, opportunityIndex) =>
        opportunity.evidenceIds.map((evidenceId, evidenceIndex) => ({
          id: evidenceId,
          path: ["opportunities", opportunityIndex, "evidenceIds", evidenceIndex],
          consumedAt: opportunity.generatedAt,
          postdatedMessage: `opportunity evidence ${evidenceId} was retrieved after the dossier was generated`,
        })),
      ),
    ];
    for (const issue of findPostdatedEvidence(evidenceById, timedEvidenceReferences)) {
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.postdatedMessage,
      });
    }

    const allClaims = claimSetsInBundle(bundle).flatMap(flattenClaimSet);
    const claimIds = allClaims.map(({ claimId }) => claimId);
    if (!hasUniqueValues(claimIds)) {
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "claimIds must be unique within a research bundle",
      });
    }

    const containedTimestamps = [
      bundle.researchWindow.end,
      bundle.founderProfile.capturedAt,
      ...(bundle.founderProfile.confirmedAt === undefined
        ? []
        : [bundle.founderProfile.confirmedAt]),
      ...bundle.evidence.map(({ provenance }) => provenance.retrievedAt),
      ...bundle.marketSignals.map(({ calculatedAt }) => calculatedAt),
      ...bundle.opportunities.map(({ generatedAt }) => generatedAt),
      ...allClaims.map(({ createdAt }) => createdAt),
    ];
    if (
      containedTimestamps.some(
        (timestamp) => Date.parse(timestamp) > Date.parse(bundle.generatedAt),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["generatedAt"],
        message: "generatedAt must be at or after every contained artifact timestamp",
      });
    }

    const signalById = new Map(bundle.marketSignals.map((signal) => [signal.signalId, signal]));
    for (const [opportunityIndex, opportunity] of bundle.opportunities.entries()) {
      if (opportunity.founderProfileSnapshotId !== bundle.founderProfile.snapshotId) {
        context.addIssue({
          code: "custom",
          path: ["opportunities", opportunityIndex, "founderProfileSnapshotId"],
          message: "founderProfileSnapshotId does not match the bundled founder profile",
        });
      }

      if (Date.parse(bundle.founderProfile.confirmedAt) > Date.parse(opportunity.generatedAt)) {
        context.addIssue({
          code: "custom",
          path: ["opportunities", opportunityIndex, "generatedAt"],
          message: "opportunity must be generated after the founder profile was confirmed",
        });
      }

      for (const [signalIndex, signalId] of opportunity.marketSignalIds.entries()) {
        const signal = signalById.get(signalId);
        if (signal === undefined) {
          context.addIssue({
            code: "custom",
            path: ["opportunities", opportunityIndex, "marketSignalIds", signalIndex],
            message: `unknown marketSignalId: ${signalId}`,
          });
        } else if (Date.parse(signal.calculatedAt) > Date.parse(opportunity.generatedAt)) {
          context.addIssue({
            code: "custom",
            path: ["opportunities", opportunityIndex, "marketSignalIds", signalIndex],
            message: `market signal ${signalId} was calculated after the dossier was generated`,
          });
        }
      }
    }
  });

export type ResearchBundle = z.infer<typeof ResearchBundleSchema>;
