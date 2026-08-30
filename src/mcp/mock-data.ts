import type { EvidenceItem } from "../domain/evidence.js";
import type { ConfirmedFounderProfileSnapshot } from "../domain/founder-profile.js";
import { ResearchBundleSchema, type ResearchBundle } from "../domain/research-bundle.js";
import type { BizForgeDataStore } from "./data-store.js";
import { canonicalContentSha256 } from "./integrity.js";

const confidence = {
  lower: 0.55,
  estimate: 0.72,
  upper: 0.84,
  rationale: "Synthetic fixture confidence for UI and integration testing only.",
};

function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString();
}

function stableSuffix(value: string): string {
  return canonicalContentSha256(value).slice(0, 16);
}

function observedClaim(claimId: string, statement: string, evidenceId: string, createdAt: string) {
  return {
    claimId,
    kind: "observed" as const,
    statement,
    evidenceIds: [evidenceId],
    confidence,
    createdAt,
  };
}

function inferredClaim(claimId: string, statement: string, evidenceId: string, createdAt: string) {
  return {
    claimId,
    kind: "inferred" as const,
    statement,
    evidenceIds: [evidenceId],
    rationale: "This is a synthetic inference from the fixture measurement, not an external fact.",
    confidence,
    createdAt,
  };
}

function assumptionClaim(claimId: string, statement: string, createdAt: string) {
  return {
    claimId,
    kind: "assumption" as const,
    statement,
    evidenceIds: [],
    rationale: "The synthetic fixture does not contain buyer-interview evidence.",
    validationPlan: "Run five buyer interviews and request a paid pilot commitment.",
    confidence: {
      lower: 0.15,
      estimate: 0.35,
      upper: 0.55,
      rationale: "Explicit untested synthetic hypothesis.",
    },
    createdAt,
  };
}

