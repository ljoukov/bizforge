export interface RemoteResearchJob {
  readonly provider: string;
  readonly jobId: string;
}

export type RemoteResearchJobStatus =
  | Readonly<{ state: "QUEUED" }>
  | Readonly<{ state: "RUNNING"; completedRecords?: number }>
  | Readonly<{ state: "SUCCEEDED"; recordCount?: number }>
  | Readonly<{
      state: "FAILED";
      code: string;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{ state: "CANCELLED" }>;

export interface SubmitResearchJobRequest<TSpecification> {
  /** Locally durable operation id used to reconcile an ambiguous submission. */
  readonly operationId: string;
  readonly specification: TSpecification;
}

/**
 * Provider-neutral boundary for an asynchronous, potentially paid collector.
 *
 * Callers must persist submission intent before `submit`, then persist the
 * returned job before inspecting it. An adapter must not silently retry an
 * ambiguous non-idempotent submission.
 */
export interface ResearchSource<TSpecification, TRawRecord> {
  submit(
    request: SubmitResearchJobRequest<TSpecification>,
    signal: AbortSignal,
  ): Promise<RemoteResearchJob>;

  inspect(job: RemoteResearchJob, signal: AbortSignal): Promise<RemoteResearchJobStatus>;

  download(job: RemoteResearchJob, signal: AbortSignal): AsyncIterable<TRawRecord>;

  cancel?(job: RemoteResearchJob, signal: AbortSignal): Promise<void>;
}

/**
 * Raised when the provider may have accepted a paid submission but no durable
 * remote id was received. This is intentionally non-retryable: recovery must
 * reconcile provider state or obtain explicit approval to submit again.
 */
export class AmbiguousResearchSubmissionError extends Error {
  override readonly name = "AmbiguousResearchSubmissionError";

  constructor(
    readonly provider: string,
    readonly operationId: string,
    options?: ErrorOptions,
  ) {
    super(
      `${provider} may have accepted research operation ${operationId}; automatic resubmission is unsafe`,
      options,
    );
  }
}
