import { describe, expect, it } from "vitest";

import {
  AssumptionClaimSchema,
  ClaimSetSchema,
  ConfirmedFounderProfileSnapshotSchema,
  ConfidenceBoundsSchema,
  DateRangeSchema,
  EvidenceItemSchema,
  MarketSignalSchema,
  OpportunityDossierSchema,
  ResearchBundleSchema,
  SourceProvenanceSchema,
} from "../../src/domain/index.js";

const earlier = "2026-08-01T00:00:00Z";
const now = "2026-08-29T12:00:00Z";
const hash = "a".repeat(64);
const confidence = { lower: 0.6, estimate: 0.75, upper: 0.85 };

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) {
    throw new Error("test fixture unexpectedly contained an empty array");
  }
  return value;
}

const observedClaim = (claimId: string, evidenceIds = ["evidence-1"]) => ({
  claimId,
  kind: "observed" as const,
  statement: "The current collection contains repeated demand for this work.",
  evidenceIds,
  confidence,
  createdAt: now,
});

const inferredClaim = (claimId: string, evidenceIds = ["evidence-1"]) => ({
  claimId,
  kind: "inferred" as const,
  statement: "The repeated demand indicates a constrained workflow.",
  evidenceIds,
  rationale: "Multiple independent observations point to the same workflow constraint.",
  confidence,
  createdAt: now,
});

const assumptionClaim = (claimId: string) => ({
  claimId,
  kind: "assumption" as const,
  statement: "The budget owner will pay for an outcome rather than more tooling.",
  evidenceIds: [],
  rationale: "No buyer interview has tested willingness to pay yet.",
  validationPlan: "Interview five budget owners and ask for a paid pilot.",
  confidence: { lower: 0.2, estimate: 0.4, upper: 0.6 },
  createdAt: now,
});

const emptyClaims = () => ({ observed: [], inferred: [], assumptions: [] });

const makeEvidence = () => ({
  evidenceId: "evidence-1",
  evidenceType: "job_posting" as const,
  title: "University video producer role",
  summary: "The role owns production and multi-channel distribution.",
  provenance: {
    provider: "Bright Data",
    collectionMethod: "bright_data" as const,
    canonicalUrl: "https://example.com/jobs/1",
    sourceRecordId: "job-1",
    datasetId: "linkedin-jobs",
    snapshotId: "snapshot-1",
    queryId: "query-1",
    retrievedAt: now,
    publishedAt: earlier,
    contentSha256: hash,
  },
  observedAt: earlier,
  rawArtifactRef: "raw/snapshot-1/job-1.json",
  locator: { jsonPointer: "/records/0", recordIndex: 0 },
  extraction: { method: "parser" as const, version: "linkedin-job-v1" },
  attributes: { employer: "Example University", remote: false },
  tags: ["video", "university"],
});

const makeSignal = () => ({
  signalId: "signal-1",
  market: "Higher education media teams",
  name: "Current demand for multi-channel video production",
  description: "A concentration signal, not a historical growth claim.",
  evidenceIds: ["evidence-1"],
  measurement: {
    metric: "matching_job_postings",
    value: 1,
    unit: "postings",
    direction: "concentrated" as const,
    currentWindow: { start: earlier, end: now },
    sampleSize: 1,
    methodology: "Count deduplicated postings matching the documented query.",
    coverageNote: "One source and one collection window; this cannot establish growth.",
    distinctEntityCount: 1,
  },
  claims: {
    observed: [observedClaim("claim-signal-observed")],
    inferred: [],
    assumptions: [],
  },
  confidence,
  calculatedAt: now,
});

