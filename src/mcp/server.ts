import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createMcpHandler, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";

import type { BizForgeDataStore } from "./data-store.js";
import { canonicalContentSha256 } from "./integrity.js";
import { SqliteBizForgeDataStore } from "./sqlite-data-store.js";
import { registerBizForgeTools } from "./tools.js";

const DEFAULT_DATABASE_PATH = ".data/bizforge.sqlite";

export interface BizForgeDataStoreConfiguration {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function requiredVariable(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Resource variable ${name} is required`);
  }
  return value;
}

function resourceContents(uri: URL, payload: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({
          schemaVersion: "1.0.0",
          contentSha256: canonicalContentSha256(payload),
          payload,
        }),
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
    "bizforge-evidence",
    new ResourceTemplate("bizforge://evidence/{evidenceId}", { list: undefined }),
    {
      title: "Stored BizForge evidence extract",
      description:
        "Read-only view of the stored minimized canonical EvidenceItem, not the provider payload.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const evidenceId = requiredVariable(variables.evidenceId, "evidenceId");
      const record = store.getEvidence(evidenceId);
      if (record === undefined) throw new Error(`Evidence ${evidenceId} was not found`);
      return resourceContents(uri, { evidence: record.value });
    },
  );

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
      return resourceContents(uri, { profile: record.value });
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
      return resourceContents(uri, { bundle: record.value });
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
      return resourceContents(uri, {
        opportunity: result.opportunity,
        buyerEvidenceStatus: "unlinked/hypothesis_only",
        buyerEvidenceWarning:
          "The current schema does not link economicBuyer text to buyer-specific claims.",
      });
    },
  );

  return server;
}

/** Creates the SQLite-backed runtime store when called. */
export function createConfiguredBizForgeDataStore(
  configuration: BizForgeDataStoreConfiguration = {},
): BizForgeDataStore {
  const environment = configuration.environment ?? process.env;
  const configuredPath = environment.BIZFORGE_DB_PATH ?? DEFAULT_DATABASE_PATH;
  if (configuredPath.trim().length === 0) {
    throw new Error("BIZFORGE_DB_PATH must not be empty");
  }
  const databasePath = resolve(configuration.cwd ?? process.cwd(), configuredPath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const store = new SqliteBizForgeDataStore(databasePath);
  try {
    chmodSync(databasePath, 0o600);
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}

export function createBizForgeMcpHandler(store: BizForgeDataStore) {
  return createMcpHandler(() => createBizForgeMcpServer(store), {
    legacy: "stateless",
    responseMode: "json",
  });
}
