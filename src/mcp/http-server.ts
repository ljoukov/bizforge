import { createServer, type Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";

import type { BizForgeDataStore } from "./data-store.js";
import { createBizForgeMcpHandler, sharedBizForgeDataStore } from "./server.js";

export interface BizForgeHttpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly store?: BizForgeDataStore;
}

export function createBizForgeHttpServer(options: BizForgeHttpServerOptions = {}): HttpServer {
  const store = options.store ?? sharedBizForgeDataStore;
  const handler = createBizForgeMcpHandler(store);
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer(async (request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          service: "bizforge-mcp",
          ...store.getDataStatus(),
        }),
      );
      return;
    }
    if (path !== "/mcp") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    await nodeHandler(request as Parameters<typeof nodeHandler>[0], response);
  });
  server.on("close", () => {
    void handler.close();
  });
  return server;
}

export async function listenForBizForgeMcp(
  options: BizForgeHttpServerOptions = {},
): Promise<HttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8791;
  const server = createBizForgeHttpServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const port = Number(process.env.BIZFORGE_MCP_PORT ?? "8791");
  void listenForBizForgeMcp({ port }).then(() => {
    process.stdout.write(`BizForge MCP listening at http://127.0.0.1:${port}/mcp\n`);
  });
}
