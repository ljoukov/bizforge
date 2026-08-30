import { pathToFileURL } from "node:url";

import { listenForBizForgeMcp } from "./http-server.js";

export async function runBizForgeMcpEntrypoint(
  port = Number(process.env.BIZFORGE_MCP_PORT ?? "8791"),
) {
  const server = await listenForBizForgeMcp({ port });
  process.stdout.write(`BizForge MCP listening at http://127.0.0.1:${port}/mcp\n`);
  return server;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  void runBizForgeMcpEntrypoint();
}
