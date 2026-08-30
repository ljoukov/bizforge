export interface PipelineEvent<TPayload = unknown> {
  /** Globally unique id used by consumers to deduplicate at-least-once delivery. */
  readonly id: string;
  readonly runId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/**
 * Append-only event boundary. Adapters may deliver an event more than once;
 * consumers use the event id for idempotency.
 */
export interface EventSink {
  append(events: readonly PipelineEvent[]): Promise<void>;
}
