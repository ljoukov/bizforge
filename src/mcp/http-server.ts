import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";

import type { BizForgeDataStore } from "./data-store.js";
import {
  type BizForgeDataStoreConfiguration,
  createBizForgeMcpHandler,
  createConfiguredBizForgeDataStore,
} from "./server.js";

export interface BizForgeHttpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly store?: BizForgeDataStore;
  readonly storeConfiguration?: BizForgeDataStoreConfiguration;
}

interface ClosableDataStore extends BizForgeDataStore {
  close(): void;
}

export interface BizForgeHttpServerCloseOptions {
  /** Maximum graceful-close window before remaining TCP connections are destroyed. */
  readonly forceCloseAfterMs?: number;
}

export class BizForgeShutdownTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`BizForge MCP did not quiesce within ${timeoutMs * 2}ms of shutdown`);
    this.name = "BizForgeShutdownTimeoutError";
  }
}

interface ServerLifecycle {
  readonly closeHandler: () => Promise<void>;
  readonly closeStore: () => Promise<void>;
  readonly drainRequests: () => Promise<void>;
  readonly finalizeResources: () => Promise<void>;
  readonly sockets: Set<Socket>;
  everListened: boolean;
  serverClosed: boolean;
  shutdownPromise?: Promise<void>;
}

function isClosableDataStore(store: BizForgeDataStore): store is ClosableDataStore {
  return "close" in store && typeof store.close === "function";
}

const DEFAULT_FORCE_CLOSE_AFTER_MS = 5_000;
const serverLifecycles = new WeakMap<HttpServer, ServerLifecycle>();

function combineCloseResults(results: readonly PromiseSettledResult<void>[]): void {
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(({ reason }) => reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "BizForge MCP shutdown failed");
}

function invokeClose(operation: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function idempotentClose(operation: () => void | Promise<void>): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    if (closePromise !== undefined) return closePromise;

    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void invokeClose(operation).then(resolveClose, rejectClose);
    return closePromise;
  };
}

async function drainRequests(inFlightRequests: ReadonlySet<Promise<void>>): Promise<void> {
  while (inFlightRequests.size > 0) {
    await Promise.allSettled([...inFlightRequests]);
  }
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: BizForgeDataStore,
  nodeHandler: ReturnType<typeof toNodeHandler>,
  validateHost: ReturnType<typeof localhostHostValidation>,
  validateOrigin: ReturnType<typeof localhostOriginValidation>,
): Promise<void> {
  if (!validateHost(request, response) || !validateOrigin(request, response)) return;
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && path === "/healthz") {
    const body = JSON.stringify({
      ok: true,
      service: "bizforge-mcp",
      ...store.getDataStatus(),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
    return;
  }
  if (path !== "/mcp") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  await nodeHandler(request as Parameters<typeof nodeHandler>[0], response);
}

function finishFailedRequest(response: ServerResponse): void {
  if (response.destroyed || response.writableEnded) return;
  try {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "internal_server_error" }));
  } catch {
    response.destroy();
  }
}

export function createBizForgeHttpServer(options: BizForgeHttpServerOptions = {}): HttpServer {
  const ownsStore = options.store === undefined;
  const store = options.store ?? createConfiguredBizForgeDataStore(options.storeConfiguration);
  const handler = createBizForgeMcpHandler(store);
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const inFlightRequests = new Set<Promise<void>>();

  const server = createServer((request, response) => {
    const work = serveRequest(
      request,
      response,
      store,
      nodeHandler,
      validateHost,
      validateOrigin,
    ).catch(() => finishFailedRequest(response));
    inFlightRequests.add(work);
    void work.then(
      () => inFlightRequests.delete(work),
      () => inFlightRequests.delete(work),
    );
  });

  const closeHandler = idempotentClose(() => handler.close());
  const closeStore = idempotentClose(() => {
    if (ownsStore && isClosableDataStore(store)) store.close();
  });
  const waitForRequests = () => drainRequests(inFlightRequests);
  let finalizeResourcesPromise: Promise<void> | undefined;
  const finalizeResources = () => {
    finalizeResourcesPromise ??= (async () => {
      const handlerAndRequests = await Promise.allSettled([closeHandler(), waitForRequests()]);
      const storeResult = await Promise.allSettled([closeStore()]);
      combineCloseResults([...handlerAndRequests, ...storeResult]);
    })();
    return finalizeResourcesPromise;
  };
  const lifecycle: ServerLifecycle = {
    closeHandler,
    closeStore,
    drainRequests: waitForRequests,
    finalizeResources,
    sockets: new Set(),
    everListened: false,
    serverClosed: false,
  };
  serverLifecycles.set(server, lifecycle);
  server.on("connection", (socket) => {
    lifecycle.sockets.add(socket);
    socket.once("close", () => lifecycle.sockets.delete(socket));
  });
  server.on("listening", () => {
    lifecycle.everListened = true;
  });
  server.on("close", () => {
    lifecycle.serverClosed = true;
    void lifecycle.finalizeResources().catch(() => undefined);
  });
  return server;
}