const makeScarcityHypothesis = () => ({
  hypothesisId: "hypothesis-1",
  title: "Make compliant multi-format video output abundant",
  market: "Higher education media teams",
  valueChain: [
    {
      stageId: "stage-edit",
      name: "Edit source footage",
      actor: "Video producer",
      input: "Recorded footage",
      output: "Edited master",
      currentProcess: "A producer manually edits each master.",
    },
    {
      stageId: "stage-reformat",
      name: "Prepare channel variants",
      actor: "Video producer",
      input: "Edited master",
      output: "Approved social variants",
      currentProcess: "A producer manually reformats and checks each channel variant.",
    },
  ],
  scarceResource: "Skilled producer time",
  scarcityMechanism: "The same small team edits, reformats, and checks every asset.",
  claims: {
    observed: [observedClaim("claim-scarcity-observed")],
    inferred: [inferredClaim("claim-scarcity-inferred")],
    assumptions: [],
  },
  aiIntervention: {
    description: "Generate channel-ready variants with policy checks from one approved master.",
    makesAbundant: "Compliant channel-ready variants",
    collapsedStageIds: ["stage-reformat"],
    claims: {
      observed: [],
      inferred: [],
      assumptions: [assumptionClaim("claim-intervention-assumption")],
    },
  },
  abundantOutcome: "Approved campaign assets for every required channel",
  directBeneficiary: "University communications team",
  economicBuyer: "Director of communications",
  successorBottleneck: {
    description: "Institutional approval and rights clearance become the limiting step.",
    claims: {
      observed: [],
      inferred: [inferredClaim("claim-successor-inferred")],
      assumptions: [],
    },
  },
  confidence,
  createdAt: now,
});

const makeOpportunity = () => ({
  opportunityId: "opportunity-1",
  founderProfileSnapshotId: "profile-snapshot-1",
  title: "Compliant campaign output for university video teams",
  summary: "Sell approved multi-channel campaigns rather than cheaper editing.",
  marketSignalIds: ["signal-1"],
  evidenceIds: ["evidence-1"],
  scarcityHypothesis: makeScarcityHypothesis(),
  offering: {
    description: "A workflow that produces policy-checked channel variants.",
    smallestSellableWedge: "A paid pilot for one recorded university event.",
    revenueModel: "Per-campaign service with a software-assisted margin.",
    valueCaptureMechanism: "Own the approval policy layer and institutional workflow history.",
    claims: {
      observed: [],
      inferred: [inferredClaim("claim-offering-inferred")],
      assumptions: [],
    },
  },
  founderFit: {
    rating: "strong" as const,
    explanation: "The founder can build and operate the automation.",
    claims: {
      observed: [],
      inferred: [inferredClaim("claim-founder-fit-inferred")],
      assumptions: [],
    },
  },
  defensibilityClaims: {
    observed: [],
    inferred: [],
    assumptions: [assumptionClaim("claim-defensibility-assumption")],
  },
  counterEvidence: {
    status: "NOT_FOUND" as const,
    searchSummary: "Reviewed the bounded evidence set for disconfirming workflow evidence.",
    warning: "No counter-evidence was found in the limited current research window.",
    claims: emptyClaims(),
  },
  falsificationExperiment: {
    assumptionClaimIds: ["claim-intervention-assumption"],
    method: "Offer five communications directors a paid event pilot.",
    successCriterion: "At least one buyer pays for the pilot.",
    failureCriterion: "No buyer will enter a procurement conversation.",
    maximumDurationDays: 14,
    maximumBudgetUsd: 500,
  },
  confidence,
  generatedAt: now,
});

const makeBundle = () => ({
  schemaVersion: "1.0.0" as const,
  bundleId: "bundle-1",
  bundleVersion: 1,
  runId: "run-1",
  founderProfile: {
    snapshotId: "profile-snapshot-1",
    founderId: "founder-1",
    publicProfileUrl: "https://www.linkedin.com/in/example",
    competencies: [
      {
        name: "Software engineering",
        level: "advanced" as const,
        yearsExperience: 8,
        evidenceIds: ["evidence-1"],
        confidence,
      },
    ],
    businessAppetite: {
      hoursPerWeek: 20,
      capitalBudgetUsd: 5_000,
      timeToFirstRevenueDays: 45,
      teamSize: 1,
      preferredOfferTypes: ["hybrid" as const],
      preferredCustomerTypes: ["mid_market" as const, "public_sector" as const],
      salesTolerance: "medium" as const,
      riskTolerance: "medium" as const,
      regulatoryTolerance: "low" as const,
    },
    constraints: ["No regulated clinical decisions"],
    accessAdvantages: ["Existing relationships with university media teams"],
    sourceEvidenceIds: ["evidence-1"],
    claims: emptyClaims(),
    capturedAt: earlier,
    confirmedAt: now,
  },
  researchWindow: { start: earlier, end: now },
  evidence: [makeEvidence()],
  marketSignals: [makeSignal()],
  opportunities: [makeOpportunity()],
  generatedAt: now,
  warnings: [],
});

