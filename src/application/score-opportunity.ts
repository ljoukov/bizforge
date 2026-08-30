/**
 * Inputs are normalized to a 0-100 scale before they reach this deterministic scorer.
 * The weights are exported so reports can explain exactly how a score was produced.
 */
export const OPPORTUNITY_SCORE_WEIGHTS = Object.freeze({
  marketEvidence: 0.25,
  aiScarcityRemovalLeverage: 0.2,
  buyerValue: 0.2,
  captureDefensibility: 0.15,
  founderFit: 0.1,
  evidenceConfidence: 0.1,
});

/**
 * Risk values are also 0-100. At maximum risk, these rates deduct 15 and 10
 * points respectively from the weighted base score.
 */
export const OPPORTUNITY_SCORE_PENALTY_RATES = Object.freeze({
  successorBottleneckRisk: 0.15,
  commoditizationRisk: 0.1,
});

export type OpportunityScoreDimension = keyof typeof OPPORTUNITY_SCORE_WEIGHTS;
export type OpportunityRiskDimension = keyof typeof OPPORTUNITY_SCORE_PENALTY_RATES;

export type OpportunityScoreInput = Readonly<
  Record<OpportunityScoreDimension | OpportunityRiskDimension, number>
>;

export interface WeightedScoreComponent {
  readonly value: number;
  readonly weight: number;
  readonly contribution: number;
}

export interface ScorePenalty {
  readonly risk: number;
  readonly rate: number;
  readonly deduction: number;
}

export interface OpportunityScore {
  readonly total: number;
  readonly baseScore: number;
  readonly totalPenalty: number;
  readonly components: Readonly<Record<OpportunityScoreDimension, WeightedScoreComponent>>;
  readonly penalties: Readonly<Record<OpportunityRiskDimension, ScorePenalty>>;
}

const MIN_SCORE = 0;
const MAX_SCORE = 100;

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function requireNormalizedScore(name: string, value: number): void {
  if (!Number.isFinite(value) || value < MIN_SCORE || value > MAX_SCORE) {
    throw new RangeError(`${name} must be a finite number between 0 and 100; received ${value}`);
  }
}

function scoreComponent(value: number, weight: number): WeightedScoreComponent {
  return {
    value,
    weight,
    contribution: roundScore(value * weight),
  };
}

function scorePenalty(risk: number, rate: number): ScorePenalty {
  return {
    risk,
    rate,
    deduction: roundScore(risk * rate),
  };
}

/**
 * Produces a deterministic, transparent score for an opportunity.
 *
 * This function intentionally does not infer any input values. Agents or earlier
 * deterministic analysis must first normalize their evidence to the documented
 * 0-100 dimensions. This boundary prevents prose changes from silently changing
 * the ranking formula.
 */
export function scoreOpportunity(input: OpportunityScoreInput): OpportunityScore {
  for (const dimension of Object.keys(OPPORTUNITY_SCORE_WEIGHTS) as OpportunityScoreDimension[]) {
    requireNormalizedScore(dimension, input[dimension]);
  }

  for (const dimension of Object.keys(
    OPPORTUNITY_SCORE_PENALTY_RATES,
  ) as OpportunityRiskDimension[]) {
    requireNormalizedScore(dimension, input[dimension]);
  }

  const components = {
    marketEvidence: scoreComponent(input.marketEvidence, OPPORTUNITY_SCORE_WEIGHTS.marketEvidence),
    aiScarcityRemovalLeverage: scoreComponent(
      input.aiScarcityRemovalLeverage,
      OPPORTUNITY_SCORE_WEIGHTS.aiScarcityRemovalLeverage,
    ),
    buyerValue: scoreComponent(input.buyerValue, OPPORTUNITY_SCORE_WEIGHTS.buyerValue),
    captureDefensibility: scoreComponent(
      input.captureDefensibility,
      OPPORTUNITY_SCORE_WEIGHTS.captureDefensibility,
    ),
    founderFit: scoreComponent(input.founderFit, OPPORTUNITY_SCORE_WEIGHTS.founderFit),
    evidenceConfidence: scoreComponent(
      input.evidenceConfidence,
      OPPORTUNITY_SCORE_WEIGHTS.evidenceConfidence,
    ),
  } satisfies Record<OpportunityScoreDimension, WeightedScoreComponent>;

  const penalties = {
    successorBottleneckRisk: scorePenalty(
      input.successorBottleneckRisk,
      OPPORTUNITY_SCORE_PENALTY_RATES.successorBottleneckRisk,
    ),
    commoditizationRisk: scorePenalty(
      input.commoditizationRisk,
      OPPORTUNITY_SCORE_PENALTY_RATES.commoditizationRisk,
    ),
  } satisfies Record<OpportunityRiskDimension, ScorePenalty>;

  const baseScore = roundScore(
    Object.values(components).reduce((total, component) => total + component.contribution, 0),
  );
  const totalPenalty = roundScore(
    Object.values(penalties).reduce((total, penalty) => total + penalty.deduction, 0),
  );
  const total = roundScore(Math.min(MAX_SCORE, Math.max(MIN_SCORE, baseScore - totalPenalty)));

  return {
    total,
    baseScore,
    totalPenalty,
    components,
    penalties,
  };
}
