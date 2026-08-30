import { describe, expect, it } from "vitest";

import {
  OPPORTUNITY_SCORE_PENALTY_RATES,
  OPPORTUNITY_SCORE_WEIGHTS,
  type OpportunityScoreInput,
  scoreOpportunity,
} from "../../src/application/score-opportunity.js";

const validInput: OpportunityScoreInput = {
  marketEvidence: 80,
  aiScarcityRemovalLeverage: 90,
  buyerValue: 70,
  captureDefensibility: 60,
  founderFit: 50,
  evidenceConfidence: 100,
  successorBottleneckRisk: 40,
  commoditizationRisk: 30,
};

describe("scoreOpportunity", () => {
  it("publishes weights that preserve a 100-point base scale", () => {
    expect(Object.values(OPPORTUNITY_SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(
      1,
    );
  });

  it("calculates a deterministic weighted score and reports both risk deductions", () => {
    const first = scoreOpportunity(validInput);
    const second = scoreOpportunity(validInput);

    expect(first).toEqual(second);
    expect(first).toEqual({
      total: 67,
      baseScore: 76,
      totalPenalty: 9,
      components: {
        marketEvidence: { value: 80, weight: 0.25, contribution: 20 },
        aiScarcityRemovalLeverage: { value: 90, weight: 0.2, contribution: 18 },
        buyerValue: { value: 70, weight: 0.2, contribution: 14 },
        captureDefensibility: { value: 60, weight: 0.15, contribution: 9 },
        founderFit: { value: 50, weight: 0.1, contribution: 5 },
        evidenceConfidence: { value: 100, weight: 0.1, contribution: 10 },
      },
      penalties: {
        successorBottleneckRisk: {
          risk: 40,
          rate: OPPORTUNITY_SCORE_PENALTY_RATES.successorBottleneckRisk,
          deduction: 6,
        },
        commoditizationRisk: {
          risk: 30,
          rate: OPPORTUNITY_SCORE_PENALTY_RATES.commoditizationRisk,
          deduction: 3,
        },
      },
    });
  });

  it("allows a perfect score when the opportunity has no successor risks", () => {
    const score = scoreOpportunity({
      marketEvidence: 100,
      aiScarcityRemovalLeverage: 100,
      buyerValue: 100,
      captureDefensibility: 100,
      founderFit: 100,
      evidenceConfidence: 100,
      successorBottleneckRisk: 0,
      commoditizationRisk: 0,
    });

    expect(score).toMatchObject({ total: 100, baseScore: 100, totalPenalty: 0 });
  });

  it("never lets risk deductions produce a negative total", () => {
    const score = scoreOpportunity({
      marketEvidence: 0,
      aiScarcityRemovalLeverage: 0,
      buyerValue: 0,
      captureDefensibility: 0,
      founderFit: 0,
      evidenceConfidence: 0,
      successorBottleneckRisk: 100,
      commoditizationRisk: 100,
    });

    expect(score).toMatchObject({ total: 0, baseScore: 0, totalPenalty: 25 });
  });

  it.each([
    ["marketEvidence", -1],
    ["aiScarcityRemovalLeverage", 101],
    ["buyerValue", Number.NaN],
    ["captureDefensibility", Number.POSITIVE_INFINITY],
    ["founderFit", Number.NEGATIVE_INFINITY],
    ["evidenceConfidence", 100.01],
    ["successorBottleneckRisk", -0.01],
    ["commoditizationRisk", 200],
  ] as const)("rejects an invalid %s value", (dimension, invalidValue) => {
    expect(() =>
      scoreOpportunity({
        ...validInput,
        [dimension]: invalidValue,
      }),
    ).toThrow(RangeError);
  });

  it("rounds public calculations to two decimal places", () => {
    const score = scoreOpportunity({
      marketEvidence: 33.333,
      aiScarcityRemovalLeverage: 66.666,
      buyerValue: 12.345,
      captureDefensibility: 98.765,
      founderFit: 44.444,
      evidenceConfidence: 55.555,
      successorBottleneckRisk: 33.333,
      commoditizationRisk: 66.666,
    });

    expect(score.components.marketEvidence.contribution).toBe(8.33);
    expect(score.penalties.successorBottleneckRisk.deduction).toBe(5);
    expect(score.total.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });
});
