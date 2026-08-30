import type { ResearchBundle } from "../domain/index.js";

export type EvidenceValidationIssueCode =
  | "duplicate_evidence_id"
  | "missing_evidence"
  | "unknown_evidence_id"
  | "invalid_confidence_bounds";

export interface EvidenceValidationIssue {
  readonly code: EvidenceValidationIssueCode;
  readonly path: string;
  readonly message: string;
  readonly claimId?: string;
  readonly evidenceId?: string;
}

export interface EvidenceValidationResult {
  readonly valid: boolean;
  readonly issues: readonly EvidenceValidationIssue[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueForMissingEvidence(value: UnknownRecord, path: string): EvidenceValidationIssue {
  const claimId = typeof value.claimId === "string" ? value.claimId : undefined;

  return {
    code: "missing_evidence",
    path: `${path}.evidenceIds`,
    message: `${String(value.kind)} claim${claimId === undefined ? "" : ` ${claimId}`} must cite at least one evidence item`,
    ...(claimId === undefined ? {} : { claimId }),
  };
}

function validateEvidenceReferences(
  value: UnknownRecord,
  path: string,
  knownEvidenceIds: ReadonlySet<string>,
): EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  const claimRequiresEvidence = value.kind === "observed" || value.kind === "inferred";
  const claimEvidenceIds = Array.isArray(value.evidenceIds)
    ? value.evidenceIds.filter((id): id is string => typeof id === "string")
    : [];

  if (claimRequiresEvidence && claimEvidenceIds.length === 0) {
    issues.push(issueForMissingEvidence(value, path));
  }

  const claimId = typeof value.claimId === "string" ? value.claimId : undefined;
  const referenceFields = Object.entries(value).filter(
    (entry): entry is [string, unknown[]] =>
      (entry[0] === "evidenceIds" || entry[0] === "sourceEvidenceIds") && Array.isArray(entry[1]),
  );

  for (const [field, references] of referenceFields) {
    const referencedIds = new Set(references.filter((id): id is string => typeof id === "string"));

    for (const evidenceId of referencedIds) {
      if (knownEvidenceIds.has(evidenceId)) {
        continue;
      }

      issues.push({
        code: "unknown_evidence_id",
        path: `${path}.${field}`,
        message: `Evidence reference ${evidenceId} does not resolve within this research bundle`,
        evidenceId,
        ...(claimId === undefined ? {} : { claimId }),
      });
    }
  }

  return issues;
}

function isPotentialConfidenceBounds(key: string, value: unknown): value is UnknownRecord {
  return (
    key === "confidence" &&
    isRecord(value) &&
    ("lower" in value || "estimate" in value || "upper" in value)
  );
}

function validateConfidenceBounds(
  confidence: UnknownRecord,
  path: string,
): EvidenceValidationIssue | undefined {
  const { lower, estimate, upper } = confidence;
  const values = [lower, estimate, upper];
  const areFiniteUnitValues = values.every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
  );
  const areOrdered =
    typeof lower === "number" &&
    typeof estimate === "number" &&
    typeof upper === "number" &&
    lower <= estimate &&
    estimate <= upper;

  if (areFiniteUnitValues && areOrdered) {
    return undefined;
  }

  return {
    code: "invalid_confidence_bounds",
    path,
    message:
      "Confidence bounds must be finite values from 0 to 1 ordered as lower <= estimate <= upper",
  };
}

function collectReferenceIssues(
  value: unknown,
  path: string,
  knownEvidenceIds: ReadonlySet<string>,
  visited: WeakSet<object>,
  issues: EvidenceValidationIssue[],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectReferenceIssues(item, `${path}[${index}]`, knownEvidenceIds, visited, issues);
    }
    return;
  }

  if (!isRecord(value) || visited.has(value)) {
    return;
  }
  visited.add(value);

  issues.push(...validateEvidenceReferences(value, path, knownEvidenceIds));

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isPotentialConfidenceBounds(key, child)) {
      const confidenceIssue = validateConfidenceBounds(child, childPath);
      if (confidenceIssue !== undefined) {
        issues.push(confidenceIssue);
      }
    }

    collectReferenceIssues(child, childPath, knownEvidenceIds, visited, issues);
  }
}

/**
 * Performs the cross-record checks that cannot be expressed by validating one
 * agent-produced object in isolation. The walk covers every evidence-reference
 * field in the domain model, so new claim-bearing structures cannot bypass checks.
 */
export function validateResearchBundle(bundle: ResearchBundle): EvidenceValidationResult {
  const knownEvidenceIds = new Set<string>();
  const issues: EvidenceValidationIssue[] = [];

  for (const [index, evidence] of bundle.evidence.entries()) {
    if (knownEvidenceIds.has(evidence.evidenceId)) {
      issues.push({
        code: "duplicate_evidence_id",
        path: `$.evidence[${index}].evidenceId`,
        message: `Evidence ID ${evidence.evidenceId} is duplicated and cannot be resolved unambiguously`,
        evidenceId: evidence.evidenceId,
      });
    }
    knownEvidenceIds.add(evidence.evidenceId);
  }

  collectReferenceIssues(bundle, "$", knownEvidenceIds, new WeakSet(), issues);

  return {
    valid: issues.length === 0,
    issues,
  };
}

export class ResearchBundleEvidenceError extends Error {
  readonly issues: readonly EvidenceValidationIssue[];

  constructor(issues: readonly EvidenceValidationIssue[]) {
    super(`Research bundle failed evidence validation with ${issues.length} issue(s)`);
    this.name = "ResearchBundleEvidenceError";
    this.issues = issues;
  }
}

/** Fails closed at persistence/export boundaries while preserving structured diagnostics. */
export function assertResearchBundleEvidenceValid(bundle: ResearchBundle): void {
  const result = validateResearchBundle(bundle);
  if (!result.valid) {
    throw new ResearchBundleEvidenceError(result.issues);
  }
}