describe("epistemic claim contracts", () => {
  it("keeps assumptions evidence-free and gives them a validation plan", () => {
    expect(AssumptionClaimSchema.parse(assumptionClaim("claim-assumption"))).toMatchObject({
      kind: "assumption",
      evidenceIds: [],
    });

    expect(
      AssumptionClaimSchema.safeParse({
        ...assumptionClaim("claim-assumption"),
        evidenceIds: ["evidence-1"],
      }).success,
    ).toBe(false);
  });

  it("rejects inverted confidence bounds", () => {
    expect(
      ConfidenceBoundsSchema.safeParse({ lower: 0.8, estimate: 0.7, upper: 0.9 }).success,
    ).toBe(false);
    expect(
      ConfidenceBoundsSchema.safeParse({ lower: 0.2, estimate: 0.7, upper: 0.6 }).success,
    ).toBe(false);
  });

  it("rejects duplicate claim identifiers inside one claim set", () => {
    expect(
      ClaimSetSchema.safeParse({
        observed: [observedClaim("claim-duplicate")],
        inferred: [inferredClaim("claim-duplicate")],
        assumptions: [],
      }).success,
    ).toBe(false);
  });

  it("rejects an inverted date range", () => {
    expect(DateRangeSchema.safeParse({ start: now, end: earlier }).success).toBe(false);
  });
});

describe("source provenance", () => {
  it("requires a stable source locator and a valid collection timeline", () => {
    const provenance = makeEvidence().provenance;
    expect(SourceProvenanceSchema.safeParse(provenance).success).toBe(true);
    expect(
      SourceProvenanceSchema.safeParse({
        ...provenance,
        canonicalUrl: undefined,
        sourceRecordId: undefined,
      }).success,
    ).toBe(false);
    expect(
      SourceProvenanceSchema.safeParse({
        ...provenance,
        publishedAt: "2026-09-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields so secrets cannot leak into persisted provenance", () => {
    expect(
      EvidenceItemSchema.safeParse({
        ...makeEvidence(),
        provenance: { ...makeEvidence().provenance, apiKey: "must-not-persist" },
      }).success,
    ).toBe(false);
  });

  it("accepts only HTTP(S) source and profile links", () => {
    const evidence = makeEvidence();
    expect(
      EvidenceItemSchema.safeParse({
        ...evidence,
        provenance: { ...evidence.provenance, canonicalUrl: "javascript:alert(1)" },
      }).success,
    ).toBe(false);

    const bundle = makeBundle();
    bundle.founderProfile.publicProfileUrl = "data:text/html,unsafe";
    expect(ResearchBundleSchema.safeParse(bundle).success).toBe(false);
  });

  it("keeps normalized evidence traceable to an exact raw record and extraction run", () => {
    expect(EvidenceItemSchema.safeParse({ ...makeEvidence(), locator: {} }).success).toBe(false);
    expect(
      EvidenceItemSchema.safeParse({
        ...makeEvidence(),
        extraction: { method: "agent", version: "extractor-v1" },
      }).success,
    ).toBe(false);
  });
});

describe("confirmed founder boundary", () => {
  it("keeps drafts out of Stage 2 and requires evidence for every confirmed competency", () => {
    const profile = makeBundle().founderProfile;
    expect(ConfirmedFounderProfileSnapshotSchema.safeParse(profile).success).toBe(true);
    expect(
      ConfirmedFounderProfileSnapshotSchema.safeParse({
        ...profile,
        confirmedAt: undefined,
      }).success,
    ).toBe(false);
    expect(
      ConfirmedFounderProfileSnapshotSchema.safeParse({
        ...profile,
        competencies: profile.competencies.map((competency) => ({
          ...competency,
          evidenceIds: [],
        })),
        sourceEvidenceIds: [],
      }).success,
    ).toBe(false);
  });

  it("requires the confirmed source ledger to contain exactly the nested references", () => {
    const profile = makeBundle().founderProfile;
    expect(
      ConfirmedFounderProfileSnapshotSchema.safeParse({
        ...profile,
        sourceEvidenceIds: [...profile.sourceEvidenceIds, "evidence-unused"],
      }).success,
    ).toBe(false);
  });

  it("rejects an unconfirmed founder profile at the ResearchBundle boundary", () => {
    const bundle = makeBundle();
    expect(
      ResearchBundleSchema.safeParse({
        ...bundle,
        founderProfile: { ...bundle.founderProfile, confirmedAt: undefined },
      }).success,
    ).toBe(false);
  });

  it("rejects founder evidence collected after the user confirmed the snapshot", () => {
    const bundle = makeBundle();
    first(bundle.evidence).provenance.retrievedAt = "2026-08-29T13:00:00Z";
    bundle.generatedAt = "2026-08-29T13:00:00Z";

    const result = ResearchBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["founderProfile", "sourceEvidenceIds", 0],
          message: "founder evidence evidence-1 was retrieved after the profile was confirmed",
        }),
      );
    }
  });
});

