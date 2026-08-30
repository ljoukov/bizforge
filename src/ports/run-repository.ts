import type { ResearchRun } from "../application/research-run-machine.js";

export type CreateResearchRunResult =
  | Readonly<{ status: "CREATED" }>
  | Readonly<{ status: "ALREADY_EXISTS"; currentVersion: number }>;

export type SaveResearchRunResult =
  | Readonly<{ status: "SAVED" }>
  | Readonly<{ status: "NOT_FOUND" }>
  | Readonly<{ status: "VERSION_CONFLICT"; currentVersion: number }>;

/**
 * Durable storage boundary for research-run coordination.
 *
 * `save` must be a single compare-and-swap operation. It may only persist
 * `next` when the stored row is still at `expectedVersion`; adapters must not
 * implement this as a read followed by an unconditional write.
 */
export interface ResearchRunRepository {
  create(run: ResearchRun): Promise<CreateResearchRunResult>;

  get(runId: string): Promise<ResearchRun | null>;

  save(next: ResearchRun, expectedVersion: number): Promise<SaveResearchRunResult>;
}