export function buildSyntheticResearchBundle(
  profile: ConfirmedFounderProfileSnapshot,
  founderEvidence: readonly EvidenceItem[],
): ResearchBundle {
  const suffix = stableSuffix(profile.snapshotId);
  const generatedAt = profile.confirmedAt;
  const baselineWindow = {
    start: addDays(generatedAt, -181),
    end: addDays(generatedAt, -92),
  };
  const currentWindow = {
    start: addDays(generatedAt, -91),
    end: addDays(generatedAt, -1),
  };
  const marketEvidenceId = `evidence-market-${suffix}`;
  const signalId = `signal-growth-${suffix}`;
  const opportunityId = `opportunity-${suffix}`;
  const founderEvidenceId = founderEvidence[0]?.evidenceId;
  if (founderEvidenceId === undefined) {
    throw new Error("A synthetic research bundle requires at least one founder evidence item");
  }

  const marketEvidence: EvidenceItem = {
    evidenceId: marketEvidenceId,
    evidenceType: "market_report",
    title: "Synthetic workflow-demand comparison",
    summary:
      "Synthetic fixture counts increased from 24 matching records in the baseline window to 39 in the current window.",
    provenance: {
      provider: "BizForge synthetic fixture",
      collectionMethod: "manual_import",
      sourceRecordId: `synthetic-growth-${suffix}`,
      retrievedAt: currentWindow.end,
      publishedAt: currentWindow.end,
      contentSha256: canonicalContentSha256({ baseline: 24, current: 39, suffix }),
    },
    observedAt: currentWindow.end,
    rawArtifactRef: `mock://synthetic/market-growth/${suffix}`,
    locator: {
      jsonPointer: "/measurements/0",
      excerpt: "Synthetic baseline 24; current 39; identical fixture query and coverage.",
    },
    extraction: { method: "manual", version: "bizforge-synthetic-v1" },
    attributes: { baselineValue: 24, currentValue: 39, synthetic: true },
    tags: ["synthetic", "growth", "demo-only"],
  };

  const signalObserved = observedClaim(
    `claim-signal-observed-${suffix}`,
    "The synthetic fixture contains 39 current-window matches and 24 baseline-window matches.",
    marketEvidenceId,
    generatedAt,
  );
  const scarcityObserved = observedClaim(
    `claim-scarcity-observed-${suffix}`,
    "The synthetic fixture describes repeated demand for manually prepared workflow outputs.",
    marketEvidenceId,
    generatedAt,
  );
  const scarcityInferred = inferredClaim(
    `claim-scarcity-inferred-${suffix}`,
    "The synthetic comparison suggests growing pressure on specialist workflow capacity.",
    marketEvidenceId,
    generatedAt,
  );
  const interventionAssumption = assumptionClaim(
    `claim-intervention-assumption-${suffix}`,
    "A buyer may pay to automate repetitive preparation while keeping human approval.",
    generatedAt,
  );

  return ResearchBundleSchema.parse({
    schemaVersion: "1.0.0",
    bundleId: `bundle-${suffix}`,
    bundleVersion: 1,
    runId: `research-${suffix}`,
    founderProfile: profile,
    researchWindow: { start: baselineWindow.start, end: currentWindow.end },
    evidence: [...founderEvidence, marketEvidence],
    marketSignals: [
      {
        signalId,
        market: "Synthetic operations teams",
        name: "Synthetic demand growth for workflow output",
        description:
          "A deterministic mock comparison suitable for chart rendering, not a real market claim.",
        evidenceIds: [marketEvidenceId],
        measurement: {
          metric: "matching_fixture_records",
          value: 39,
          unit: "synthetic records",
          direction: "rising",
          currentWindow,
          baselineWindow,
          baselineValue: 24,
          absoluteChange: 15,
          percentageChange: 62.5,
          sampleSize: 39,
          distinctEntityCount: 31,
          methodology:
            "Count deduplicated synthetic records using the same fixture query and coverage in both windows.",
          coverageNote:
            "Synthetic fixture only; it demonstrates the product flow and must not justify a real investment decision.",
        },
        claims: { observed: [signalObserved], inferred: [], assumptions: [] },
        confidence,
        calculatedAt: generatedAt,
      },
    ],
    opportunities: [
      {
        opportunityId,
        founderProfileSnapshotId: profile.snapshotId,
        title: "Human-approved workflow output automation",
        summary:
          "A synthetic opportunity showing how Step 1 founder evidence can drive a Step 3 exploration.",
        marketSignalIds: [signalId],
        evidenceIds: [marketEvidenceId, founderEvidenceId],
        scarcityHypothesis: {
          hypothesisId: `hypothesis-${suffix}`,
          title: "Make routine workflow output abundant while preserving approval",
          market: "Synthetic operations teams",
          valueChain: [
            {
              stageId: `stage-prepare-${suffix}`,
              name: "Prepare workflow output",
              actor: "Operations specialist",
              input: "Approved source records",
              output: "Prepared deliverable",
              currentProcess: "A specialist manually prepares each deliverable.",
            },
            {
              stageId: `stage-approve-${suffix}`,
              name: "Approve deliverable",
              actor: "Workflow owner",
              input: "Prepared deliverable",
              output: "Approved deliverable",
              currentProcess: "A human owner reviews policy and quality before release.",
            },
          ],
          scarceResource: "Specialist preparation time",
          scarcityMechanism: "Every additional deliverable currently consumes specialist effort.",
          claims: {
            observed: [scarcityObserved],
            inferred: [scarcityInferred],
            assumptions: [],
          },
          aiIntervention: {
            description: "Draft routine deliverables from approved inputs for human review.",
            makesAbundant: "Review-ready workflow output",
            collapsedStageIds: [`stage-prepare-${suffix}`],
            claims: { observed: [], inferred: [], assumptions: [interventionAssumption] },
          },
          abundantOutcome: "More review-ready deliverables without proportional preparation work",
          directBeneficiary: "Operations specialist",
          economicBuyer: "Head of operations",
          successorBottleneck: {
            description: "Human approval and policy ownership become the limiting step.",
            claims: {
              observed: [],
              inferred: [
                inferredClaim(
                  `claim-successor-${suffix}`,
                  "If preparation accelerates, approval capacity becomes the next likely bottleneck.",
                  marketEvidenceId,
                  generatedAt,
                ),
              ],
              assumptions: [],
            },
          },
          confidence,
          createdAt: generatedAt,
        },
        offering: {
          description: "A human-approved automation service for one repeatable output workflow.",
          smallestSellableWedge: "A paid pilot automating one weekly deliverable type.",
          revenueModel: "Fixed-fee pilot followed by a per-workflow subscription.",
          valueCaptureMechanism: "Own the customer-specific approval policy and workflow history.",
          claims: {
            observed: [],
            inferred: [
              inferredClaim(
                `claim-offering-${suffix}`,
                "A narrow workflow pilot is a plausible way to test the synthetic scarcity hypothesis.",
                marketEvidenceId,
                generatedAt,
              ),
            ],
            assumptions: [],
          },
        },
        founderFit: {
          rating: "plausible",
          explanation:
            "The published synthetic founder competency is relevant, but this fixture is not a real fit assessment.",
          claims: {
            observed: [],
            inferred: [
              inferredClaim(
                `claim-founder-fit-${suffix}`,
                "The synthetic founder evidence supports a plausible ability to build the initial workflow.",
                founderEvidenceId,
                generatedAt,
              ),
            ],
            assumptions: [],
          },
        },
        defensibilityClaims: {
          observed: [],
          inferred: [],
          assumptions: [
            assumptionClaim(
              `claim-defensibility-${suffix}`,
              "Customer-specific approval history may create defensibility.",
              generatedAt,
            ),
          ],
        },
        counterEvidence: {
          status: "NOT_FOUND",
          searchSummary: "No external search was run; this is a bounded synthetic fixture.",
          warning: "Absence of counter-evidence in a synthetic fixture is not real-world support.",
          claims: { observed: [], inferred: [], assumptions: [] },
        },
        falsificationExperiment: {
          assumptionClaimIds: [interventionAssumption.claimId],
          method: "Offer five synthetic buyer personas a paid pilot in a controlled demo.",
          successCriterion: "At least one explicit simulated paid-pilot commitment.",
          failureCriterion: "No simulated buyer accepts the proposed pilot conditions.",
          maximumDurationDays: 14,
          maximumBudgetUsd: 500,
        },
        confidence,
        generatedAt,
      },
    ],
    generatedAt,
    warnings: [
      "Synthetic mock research for UI and integration testing only; do not use it as market evidence.",
      "Economic-buyer text is a hypothesis and is not structurally linked to buyer-specific evidence.",
    ],
  });
}

