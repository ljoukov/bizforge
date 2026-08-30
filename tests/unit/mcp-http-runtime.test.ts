import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BizForgeSignalTarget,
  installBizForgeShutdownHandlers,
} from "../../src/mcp/http-entrypoint.js";
import {
  closeBizForgeHttpServer,
  createBizForgeHttpServer,
  listenForBizForgeMcp,
} from "../../src/mcp/http-server.js";
import { SqliteBizForgeDataStore } from "../../src/mcp/sqlite-data-store.js";

const execFileAsync = promisify(execFile);
const MODERN_PROTOCOL_VERSION = "2026-07-28";

describe("BizForge MCP runtime lifecycle", () => {
  const cleanup: Array<() => Promise<void>> = [];

  async function openPersistentStore(prefix: string): Promise<SqliteBizForgeDataStore> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    const store = new SqliteBizForgeDataStore(join(directory, "bizforge.sqlite"));
    cleanup.push(async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    return store;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const run of cleanup.splice(0).reverse()) await run();
  });

  it("loads .env for the npm MCP entrypoint while preserving process-environment precedence", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "bizforge-env-script-"));
    cleanup.push(() => rm(projectDirectory, { recursive: true, force: true }));
    await mkdir(join(projectDirectory, "dist", "mcp"), { recursive: true });

    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["mcp:start"]).toContain("--env-file-if-exists=.env");
    await writeFile(
      join(projectDirectory, "package.json"),
      JSON.stringify({ private: true, type: "module", scripts: packageJson.scripts }),
    );
    await writeFile(
      join(projectDirectory, "dist", "mcp", "http-entrypoint.js"),
      'process.stdout.write([process.env.BIZFORGE_MCP_PORT, process.env.BIZFORGE_ENV_PROBE].join(":"));',
    );
    await writeFile(
      join(projectDirectory, ".env"),
      "BIZFORGE_MCP_PORT=4321\nBIZFORGE_ENV_PROBE=loaded-from-file\n",
    );

    const { stdout } = await execFileAsync("npm", ["run", "--silent", "mcp:start"], {
      cwd: projectDirectory,
      env: { ...process.env, BIZFORGE_MCP_PORT: "9876" },
    });
    expect(stdout).toBe("9876:loaded-from-file");
  });

  it("starts owned-store cleanup on a signal and force-closes a stalled connection once", async () => {
    const databaseDirectory = await mkdtemp(join(tmpdir(), "bizforge-signal-close-"));
    cleanup.push(() => rm(databaseDirectory, { recursive: true, force: true }));
    const storeClose = vi.spyOn(SqliteBizForgeDataStore.prototype, "close");
    const server = await listenForBizForgeMcp({
      port: 0,
      storeConfiguration: {
        cwd: databaseDirectory,
        environment: { BIZFORGE_DB_PATH: "profile.sqlite" },
      },
    });
    cleanup.push(() => closeBizForgeHttpServer(server, { forceCloseAfterMs: 0 }));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");

    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    socket.on("error", () => undefined);
    cleanup.push(async () => {
      socket.destroy();
    });
    await once(socket, "connect");
    const requestStarted = once(server, "request");
    socket.write(
      "POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
    );
    await requestStarted;

    const signalTarget = new EventEmitter();
    const errors: unknown[] = [];
    const controller = installBizForgeShutdownHandlers(server, {
      forceCloseAfterMs: 30,
      signalTarget: signalTarget as BizForgeSignalTarget,
      onError: (error) => errors.push(error),
    });
    expect(signalTarget.emit("SIGTERM")).toBe(true);
    const shutdown = controller.shutdown();
    let shutdownSettled = false;
    void shutdown.then(
      () => {
        shutdownSettled = true;
      },
      () => {
        shutdownSettled = true;
      },
    );
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(storeClose).not.toHaveBeenCalled();
    await shutdown;
    await controller.shutdown();
    if (!socket.destroyed) await once(socket, "close");

    expect(errors).toEqual([]);
    expect(server.listening).toBe(false);
    expect(socket.destroyed).toBe(true);
    expect(storeClose).toHaveBeenCalledTimes(1);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it("gracefully closes an active MCP subscription stream", async () => {
    const store = await openPersistentStore("bizforge-subscription-close-");
    const server = await listenForBizForgeMcp({
      port: 0,
      store,
    });
    cleanup.push(() => closeBizForgeHttpServer(server, { forceCloseAfterMs: 0 }));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "mcp-method": "subscriptions/listen",
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "runtime-subscription",
        method: "subscriptions/listen",
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
          notifications: { toolsListChanged: true },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (response.body === null) throw new Error("Expected SSE body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const firstFrame = await reader.read();
    expect(decoder.decode(firstFrame.value)).toContain("notifications/subscriptions/acknowledged");

    await closeBizForgeHttpServer(server, { forceCloseAfterMs: 100 });
    let closingFrames = "";
    for (;;) {
      const frame = await reader.read();
      if (frame.done) break;
      closingFrames += decoder.decode(frame.value, { stream: true });
    }
    expect(closingFrames).toContain('"resultType":"complete"');
  });

  it("contains request-handler failures at the HTTP response boundary", async () => {
    const store = await openPersistentStore("bizforge-handler-failure-");
    vi.spyOn(store, "getDataStatus").mockImplementation(() => {
      throw new Error("injected status failure");
    });
    const server = await listenForBizForgeMcp({ port: 0, store });
    cleanup.push(() => closeBizForgeHttpServer(server, { forceCloseAfterMs: 0 }));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_server_error" });
  });

  it("rejects an invalid close deadline without consuming the later valid shutdown", async () => {
    const store = await openPersistentStore("bizforge-close-deadline-");
    const server = createBizForgeHttpServer({ store });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(() => closeBizForgeHttpServer(server, { forceCloseAfterMs: 0 }));

    await expect(closeBizForgeHttpServer(server, { forceCloseAfterMs: -1 })).rejects.toThrow(
      /non-negative integer/,
    );
    await expect(
      closeBizForgeHttpServer(server, { forceCloseAfterMs: 0 }),
    ).resolves.toBeUndefined();
  });

  it("treats a never-started unowned HTTP server as already closed", async () => {
    await expect(closeBizForgeHttpServer(createServer())).resolves.toBeUndefined();
  });
});
