import { describe, expect, it } from "vitest";

import {
  assertResearchBundleEvidenceValid,
  ResearchBundleEvidenceError,
  validateResearchBundle,
} from "../../src/application/validate-research-bundle.js";
import type { ResearchBundle } from "../../src/domain/index.js";

function researchBundle(
  content: Record<string, unknown>,
  evidenceIds: readonly string[] = ["evidence-1", "evidence-2"],
): ResearchBundle {
  return {
    evidence: evidenceIds.map((evidenceId) => ({ evidenceId })),
    ...content,
  } as unknown as ResearchBundle;
}

describe("validateResearchBundle", () => {
  it("accepts observed and inferred claims with resolvable evidence and ordered confidence", () => {
    const bundle = researchBundle({
      marketSignals: [
        {
          evidenceIds: ["evidence-1", "evidence-2"],
          claims: [
            {
              claimId: "claim-observed",
              kind: "observed",
              statement: "The source contains the observed event.",
              evidenceIds: ["evidence-1"],
            },
            {
              claimId: "claim-inferred",
              kind: "inferred",
              statement: "The observed events suggest a constrained workflow.",
              evidenceIds: ["evidence-1", "evidence-2"],
            },
            {
              claimId: "claim-assumption",
              kind: "assumption",
              statement: "The buyer may prefer an external vendor.",
              evidenceIds: [],
            },
          ],
          confidence: { lower: 0.4, estimate: 0.6, upper: 0.8 },
        },
      ],
    });

    expect(validateResearchBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(() => assertResearchBundleEvidenceValid(bundle)).not.toThrow();
  });

  it("requires both observed and inferred claims to cite evidence", () => {
    const bundle = researchBundle({
      opportunities: [
        {
          evidenceClaims: [
            {
              claimId: "observed-without-source",
              kind: "observed",
              statement: "An unsupported observation.",
              evidenceIds: [],
            },
            {
              claimId: "inferred-without-source",
              kind: "inferred",
              statement: "An unsupported inference.",
              evidenceIds: [],
            },
            {
              claimId: "assumption-without-source",
              kind: "assumption",
              statement: "An explicitly unproven assumption.",
              evidenceIds: [],
            },
          ],
        },
      ],
    });

    const result = validateResearchBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "missing_evidence",
        claimId: "observed-without-source",
      }),
      expect.objectContaining({
        code: "missing_evidence",
        claimId: "inferred-without-source",
      }),
    ]);
  });

  it("rejects unknown IDs wherever an evidence reference appears", () => {
    const bundle = researchBundle({
      founderProfile: {
        sourceEvidenceIds: ["profile-not-collected"],
      },
      marketSignals: [
        {
          signalId: "signal-1",
          evidenceIds: ["evidence-1", "not-collected"],
          claims: [
            {
              claimId: "claim-1",
              kind: "observed",
              statement: "A mixed citation list.",
              evidenceIds: ["evidence-2", "also-not-collected", "also-not-collected"],
            },
          ],
        },
      ],
    });

    const result = validateResearchBundle(bundle);

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unknown_evidence_id",
          evidenceId: "profile-not-collected",
          path: "$.founderProfile.sourceEvidenceIds",
        }),
        expect.objectContaining({
          code: "unknown_evidence_id",
          evidenceId: "not-collected",
          path: "$.marketSignals[0].evidenceIds",
        }),
        expect.objectContaining({
          code: "unknown_evidence_id",
          evidenceId: "also-not-collected",
          claimId: "claim-1",
          path: "$.marketSignals[0].claims[0].evidenceIds",
        }),
      ]),
    );
    expect(result.issues).toHaveLength(3);
  });

  it("rejects confidence outside the unit interval or with reversed bounds", () => {
    const bundle = researchBundle({
      marketSignals: [
        { confidence: { lower: -0.1, estimate: 0.4, upper: 0.8 } },
        { confidence: { lower: 0.4, estimate: 0.9, upper: 0.8 } },
        { confidence: { lower: 0.2, estimate: Number.NaN, upper: 0.8 } },
      ],
    });

    const result = validateResearchBundle(bundle);

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "invalid_confidence_bounds",
        path: "$.marketSignals[0].confidence",
      }),
      expect.objectContaining({
        code: "invalid_confidence_bounds",
        path: "$.marketSignals[1].confidence",
      }),
      expect.objectContaining({
        code: "invalid_confidence_bounds",
        path: "$.marketSignals[2].confidence",
      }),
    ]);
  });

  it("rejects duplicate evidence IDs because references would be ambiguous", () => {
    const bundle = researchBundle({}, ["evidence-1", "evidence-1"]);

    expect(validateResearchBundle(bundle)).toEqual({
      valid: false,
      issues: [
        expect.objectContaining({
          code: "duplicate_evidence_id",
          evidenceId: "evidence-1",
          path: "$.evidence[1].evidenceId",
        }),
      ],
    });
  });

  it("throws a structured error at fail-closed export boundaries", () => {
    const bundle = researchBundle({
      opportunities: [
        {
          claimId: "claim-unknown",
          kind: "observed",
          evidenceIds: ["missing"],
        },
      ],
    });

    expect(() => assertResearchBundleEvidenceValid(bundle)).toThrow(ResearchBundleEvidenceError);

    try {
      assertResearchBundleEvidenceValid(bundle);
      throw new Error("Expected evidence validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchBundleEvidenceError);
      if (error instanceof ResearchBundleEvidenceError) {
        expect(error.issues).toEqual([
          expect.objectContaining({
            code: "unknown_evidence_id",
            evidenceId: "missing",
            claimId: "claim-unknown",
          }),
        ]);
      }
    }
  });
});
