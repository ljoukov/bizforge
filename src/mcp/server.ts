import { McpServer, ResourceTemplate, createMcpHandler } from "@modelcontextprotocol/server";

import type { BizForgeDataStore } from "./data-store.js";
import { InMemoryBizForgeDataStore } from "./data-store.js";
import { buildSyntheticResearchBundle, seedSyntheticMockData } from "./mock-data.js";
import { createResponseEnvelope, registerBizForgeTools } from "./tools.js";

function requiredVariable(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Resource variable ${name} is required`);
  }
  return value;
}

function resourceContents(
  store: BizForgeDataStore,
  uri: URL,
  payload: unknown,
  isSynthetic: boolean,
  source: "mock_seed" | "mcp_write",
) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          createResponseEnvelope(payload, store.getDataStatus(), { isSynthetic, source }),
        ),
      },
    ],
  };
}

export function createBizForgeMcpServer(store: BizForgeDataStore): McpServer {
  const server = new McpServer(
    { name: "bizforge", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  registerBizForgeTools(server, store);

  server.registerResource(
    "bizforge-founder-snapshot",
    new ResourceTemplate("bizforge://founder-snapshots/{snapshotId}", { list: undefined }),
    {
      title: "Immutable BizForge founder snapshot",
      description: "Read-only view of one confirmed founder snapshot.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const snapshotId = requiredVariable(variables.snapshotId, "snapshotId");
      const record = store.getFounderProfile(snapshotId);
      if (record === undefined) throw new Error(`Founder snapshot ${snapshotId} was not found`);
      return resourceContents(
        store,
        uri,
        { profile: record.value },
        record.isSynthetic,
        record.source,
      );
    },
  );

  server.registerResource(
    "bizforge-research-bundle-version",
    new ResourceTemplate("bizforge://research-bundles/{bundleId}/versions/{version}", {
      list: undefined,
    }),
    {
      title: "Immutable BizForge research bundle version",
      description: "Read-only view of one exact research bundle version.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const bundleId = requiredVariable(variables.bundleId, "bundleId");
      const rawVersion = requiredVariable(variables.version, "version");
      const version = Number(rawVersion);
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new Error("Resource version must be a positive integer");
      }
      const record = store.getResearchBundle(bundleId, version);
      if (record === undefined)
        throw new Error(`Research bundle ${bundleId}:${version} was not found`);
      return resourceContents(
        store,
        uri,
        { bundle: record.value },
        record.isSynthetic,
        record.source,
      );
    },
  );

  server.registerResource(
    "bizforge-opportunity",
    new ResourceTemplate("bizforge://opportunities/{opportunityId}", { list: undefined }),
    {
      title: "BizForge opportunity projection",
      description: "Read-only opportunity view with an explicit buyer-evidence limitation.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const opportunityId = requiredVariable(variables.opportunityId, "opportunityId");
      const result = store.getOpportunity(opportunityId);
      if (result === undefined) {
        throw new Error(`Opportunity ${opportunityId} was not found`);
      }
      return resourceContents(
        store,
        uri,
        {
          opportunity: result.opportunity,
          buyerEvidenceStatus: "unlinked/hypothesis_only",
          buyerEvidenceWarning:
            "The current schema does not link economicBuyer text to buyer-specific claims.",
        },
        result.bundle.isSynthetic,
        result.bundle.source,
      );
    },
  );

  return server;
}

export function createSeededBizForgeDataStore(): InMemoryBizForgeDataStore {
  const store = new InMemoryBizForgeDataStore({
    researchBundleFactory: buildSyntheticResearchBundle,
  });
  seedSyntheticMockData(store);
  return store;
}

/** Shared process-local state; replace this object with a SQLite adapter in the next iteration. */
export const sharedBizForgeDataStore = createSeededBizForgeDataStore();

export function createBizForgeMcpHandler(store: BizForgeDataStore = sharedBizForgeDataStore) {
  return createMcpHandler(() => createBizForgeMcpServer(store), {
    legacy: "stateless",
    responseMode: "json",
  });
}
