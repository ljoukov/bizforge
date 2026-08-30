import type { Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";

import {
  BizForgeShutdownTimeoutError,
  closeBizForgeHttpServer,
  listenForBizForgeMcp,
} from "./http-server.js";

export interface BizForgeSignalTarget {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface BizForgeShutdownHandlerOptions {
  readonly forceCloseAfterMs?: number;
  readonly signalTarget?: BizForgeSignalTarget;
  readonly onError?: (error: unknown) => void;
}

export interface BizForgeShutdownController {
  readonly shutdown: () => Promise<void>;
  readonly dispose: () => void;
}

export function installBizForgeShutdownHandlers(
  server: HttpServer,
  options: BizForgeShutdownHandlerOptions = {},
): BizForgeShutdownController {
  const signalTarget = options.signalTarget ?? process;
  const reportError =
    options.onError ??
    ((error: unknown) => {
      process.exitCode = 1;
      if (error instanceof BizForgeShutdownTimeoutError) {
        process.stderr.write("BizForge MCP shutdown timed out; forcing process exit.\n");
        process.exit();
      }
    });
  let shutdownPromise: Promise<void> | undefined;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signalTarget.off("SIGINT", handleSignal);
    signalTarget.off("SIGTERM", handleSignal);
    server.off("close", dispose);
  };
  const shutdown = () => {
    shutdownPromise ??= closeBizForgeHttpServer(server, {
      ...(options.forceCloseAfterMs === undefined
        ? {}
        : { forceCloseAfterMs: options.forceCloseAfterMs }),
    }).finally(dispose);
    return shutdownPromise;
  };
  const handleSignal = () => {
    void shutdown().catch(reportError);
  };

  signalTarget.once("SIGINT", handleSignal);
  signalTarget.once("SIGTERM", handleSignal);
  server.once("close", dispose);
  return { shutdown, dispose };
}

export async function runBizForgeMcpEntrypoint(
  port = Number(process.env.BIZFORGE_MCP_PORT ?? "8791"),
) {
  const server = await listenForBizForgeMcp({ port });
  installBizForgeShutdownHandlers(server);
  process.stdout.write(`BizForge MCP listening at http://127.0.0.1:${port}/mcp\n`);
  return server;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  void runBizForgeMcpEntrypoint();
}
