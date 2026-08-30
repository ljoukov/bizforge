import { describe, expect, it } from "vitest";

import type { DataStoreStatus } from "../../src/mcp/contracts.js";
import { canonicalContentSha256 } from "../../src/mcp/integrity.js";
import { createResponseEnvelope } from "../../src/mcp/tools.js";

describe("canonicalContentSha256", () => {
  it("is stable across object key ordering and omits undefined object properties", () => {
    expect(canonicalContentSha256({ b: 2, a: { d: undefined, c: 3 } })).toBe(
      canonicalContentSha256({ a: { c: 3 }, b: 2 }),
    );
    expect(canonicalContentSha256([1, { b: 2, a: 1 }])).toMatch(/^[a-f0-9]{64}$/);
  });

  it("builds envelope storage metadata from the active adapter", () => {
    const sqliteStatus: DataStoreStatus = {
      dataMode: "persistent",
      storageMode: "persistent",
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
      isMock: false,
      ephemeral: false,
      writePolicy: {
        requiresExplicitMockAcceptance: false,
        acceptsNonSyntheticWrites: true,
      },
      fixtureVersion: "none",
      warnings: ["SQLite adapter test metadata"],
    };

    expect(
      createResponseEnvelope({ recordId: "persisted-record" }, sqliteStatus, {
        isSynthetic: false,
        source: "mcp_write",
      }),
    ).toMatchObject({
      dataMode: "persistent",
      storageMode: "persistent",
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
      isMock: false,
      ephemeral: false,
      writePolicy: {
        requiresExplicitMockAcceptance: false,
        acceptsNonSyntheticWrites: true,
      },
      fixtureVersion: "none",
      warnings: ["SQLite adapter test metadata"],
      isSynthetic: false,
      source: "mcp_write",
      provenanceMode: "recorded_data",
    });
  });
});