describe("signal and opportunity contracts", () => {
  it("does not permit change metrics without a baseline window", () => {
    const signal = makeSignal();
    expect(
      MarketSignalSchema.safeParse({
        ...signal,
        measurement: { ...signal.measurement, percentageChange: 25 },
      }).success,
    ).toBe(false);
  });

  it("requires ordered windows and internally consistent trend arithmetic", () => {
    const signal = makeSignal();
    const trendMeasurement = {
      ...signal.measurement,
      value: 10,
      direction: "rising" as const,
      baselineWindow: {
        start: "2026-07-01T00:00:00Z",
        end: "2026-07-31T23:59:59Z",
      },
      baselineValue: 5,
      absoluteChange: 5,
      percentageChange: 100,
    };

    expect(MarketSignalSchema.safeParse({ ...signal, measurement: trendMeasurement }).success).toBe(
      true,
    );
    expect(
      MarketSignalSchema.safeParse({
        ...signal,
        measurement: { ...trendMeasurement, direction: "falling" },
      }).success,
    ).toBe(false);
    expect(
      MarketSignalSchema.safeParse({
        ...signal,
        measurement: {
          ...trendMeasurement,
          value: 0.30000000000000004,
          baselineValue: 0.3,
          direction: "stable",
          absoluteChange: undefined,
          percentageChange: undefined,
        },
      }).success,
    ).toBe(true);
    expect(
      MarketSignalSchema.safeParse({
        ...signal,
        measurement: {
          ...trendMeasurement,
          baselineWindow: {
            start: "2026-07-01T00:00:00Z",
            end: earlier,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      MarketSignalSchema.safeParse({
        ...signal,
        measurement: { ...trendMeasurement, absoluteChange: -5 },
      }).success,
    ).toBe(false);
    expect(
      MarketSignalSchema.safeParse({
        ...signal,
        measurement: {
          ...trendMeasurement,
          baselineWindow: { start: earlier, end: now },
        },
      }).success,
    ).toBe(false);
  });

  it("requires collapsed stages and falsified assumptions to resolve locally", () => {
    const opportunity = makeOpportunity();
    expect(OpportunityDossierSchema.safeParse(opportunity).success).toBe(true);
    expect(
      OpportunityDossierSchema.safeParse({
        ...opportunity,
        scarcityHypothesis: {
          ...opportunity.scarcityHypothesis,
          aiIntervention: {
            ...opportunity.scarcityHypothesis.aiIntervention,
            collapsedStageIds: ["missing-stage"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      OpportunityDossierSchema.safeParse({
        ...opportunity,
        falsificationExperiment: {
          ...opportunity.falsificationExperiment,
          assumptionClaimIds: ["missing-assumption"],
        },
      }).success,
    ).toBe(false);
  });

  it("requires epistemic claims for every narrative assertion", () => {
    const opportunity = makeOpportunity();
    opportunity.offering.claims = emptyClaims();
    expect(OpportunityDossierSchema.safeParse(opportunity).success).toBe(false);

    expect(
      OpportunityDossierSchema.safeParse({
        ...makeOpportunity(),
        counterEvidence: {
          status: "FOUND",
          searchSummary: "A search claims to have found disconfirming evidence.",
          claims: emptyClaims(),
        },
      }).success,
    ).toBe(false);
  });

  it("requires unique claim IDs and a closed opportunity evidence list", () => {
    const duplicateClaim = makeOpportunity();
    first(duplicateClaim.scarcityHypothesis.successorBottleneck.claims.inferred).claimId =
      "claim-scarcity-inferred";
    expect(OpportunityDossierSchema.safeParse(duplicateClaim).success).toBe(false);

    const omittedEvidence = makeOpportunity();
    first(omittedEvidence.scarcityHypothesis.claims.observed).evidenceIds = ["evidence-2"];
    expect(OpportunityDossierSchema.safeParse(omittedEvidence).success).toBe(false);
  });
});

describe("research bundle integrity", () => {
  it("parses a complete, evidence-linked research bundle", () => {
    const parsed = ResearchBundleSchema.parse(makeBundle());
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.opportunities[0]?.scarcityHypothesis.directBeneficiary).toBe(
      "University communications team",
    );
  });

  it("rejects dangling evidence and signal references", () => {
    const missingEvidence = makeBundle();
    first(missingEvidence.marketSignals).evidenceIds = ["missing-evidence"];
    expect(ResearchBundleSchema.safeParse(missingEvidence).success).toBe(false);

    const missingSignal = makeBundle();
    first(missingSignal.opportunities).marketSignalIds = ["missing-signal"];
    expect(ResearchBundleSchema.safeParse(missingSignal).success).toBe(false);
  });

  it("requires aggregate signal evidence to include every nested claim citation", () => {
    const bundle = makeBundle();
    const secondEvidence = makeEvidence();
    secondEvidence.evidenceId = "evidence-2";
    secondEvidence.provenance = {
      ...secondEvidence.provenance,
      canonicalUrl: "https://example.com/jobs/2",
      sourceRecordId: "job-2",
      contentSha256: "b".repeat(64),
    };
    secondEvidence.rawArtifactRef = "raw/snapshot-1/job-2.json";
    bundle.evidence.push(secondEvidence);
    first(first(bundle.marketSignals).claims.observed).evidenceIds = ["evidence-2"];

    expect(ResearchBundleSchema.safeParse(bundle).success).toBe(false);
  });

  it("requires the founder source ledger to cover competency citations", () => {
    const bundle = makeBundle();
    bundle.founderProfile.sourceEvidenceIds = [];
    expect(ResearchBundleSchema.safeParse(bundle).success).toBe(false);
  });

  it("rejects duplicate global claim IDs and the wrong founder snapshot", () => {
    const duplicateClaim = makeBundle();
    first(first(duplicateClaim.opportunities).scarcityHypothesis.claims.observed).claimId =
      "claim-signal-observed";
    expect(ResearchBundleSchema.safeParse(duplicateClaim).success).toBe(false);

    const wrongFounder = makeBundle();
    first(wrongFounder.opportunities).founderProfileSnapshotId = "profile-snapshot-other";
    expect(ResearchBundleSchema.safeParse(wrongFounder).success).toBe(false);
  });

  it("rejects a bundle timestamp that predates its contained artifacts", () => {
    expect(ResearchBundleSchema.safeParse({ ...makeBundle(), generatedAt: earlier }).success).toBe(
      false,
    );
  });
});
