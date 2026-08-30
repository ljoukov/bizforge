import { z } from "zod";
import { ClaimSetSchema, EvidenceIdSchema, flattenClaimSet } from "./claims.js";
import {
  ConfidenceBoundsSchema,
  DateRangeSchema,
  EntityIdSchema,
  hasUniqueValues,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from "./common.js";

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, Math.abs(right)) * 1e-9;
}

export const SignalMeasurementSchema = z
  .object({
    metric: NonEmptyStringSchema,
    value: z.number().finite(),
    unit: NonEmptyStringSchema,
    direction: z.enum(["rising", "falling", "stable", "concentrated", "unknown"]),
    currentWindow: DateRangeSchema,
    baselineWindow: DateRangeSchema.optional(),
    baselineValue: z.number().finite().optional(),
    absoluteChange: z.number().finite().optional(),
    percentageChange: z.number().finite().optional(),
    sampleSize: z.number().int().nonnegative(),
    distinctEntityCount: z.number().int().nonnegative(),
    methodology: NonEmptyStringSchema,
    coverageNote: NonEmptyStringSchema,
  })
  .strict()
  .superRefine(
    (
      {
        value,
        baselineWindow,
        baselineValue,
        absoluteChange,
        percentageChange,
        direction,
        sampleSize,
        distinctEntityCount,
        currentWindow,
      },
      context,
    ) => {
      if (distinctEntityCount > sampleSize) {
        context.addIssue({
          code: "custom",
          path: ["distinctEntityCount"],
          message: "distinctEntityCount must not exceed sampleSize",
        });
      }

      if (["rising", "falling", "stable"].includes(direction) && baselineWindow === undefined) {
        context.addIssue({
          code: "custom",
          path: ["baselineWindow"],
          message: `${direction} requires a baseline window`,
        });
      }

      if ((baselineWindow === undefined) !== (baselineValue === undefined)) {
        context.addIssue({
          code: "custom",
          path: [baselineWindow === undefined ? "baselineWindow" : "baselineValue"],
          message: "baselineWindow and baselineValue must be supplied together",
        });
      }

      if (
        baselineWindow !== undefined &&
        Date.parse(baselineWindow.end) >= Date.parse(currentWindow.start)
      ) {
        context.addIssue({
          code: "custom",
          path: ["baselineWindow", "end"],
          message: "baselineWindow must end before the current window starts",
        });
      }

      if (baselineValue !== undefined) {
        const expectedDirection = approximatelyEqual(value, baselineValue)
          ? "stable"
          : value > baselineValue
            ? "rising"
            : "falling";
        if (
          ["rising", "falling", "stable"].includes(direction) &&
          direction !== expectedDirection
        ) {
          context.addIssue({
            code: "custom",
            path: ["direction"],
            message: `direction must be ${expectedDirection} for the supplied values`,
          });
        }

        const expectedAbsoluteChange = value - baselineValue;
        if (
          absoluteChange !== undefined &&
          !approximatelyEqual(absoluteChange, expectedAbsoluteChange)
        ) {
          context.addIssue({
            code: "custom",
            path: ["absoluteChange"],
            message: "absoluteChange does not match value minus baselineValue",
          });
        }

        if (percentageChange !== undefined) {
          if (baselineValue === 0) {
            context.addIssue({
              code: "custom",
              path: ["percentageChange"],
              message: "percentageChange is undefined for a zero baseline",
            });
          } else {
            const expectedPercentageChange =
              (expectedAbsoluteChange / Math.abs(baselineValue)) * 100;
            if (!approximatelyEqual(percentageChange, expectedPercentageChange)) {
              context.addIssue({
                code: "custom",
                path: ["percentageChange"],
                message: "percentageChange does not match value and baselineValue",
              });
            }
          }
        }
      }

      if (
        baselineWindow === undefined &&
        (absoluteChange !== undefined || percentageChange !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["baselineWindow"],
          message: "baselineWindow is required when reporting change",
        });
      }
    },
  );

export const MarketSignalSchema = z
  .object({
    signalId: EntityIdSchema,
    market: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    evidenceIds: z
      .array(EvidenceIdSchema)
      .min(1)
      .refine(hasUniqueValues, "evidenceIds must not contain duplicates"),
    measurement: SignalMeasurementSchema,
    claims: ClaimSetSchema,
    confidence: ConfidenceBoundsSchema,
    calculatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine(({ claims, evidenceIds, measurement, calculatedAt }, context) => {
    if (claims.observed.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["claims", "observed"],
        message: "a market signal requires at least one observed claim",
      });
    }

    const allowedEvidenceIds = new Set(evidenceIds);
    for (const claim of flattenClaimSet(claims)) {
      for (const evidenceId of claim.evidenceIds) {
        if (!allowedEvidenceIds.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            path: ["claims", claim.kind, claim.claimId, "evidenceIds"],
            message: `claim evidence ${evidenceId} is missing from the signal evidenceIds`,
          });
        }
      }
    }

    if (Date.parse(calculatedAt) < Date.parse(measurement.currentWindow.end)) {
      context.addIssue({
        code: "custom",
        path: ["calculatedAt"],
        message: "calculatedAt must be at or after the current measurement window",
      });
    }

    for (const claim of flattenClaimSet(claims)) {
      if (Date.parse(claim.createdAt) > Date.parse(calculatedAt)) {
        context.addIssue({
          code: "custom",
          path: ["claims", claim.claimId, "createdAt"],
          message: "claim createdAt must not be after signal calculation",
        });
      }
    }
  });

export type SignalMeasurement = z.infer<typeof SignalMeasurementSchema>;
export type MarketSignal = z.infer<typeof MarketSignalSchema>;
