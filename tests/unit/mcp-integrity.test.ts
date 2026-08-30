import { describe, expect, it } from "vitest";

import { type DataStoreStatus, DataStoreStatusSchema } from "../../src/mcp/contracts.js";
import { BizForgeStateStore } from "../../src/mcp/data-store.js";
import { canonicalContentSha256 } from "../../src/mcp/integrity.js";

describe("canonicalContentSha256", () => {
  it("is stable across object key ordering and omits undefined object properties", () => {
    expect(canonicalContentSha256({ b: 2, a: { d: undefined, c: 3 } })).toBe(
      canonicalContentSha256({ a: { c: 3 }, b: 2 }),
    );
    expect(canonicalContentSha256([1, { b: 2, a: 1 }])).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates and propagates the persistent store origin", () => {
    const sqliteStatus: DataStoreStatus = {
      dataMode: "persistent",
      storageMode: "persistent",
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
      warnings: ["SQLite adapter test metadata"],
    };

    expect(DataStoreStatusSchema.parse(sqliteStatus)).toEqual(sqliteStatus);
    const store = new BizForgeStateStore(sqliteStatus);
    expect(
      store.createSetupRun({
        founderId: "founder-integrity-origin",
        setupRunId: "setup-integrity-origin",
        now: "2026-08-29T12:00:00.000Z",
      }),
    ).toMatchObject({
      dataMode: "persistent",
      storageMode: "persistent",
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
      warnings: ["SQLite adapter test metadata"],
      source: "mcp_write",
    });
    expect(DataStoreStatusSchema.safeParse({ ...sqliteStatus, dataMode: "mock" }).success).toBe(
      false,
    );
  });
});