export function seedSyntheticMockData(store: BizForgeDataStore): void {
  const setupRunId = "setup-synthetic-demo";
  const founderId = "founder-synthetic-demo";
  const evidenceId = "evidence-founder-synthetic-demo";
  const capturedAt = "2026-08-01T12:00:00.000Z";
  const confirmedAt = "2026-08-29T12:00:00.000Z";
  store.createSetupRun({
    setupRunId,
    founderId,
    source: "mock_seed",
    isSynthetic: true,
    now: capturedAt,
  });
  for (const [consentId, scope] of [
    ["consent-self-report-synthetic-demo", "retain_minimized_founder_self_report"],
    ["consent-profile-evidence-synthetic-demo", "retain_minimized_profile_evidence"],
    ["consent-retain-synthetic-demo", "retain_minimized_founder_snapshot"],
    ["consent-research-synthetic-demo", "use_confirmed_founder_snapshot_for_research"],
  ] as const) {
    store.recordConsent(
      {
        consentId,
        setupRunId,
        founderId,
        scope,
        status: "active",
        sourceUrls: [],
        recordedAt: capturedAt,
        grantedAt: capturedAt,
      },
      "mock_seed",
    );
  }
  const evidence: EvidenceItem = {
    evidenceId,
    evidenceType: "user_input",
    title: "Synthetic founder competency",
    summary: "The synthetic founder reports working-level workflow automation experience.",
    provenance: {
      provider: "BizForge synthetic fixture",
      collectionMethod: "user_input",
      sourceRecordId: "synthetic-founder-input",
      retrievedAt: capturedAt,
      contentSha256: canonicalContentSha256("synthetic founder competency"),
    },
    observedAt: capturedAt,
    rawArtifactRef: "mock://synthetic/founder-input",
    locator: { jsonPointer: "/founder/competencies/0" },
    extraction: { method: "manual", version: "bizforge-synthetic-v1" },
    attributes: { synthetic: true },
    tags: ["synthetic", "founder-self-report"],
  };
  store.putEvidence(setupRunId, evidence, "mock_seed", true);
  store.transitionSetupRun({
    setupRunId,
    expectedVersion: 1,
    targetState: "INTERVIEW",
    idempotencyKey: "seed-interview",
  });
  store.transitionSetupRun({
    setupRunId,
    expectedVersion: 2,
    targetState: "DRAFT_REVIEW",
    idempotencyKey: "seed-review",
  });
  store.confirmFounderProfile({
    setupRunId,
    expectedVersion: 3,
    idempotencyKey: "seed-confirm",
    isSynthetic: true,
    source: "mock_seed",
    profile: {
      snapshotId: "snapshot-synthetic-demo",
      founderId,
      displayName: "Synthetic Demo Founder",
      competencies: [
        {
          name: "Workflow automation",
          level: "working",
          yearsExperience: 3,
          evidenceIds: [evidenceId],
          confidence: {
            lower: 0.25,
            estimate: 0.5,
            upper: 0.75,
            rationale: "Synthetic uncorroborated self-report policy.",
          },
        },
      ],
      businessAppetite: {
        hoursPerWeek: 15,
        capitalBudgetUsd: 2_500,
        timeToFirstRevenueDays: 45,
        teamSize: 1,
        preferredOfferTypes: ["hybrid"],
        preferredCustomerTypes: ["smb", "mid_market"],
        salesTolerance: "medium",
        riskTolerance: "medium",
        regulatoryTolerance: "low",
      },
      constraints: ["Synthetic demo data only"],
      accessAdvantages: ["Synthetic access to operations personas"],
      sourceEvidenceIds: [evidenceId],
      claims: { observed: [], inferred: [], assumptions: [] },
      capturedAt,
      confirmedAt,
    },
  });
}
