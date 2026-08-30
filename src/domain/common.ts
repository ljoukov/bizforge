import { z } from "zod";

/** Identifiers are deliberately opaque so storage adapters can choose their ID format. */
export const EntityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be an opaque, URL-safe identifier");

export const NonEmptyStringSchema = z.string().trim().min(1);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const HttpUrlSchema = z.httpUrl();

export const ConfidenceBoundsSchema = z
  .object({
    lower: z.number().min(0).max(1),
    estimate: z.number().min(0).max(1),
    upper: z.number().min(0).max(1),
    rationale: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine(({ lower, estimate, upper }, context) => {
    if (lower > estimate) {
      context.addIssue({
        code: "custom",
        path: ["lower"],
        message: "lower must be less than or equal to estimate",
      });
    }

    if (estimate > upper) {
      context.addIssue({
        code: "custom",
        path: ["upper"],
        message: "upper must be greater than or equal to estimate",
      });
    }
  });

export const DateRangeSchema = z
  .object({
    start: IsoDateTimeSchema,
    end: IsoDateTimeSchema,
  })
  .strict()
  .superRefine(({ start, end }, context) => {
    if (Date.parse(start) > Date.parse(end)) {
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "end must be at or after start",
      });
    }
  });

export function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export type ConfidenceBounds = z.infer<typeof ConfidenceBoundsSchema>;
export type DateRange = z.infer<typeof DateRangeSchema>;
