export interface ArtifactWriteRequest {
  readonly runId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface StoredArtifact {
  /** Stable, opaque reference understood by the artifact-store adapter. */
  readonly ref: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly storedAt: string;
}

/** Content-addressed storage for immutable raw and derived research artifacts. */
export interface ArtifactStore {
  write(request: ArtifactWriteRequest): Promise<StoredArtifact>;

  read(ref: string): AsyncIterable<Uint8Array>;

  has(ref: string): Promise<boolean>;
}
