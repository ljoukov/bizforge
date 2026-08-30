import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BizForgeDataStore } from "../../src/mcp/data-store.js";
import {
  BizForgeShutdownTimeoutError,
  closeBizForgeHttpServer,
  listenForBizForgeMcp,
} from "../../src/mcp/http-server.js";
import { SqliteBizForgeDataStore } from "../../src/mcp/sqlite-data-store.js";

const closeControls = vi.hoisted(() => ({
  releaseHandler: undefined as (() => void) | undefined,
  handlerClose: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        closeControls.releaseHandler = resolve;
      }),
  ),
}));

vi.mock("../../src/mcp/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mcp/server.js")>();
  return {
    ...actual,
    createBizForgeMcpHandler(store: BizForgeDataStore) {
      return {
        ...actual.createBizForgeMcpHandler(store),
        close: closeControls.handlerClose,
      };
    },
  };
});

describe("BizForge MCP hard shutdown deadline", () => {
  afterEach(() => {
    closeControls.handlerClose.mockClear();
    closeControls.releaseHandler = undefined;
    vi.restoreAllMocks();
  });

  it("times out without closing its owned store while handler cleanup is still active", async () => {
    const databaseDirectory = await mkdtemp(join(tmpdir(), "bizforge-hard-close-"));
    const storeClose = vi.spyOn(SqliteBizForgeDataStore.prototype, "close");
    try {
      const server = await listenForBizForgeMcp({
        port: 0,
        storeConfiguration: {
          cwd: databaseDirectory,
          environment: { BIZFORGE_DB_PATH: "profile.sqlite" },
        },
      });

      await expect(
        closeBizForgeHttpServer(server, { forceCloseAfterMs: 20 }),
      ).rejects.toBeInstanceOf(BizForgeShutdownTimeoutError);
      expect(closeControls.handlerClose).toHaveBeenCalledTimes(1);
      expect(storeClose).not.toHaveBeenCalled();
      closeControls.releaseHandler?.();
      await vi.waitFor(() => expect(storeClose).toHaveBeenCalledTimes(1));
      expect(storeClose).toHaveBeenCalledTimes(1);
      expect(server.listening).toBe(false);
    } finally {
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  });
});