/**
 * Stops accepting work, closes the MCP handler to release streams, drains
 * request work, then closes the owned store. Remaining TCP connections are
 * destroyed after the grace period. Safe to call more than once.
 */
export function closeBizForgeHttpServer(
  server: HttpServer,
  options: BizForgeHttpServerCloseOptions = {},
): Promise<void> {
  const lifecycle = serverLifecycles.get(server);
  if (lifecycle?.shutdownPromise !== undefined) return lifecycle.shutdownPromise;

  const forceCloseAfterMs = options.forceCloseAfterMs ?? DEFAULT_FORCE_CLOSE_AFTER_MS;
  if (!Number.isSafeInteger(forceCloseAfterMs) || forceCloseAfterMs < 0) {
    return Promise.reject(new TypeError("forceCloseAfterMs must be a non-negative integer"));
  }

  const wasRunning =
    server.listening || (lifecycle?.everListened === true && lifecycle.serverClosed === false);

  let resolveServerClose!: () => void;
  let rejectServerClose!: (error: unknown) => void;
  const serverClose = new Promise<void>((resolve, reject) => {
    resolveServerClose = resolve;
    rejectServerClose = reject;
  });

  if (!wasRunning) {
    resolveServerClose();
  } else if (server.listening) {
    try {
      server.close((error) => {
        if (error === undefined) resolveServerClose();
        else rejectServerClose(error);
      });
    } catch (error) {
      rejectServerClose(error);
    }
  } else {
    server.once("close", resolveServerClose);
  }

  const handlerClose = lifecycle?.closeHandler() ?? Promise.resolve();

  const quiescence = (async () => {
    const handlerAndServer = await Promise.allSettled([handlerClose, serverClose]);
    const requestDrain = await Promise.allSettled([
      lifecycle?.drainRequests() ?? Promise.resolve(),
    ]);
    return [...handlerAndServer, ...requestDrain];
  })();
  const closeStoreAfterQuiescence = async (
    quiescenceResults: readonly PromiseSettledResult<void>[],
  ) => {
    const storeClose = await Promise.allSettled([lifecycle?.closeStore() ?? Promise.resolve()]);
    combineCloseResults([...quiescenceResults, ...storeClose]);
  };
  const gracefulShutdown = quiescence.then(closeStoreAfterQuiescence);

  let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let forcedDrainTimer: ReturnType<typeof setTimeout> | undefined;
  const forcedShutdown = new Promise<void>((resolve, reject) => {
    if (!wasRunning && lifecycle === undefined) return;
    forceCloseTimer = setTimeout(() => {
      void (async () => {
        server.closeAllConnections();
        for (const socket of lifecycle?.sockets ?? []) socket.destroy();

        let resolveForcedDrain!: () => void;
        const forcedDrainDeadline = new Promise<void>((resolveDrain) => {
          resolveForcedDrain = resolveDrain;
        });
        forcedDrainTimer = setTimeout(resolveForcedDrain, forceCloseAfterMs);
        forcedDrainTimer.unref();
        const outcome = await Promise.race([
          quiescence.then((results) => ({ kind: "quiesced" as const, results })),
          forcedDrainDeadline.then(() => ({ kind: "timed_out" as const })),
        ]);
        if (outcome.kind === "timed_out") {
          throw new BizForgeShutdownTimeoutError(forceCloseAfterMs);
        }
        await closeStoreAfterQuiescence(outcome.results);
      })().then(resolve, reject);
    }, forceCloseAfterMs);
    forceCloseTimer.unref();
  });

  const shutdownPromise = Promise.race([gracefulShutdown, forcedShutdown]).finally(() => {
    if (forceCloseTimer !== undefined) clearTimeout(forceCloseTimer);
    if (forcedDrainTimer !== undefined) clearTimeout(forcedDrainTimer);
    for (const socket of lifecycle?.sockets ?? []) socket.destroy();
  });
  if (lifecycle !== undefined) lifecycle.shutdownPromise = shutdownPromise;
  return shutdownPromise;
}

export async function listenForBizForgeMcp(
  options: BizForgeHttpServerOptions = {},
): Promise<HttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8791;
  const server = createBizForgeHttpServer(options);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const lifecycle = serverLifecycles.get(server);
    try {
      await lifecycle?.finalizeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "MCP listen and cleanup both failed");
    }
    throw error;
  }
  return server;
}
