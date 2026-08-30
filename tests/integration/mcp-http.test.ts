import type { AddressInfo } from "node:net";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { DataStoreStatus } from "../../src/mcp/contracts.js";
import { type BizForgeDataStore, InMemoryBizForgeDataStore } from "../../src/mcp/data-store.js";
import { createBizForgeHttpServer } from "../../src/mcp/http-server.js";
import { createSeededBizForgeDataStore } from "../../src/mcp/server.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as JsonObject;
}

function payloadOf(result: { structuredContent?: unknown }): JsonObject {
  return asObject(asObject(result.structuredContent).payload);
}

class PersistentTestDataStore extends InMemoryBizForgeDataStore {
  override getDataStatus(): DataStoreStatus {
    return {
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
      warnings: [],
    };
  }
}

async function startServer(store: BizForgeDataStore = createSeededBizForgeDataStore()) {
  const server = createBizForgeHttpServer({ store });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

describe("BizForge MCP HTTP server", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });

  it("serves the complete synthetic Step 1 -> mock Step 2 -> Step 3 flow", async () => {
    const { server, baseUrl } = await startServer();
    const client = new Client({ name: "bizforge-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    cleanup.push(async () => {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await client.connect(transport);

    const listed = await client.listTools();
    const expectedTools = [
      "bizforge_get_data_status",
      "bizforge_create_founder_setup_run",
      "bizforge_get_founder_setup_run",
      "bizforge_transition_founder_setup_run",
      "bizforge_record_consent",
      "bizforge_get_consent",
      "bizforge_put_evidence",
      "bizforge_get_evidence",
      "bizforge_validate_founder_profile_snapshot",
      "bizforge_save_confirmed_founder_profile",
      "bizforge_get_confirmed_founder_profile",
      "bizforge_request_founder_data_deletion",
      "bizforge_get_deletion_status",
      "bizforge_save_research_bundle",
      "bizforge_get_research_bundle",
      "bizforge_get_latest_research_bundle",
      "bizforge_list_opportunities",
      "bizforge_get_opportunity",
      "bizforge_get_market_signals",
      "bizforge_get_growth_chart_data",
    ];
    expect(listed.tools.map(({ name }) => name)).toEqual(expectedTools);
    expect(
      listed.tools.find(({ name }) => name === "bizforge_get_data_status")?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(
      listed.tools.find(({ name }) => name === "bizforge_request_founder_data_deletion")
        ?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    for (const tool of listed.tools) {
      const outputSchema = asObject(tool.outputSchema);
      expect(outputSchema.type, `${tool.name} must return an object envelope`).toBe("object");
      const properties = asObject(outputSchema.properties);
      const payloadSchema = asObject(properties.payload);
      expect(
        Object.keys(payloadSchema).length,
        `${tool.name} must expose an explicit payload output schema`,
      ).toBeGreaterThan(0);
    }

    const status = await client.callTool({ name: "bizforge_get_data_status", arguments: {} });
    expect(asObject(status.structuredContent)).toMatchObject({
      dataMode: "mock",
      storageMode: "mock",
      storageBackend: "memory",
      persistenceStatus: "mock_ephemeral",
      isMock: true,
      ephemeral: true,
    });
    expect(payloadOf(status)).toMatchObject({
      capabilities: { buyerEvidenceProjection: false, opportunityRerank: false },
    });
    const missingMockAcceptance = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: {
        founderId: "founder-missing-mock-acceptance",
        isSynthetic: true,
      },
    });
    expect(missingMockAcceptance.isError).toBe(true);
    expect(JSON.stringify(missingMockAcceptance.content)).toContain("acceptMockStorage: true");

    const seededRunReplay = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: {
        founderId: "founder-synthetic-demo",
        setupRunId: "setup-synthetic-demo",
        isSynthetic: true,
        acceptMockStorage: true,
      },
    });
    expect(asObject(seededRunReplay.structuredContent).source).toBe("mock_seed");
    const seededConsentReplay = await client.callTool({
      name: "bizforge_record_consent",
      arguments: {
        acceptMockStorage: true,
        consent: {
          consentId: "consent-self-report-synthetic-demo",
          setupRunId: "setup-synthetic-demo",
          founderId: "founder-synthetic-demo",
          scope: "retain_minimized_founder_self_report",
          status: "active",
          sourceUrls: [],
          recordedAt: "2026-08-01T12:00:00.000Z",
          grantedAt: "2026-08-01T12:00:00.000Z",
        },
      },
    });
    expect(asObject(seededConsentReplay.structuredContent).source).toBe("mock_seed");

    const seededEvidenceResult = await client.callTool({
      name: "bizforge_get_evidence",
      arguments: { evidenceId: "evidence-founder-synthetic-demo" },
    });
    const seededEvidence = payloadOf(seededEvidenceResult).evidence as JsonObject;
    const seededEvidenceReplay = await client.callTool({
      name: "bizforge_put_evidence",
      arguments: {
        setupRunId: "setup-synthetic-demo",
        evidence: seededEvidence,
        isSynthetic: true,
        acceptMockStorage: true,
      },
    });
    expect(asObject(seededEvidenceReplay.structuredContent).source).toBe("mock_seed");

    const seededProfileResult = await client.callTool({
      name: "bizforge_get_confirmed_founder_profile",
      arguments: { snapshotId: "snapshot-synthetic-demo" },
    });
    const seededProfile = payloadOf(seededProfileResult).profile as JsonObject;
    const seededConfirmationReplay = await client.callTool({
      name: "bizforge_save_confirmed_founder_profile",
      arguments: {
        setupRunId: "setup-synthetic-demo",
        expectedVersion: 3,
        idempotencyKey: "seed-confirm",
        profile: seededProfile,
        isSynthetic: true,
        acceptMockStorage: true,
      },
    });
    expect(
      seededConfirmationReplay.isError,
      JSON.stringify(seededConfirmationReplay.content),
    ).not.toBe(true);
    expect(asObject(seededConfirmationReplay.structuredContent).source).toBe("mock_seed");

    const seededBundleResult = await client.callTool({
      name: "bizforge_get_latest_research_bundle",
      arguments: { founderId: "founder-synthetic-demo" },
    });
    const seededBundle = payloadOf(seededBundleResult).bundle as JsonObject;
    const seededBundleReplay = await client.callTool({
      name: "bizforge_save_research_bundle",
      arguments: {
        bundle: seededBundle,
        isSynthetic: true,
        acceptMockStorage: true,
      },
    });
    expect(asObject(seededBundleReplay.structuredContent).source).toBe("mock_seed");
    for (const [name, arguments_] of [
      ["bizforge_get_founder_setup_run", { setupRunId: "missing" }],
      ["bizforge_get_evidence", { evidenceId: "missing" }],
      ["bizforge_get_confirmed_founder_profile", { snapshotId: "missing" }],
      ["bizforge_get_research_bundle", { bundleId: "missing" }],
      ["bizforge_get_deletion_status", { deletionRequestId: "missing" }],
    ] as const) {
      expect((await client.callTool({ name, arguments: arguments_ })).isError).toBe(true);
    }
    const rejectedRealData = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: {
        founderId: "founder-rejected-real-data",
        isSynthetic: false,
        acceptMockStorage: true,
      },
    });
    expect(rejectedRealData.isError).toBe(true);
    expect(JSON.stringify(rejectedRealData.content)).toContain("synthetic records only");
    const autoRun = payloadOf(
      await client.callTool({
        name: "bizforge_create_founder_setup_run",
        arguments: {
          founderId: "founder-auto-id",
          isSynthetic: true,
          acceptMockStorage: true,
        },
      }),
    );
    expect(asObject(autoRun.run).setupRunId).toMatch(/^setup-/);
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_get_latest_research_bundle",
          arguments: {},
        }),
      ),
    ).toHaveProperty("bundle");

    const seedEvidence = seededEvidence;

    const founderId = "founder-e2e";
    const setupRunId = "setup-e2e";
    const evidenceId = "evidence-e2e";
    const snapshotId = "snapshot-e2e";
    const createResult = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: { founderId, setupRunId, isSynthetic: true, acceptMockStorage: true },
    });
    expect(payloadOf(createResult)).toMatchObject({
      run: { state: "CONSENT_PENDING", version: 1 },
    });
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_get_founder_setup_run",
          arguments: { setupRunId },
        }),
      ),
    ).toMatchObject({ run: { founderId, version: 1 } });

    for (const [consentId, scope] of [
      ["consent-self-report-e2e", "retain_minimized_founder_self_report"],
      ["consent-retain-e2e", "retain_minimized_founder_snapshot"],
      ["consent-research-e2e", "use_confirmed_founder_snapshot_for_research"],
    ]) {
      const consentResult = await client.callTool({
        name: "bizforge_record_consent",
        arguments: {
          acceptMockStorage: true,
          consent: {
            consentId,
            setupRunId,
            founderId,
            scope,
            status: "active",
            sourceUrls: [],
            recordedAt: "2026-08-01T12:00:00.000Z",
            grantedAt: "2026-08-01T12:00:00.000Z",
          },
        },
      });
      expect(consentResult.isError).not.toBe(true);
    }
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_get_consent",
          arguments: { setupRunId, scope: "retain_minimized_founder_snapshot" },
        }),
      ).consents,
    ).toHaveLength(1);

    const evidence = {
      ...seedEvidence,
      evidenceId,
      title: "Synthetic e2e founder competency",
      provenance: {
        ...asObject(seedEvidence.provenance),
        sourceRecordId: "synthetic-e2e-input",
      },
      rawArtifactRef: "mock://synthetic/e2e-founder-input",
    };
    const putResult = await client.callTool({
      name: "bizforge_put_evidence",
      arguments: { setupRunId, evidence, isSynthetic: true, acceptMockStorage: true },
    });
    expect(payloadOf(putResult)).toMatchObject({ evidence: { evidenceId } });

    await client.callTool({
      name: "bizforge_transition_founder_setup_run",
      arguments: {
        setupRunId,
        expectedVersion: 1,
        targetState: "INTERVIEW",
        idempotencyKey: "e2e-interview",
        acceptMockStorage: true,
      },
    });
    const review = await client.callTool({
      name: "bizforge_transition_founder_setup_run",
      arguments: {
        setupRunId,
        expectedVersion: 2,
        targetState: "DRAFT_REVIEW",
        idempotencyKey: "e2e-review",
        stateData: { readyForDraft: true },
        acceptMockStorage: true,
      },
    });
    expect(payloadOf(review)).toMatchObject({ run: { state: "DRAFT_REVIEW", version: 3 } });

    const profile = {
      snapshotId,
      founderId,
      displayName: "Synthetic E2E Founder",
      competencies: [
        {
          name: "Workflow automation",
          level: "working",
          evidenceIds: [evidenceId],
          confidence: { lower: 0.25, estimate: 0.5, upper: 0.75 },
        },
      ],
      businessAppetite: {
        hoursPerWeek: 12,
        capitalBudgetUsd: 1_500,
        timeToFirstRevenueDays: 35,
        teamSize: 1,
        preferredOfferTypes: ["hybrid"],
        preferredCustomerTypes: ["smb"],
        salesTolerance: "medium",
        riskTolerance: "medium",
        regulatoryTolerance: "low",
      },
      constraints: ["Synthetic e2e only"],
      accessAdvantages: [],
      sourceEvidenceIds: [evidenceId],
      claims: { observed: [], inferred: [], assumptions: [] },
      capturedAt: "2026-08-01T12:00:00.000Z",
      confirmedAt: "2026-08-29T12:00:00.000Z",
    };
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_validate_founder_profile_snapshot",
          arguments: { snapshot: { ...profile, confirmedAt: undefined }, confirmationLevel: false },
        }),
      ),
    ).toMatchObject({ valid: true, validator: "FounderProfileSnapshotSchema" });
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_validate_founder_profile_snapshot",
          arguments: { snapshot: { ...profile, confirmedAt: undefined }, confirmationLevel: true },
        }),
      ),
    ).toMatchObject({ valid: false, validator: "ConfirmedFounderProfileSnapshotSchema" });

    const published = payloadOf(
      await client.callTool({
        name: "bizforge_save_confirmed_founder_profile",
        arguments: {
          setupRunId,
          expectedVersion: 3,
          idempotencyKey: "e2e-confirm",
          profile,
          isSynthetic: true,
          acceptMockStorage: true,
        },
      }),
    );
    expect(published).toMatchObject({
      stage2HandoffEligible: false,
      mockStep2DemoEligible: true,
      mockStep2Bundle: { founderProfileSnapshotId: snapshotId },
    });
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_get_confirmed_founder_profile",
          arguments: { snapshotId },
        }),
      ),
    ).toMatchObject({ profile: { snapshotId } });

    const latest = payloadOf(
      await client.callTool({
        name: "bizforge_get_latest_research_bundle",
        arguments: { founderId },
      }),
    );
    const bundle = asObject(latest.bundle);
    expect(bundle).toMatchObject({ founderProfile: { snapshotId } });
    const bundleId = String(bundle.bundleId);
    const bundleVersion = Number(bundle.bundleVersion);
    const opportunities = asObject(
      payloadOf(
        await client.callTool({
          name: "bizforge_list_opportunities",
          arguments: { bundleId, bundleVersion },
        }),
      ),
    ).opportunities as JsonObject[];
    expect(opportunities[0]).toMatchObject({ buyerEvidenceStatus: "unlinked/hypothesis_only" });
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_list_opportunities",
          arguments: { founderId },
        }),
      ),
    ).toHaveProperty("opportunities");
    const opportunityId = String(opportunities[0]?.opportunityId);
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_get_opportunity",
          arguments: { bundleId, bundleVersion, opportunityId },
        }),
      ),
    ).toMatchObject({ buyerEvidenceStatus: "unlinked/hypothesis_only" });
    const signals = payloadOf(
      await client.callTool({
        name: "bizforge_get_market_signals",
        arguments: { bundleId, bundleVersion },
      }),
    ).marketSignals as JsonObject[];
    expect(signals).toHaveLength(1);
    const signalId = String(signals[0]?.signalId);
    const growth = payloadOf(
      await client.callTool({
        name: "bizforge_get_growth_chart_data",
        arguments: { bundleId, bundleVersion, signalId },
      }),
    );
    expect(growth).toMatchObject({
      charts: [
        {
          eligible: true,
          demoEligible: true,
          absoluteChange: 15,
          percentageChange: 62.5,
          sampleSize: 39,
          distinctEntityCount: 31,
          inferenceStatus: "synthetic_evidence_backed_inference",
        },
      ],
    });
    expect(
      (
        await client.callTool({
          name: "bizforge_get_growth_chart_data",
          arguments: { bundleId, bundleVersion, signalId: "missing" },
        })
      ).isError,
    ).toBe(true);

    for (const [direction, values] of [
      ["concentrated", { value: 39, absoluteChange: 15, percentageChange: 62.5 }],
      ["unknown", { value: 39, absoluteChange: 15, percentageChange: 62.5 }],
      ["falling", { value: 20, absoluteChange: -4, percentageChange: -16.666666666666664 }],
      ["stable", { value: 24, absoluteChange: 0, percentageChange: 0 }],
    ] as const) {
      const directionBundle = structuredClone(bundle);
      directionBundle.bundleId = `bundle-direction-${direction}`;
      const signal = (directionBundle.marketSignals as JsonObject[])[0];
      if (signal === undefined) throw new Error("expected market signal");
      const measurement = asObject(signal.measurement);
      signal.measurement = { ...measurement, direction, ...values };
      const savedDirection = await client.callTool({
        name: "bizforge_save_research_bundle",
        arguments: {
          bundle: directionBundle,
          isSynthetic: true,
          acceptMockStorage: true,
        },
      });
      expect(savedDirection.isError).not.toBe(true);
      expect(
        payloadOf(
          await client.callTool({
            name: "bizforge_get_growth_chart_data",
            arguments: { bundleId: directionBundle.bundleId },
          }),
        ),
      ).toMatchObject({
        charts: [{ eligible: false, inferenceStatus: "insufficient_growth_inputs" }],
      });
    }

    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_get_research_bundle",
          arguments: { bundleId, bundleVersion },
        }),
      ),
    ).toMatchObject({ bundle: { bundleId, bundleVersion } });
    const savedAgain = await client.callTool({
      name: "bizforge_save_research_bundle",
      arguments: { bundle, isSynthetic: true, acceptMockStorage: true },
    });
    expect(savedAgain.isError).not.toBe(true);

    const founderResource = await client.readResource({
      uri: `bizforge://founder-snapshots/${snapshotId}`,
    });
    expect(founderResource.contents[0]).toMatchObject({ mimeType: "application/json" });
    const bundleResource = await client.readResource({
      uri: `bizforge://research-bundles/${bundleId}/versions/${bundleVersion}`,
    });
    expect(bundleResource.contents).toHaveLength(1);
    const opportunityResource = await client.readResource({
      uri: `bizforge://opportunities/${opportunityId}`,
    });
    expect(opportunityResource.contents).toHaveLength(1);
    await expect(
      client.readResource({ uri: "bizforge://founder-snapshots/missing" }),
    ).rejects.toThrow(/not found/);
    await expect(
      client.readResource({
        uri: `bizforge://research-bundles/${bundleId}/versions/not-a-number`,
      }),
    ).rejects.toThrow(/positive integer/);
    await expect(client.readResource({ uri: "bizforge://opportunities/missing" })).rejects.toThrow(
      /not found/,
    );

    const deletionResult = await client.callTool({
      name: "bizforge_request_founder_data_deletion",
      arguments: {
        setupRunId,
        founderId,
        reason: "E2E cleanup",
        idempotencyKey: "e2e-delete",
        acceptMockStorage: true,
      },
    });
    expect(asObject(deletionResult.structuredContent).source).toBe("mcp_write");
    const deletion = payloadOf(deletionResult);
    const deletionRequestId = String(asObject(deletion.deletion).deletionRequestId);
    const deletionReplay = await client.callTool({
      name: "bizforge_request_founder_data_deletion",
      arguments: {
        setupRunId,
        founderId,
        reason: "E2E cleanup",
        idempotencyKey: "e2e-delete",
        acceptMockStorage: true,
      },
    });
    expect(asObject(deletionReplay.structuredContent).source).toBe("mcp_write");
    expect(payloadOf(deletionReplay)).toEqual(deletion);
    expect(
      payloadOf(
        await client.callTool({
          name: "bizforge_get_deletion_status",
          arguments: { deletionRequestId },
        }),
      ),
    ).toMatchObject({ deletion: { status: "pending_expiry" } });
  });

  it("keeps the tool contract backend-neutral for a persistent adapter", async () => {
    const { server, baseUrl } = await startServer(new PersistentTestDataStore());
    const client = new Client({ name: "bizforge-persistent-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    cleanup.push(async () => {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await client.connect(transport);

    const listed = await client.listTools();
    for (const toolName of [
      "bizforge_create_founder_setup_run",
      "bizforge_transition_founder_setup_run",
      "bizforge_record_consent",
      "bizforge_put_evidence",
      "bizforge_save_confirmed_founder_profile",
      "bizforge_request_founder_data_deletion",
      "bizforge_save_research_bundle",
    ]) {
      const tool = listed.tools.find(({ name }) => name === toolName);
      if (tool === undefined) throw new Error(`missing tool ${toolName}`);
      const inputSchema = asObject(tool.inputSchema);
      const properties = asObject(inputSchema.properties);
      expect(asObject(properties.acceptMockStorage)).toMatchObject({
        type: "boolean",
        default: false,
      });
      expect(inputSchema.required as unknown[] | undefined).not.toContain("acceptMockStorage");
    }
    for (const toolName of [
      "bizforge_create_founder_setup_run",
      "bizforge_put_evidence",
      "bizforge_save_confirmed_founder_profile",
      "bizforge_save_research_bundle",
    ]) {
      const tool = listed.tools.find(({ name }) => name === toolName);
      if (tool === undefined) throw new Error(`missing tool ${toolName}`);
      const inputSchema = asObject(tool.inputSchema);
      const properties = asObject(inputSchema.properties);
      expect(asObject(properties.isSynthetic)).toMatchObject({ type: "boolean" });
      expect(asObject(properties.isSynthetic)).not.toHaveProperty("const");
      expect(asObject(properties.isSynthetic)).not.toHaveProperty("default");
      expect(inputSchema.required as unknown[] | undefined).toContain("isSynthetic");
    }

    const status = await client.callTool({ name: "bizforge_get_data_status", arguments: {} });
    expect(asObject(status.structuredContent)).toMatchObject({
      dataMode: "persistent",
      storageMode: "persistent",
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
      isMock: false,
      ephemeral: false,
      provenanceMode: "recorded_data",
      writePolicy: {
        requiresExplicitMockAcceptance: false,
        acceptsNonSyntheticWrites: true,
      },
    });
    expect(payloadOf(status)).toMatchObject({
      capabilities: { mockStep2Synthesis: false },
    });

    const founderId = "founder-persistent";
    const setupRunId = "setup-persistent";
    const evidenceId = "evidence-persistent";
    const snapshotId = "snapshot-persistent";
    const created = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: { founderId, setupRunId, isSynthetic: false },
    });
    expect(created.isError).not.toBe(true);
    expect(asObject(created.structuredContent)).toMatchObject({
      storageBackend: "sqlite",
      isMock: false,
      ephemeral: false,
      isSynthetic: false,
      provenanceMode: "recorded_data",
    });

    for (const [consentId, scope] of [
      ["consent-self-report-persistent", "retain_minimized_founder_self_report"],
      ["consent-retain-persistent", "retain_minimized_founder_snapshot"],
      ["consent-research-persistent", "use_confirmed_founder_snapshot_for_research"],
    ]) {
      const result = await client.callTool({
        name: "bizforge_record_consent",
        arguments: {
          consent: {
            consentId,
            setupRunId,
            founderId,
            scope,
            status: "active",
            sourceUrls: [],
            recordedAt: "2026-08-01T12:00:00.000Z",
            grantedAt: "2026-08-01T12:00:00.000Z",
          },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(asObject(result.structuredContent).storageBackend).toBe("sqlite");
    }

    const evidence = {
      evidenceId,
      evidenceType: "user_input",
      title: "Founder competency",
      summary: "The founder reports workflow automation experience.",
      provenance: {
        provider: "first-party founder interview",
        collectionMethod: "user_input",
        sourceRecordId: "persistent-founder-input",
        retrievedAt: "2026-08-01T12:00:00.000Z",
        contentSha256: "b".repeat(64),
      },
      observedAt: "2026-08-01T12:00:00.000Z",
      rawArtifactRef: "sqlite://evidence/persistent-founder-input",
      locator: { jsonPointer: "/founder/competencies/0" },
      extraction: { method: "manual", version: "test-v1" },
      attributes: {},
      tags: ["founder-self-report"],
    };
    const storedEvidence = await client.callTool({
      name: "bizforge_put_evidence",
      arguments: { setupRunId, evidence, isSynthetic: false },
    });
    expect(storedEvidence.isError).not.toBe(true);
    expect(asObject(storedEvidence.structuredContent)).toMatchObject({
      storageBackend: "sqlite",
      isSynthetic: false,
    });

    for (const [expectedVersion, targetState, idempotencyKey] of [
      [1, "INTERVIEW", "persistent-interview"],
      [2, "DRAFT_REVIEW", "persistent-review"],
    ] as const) {
      const transition = await client.callTool({
        name: "bizforge_transition_founder_setup_run",
        arguments: { setupRunId, expectedVersion, targetState, idempotencyKey },
      });
      expect(transition.isError).not.toBe(true);
    }

    const profile = {
      snapshotId,
      founderId,
      displayName: "Persistent Founder",
      competencies: [
        {
          name: "Workflow automation",
          level: "working",
          evidenceIds: [evidenceId],
          confidence: { lower: 0.25, estimate: 0.5, upper: 0.75 },
        },
      ],
      businessAppetite: {
        hoursPerWeek: 12,
        capitalBudgetUsd: 1_500,
        timeToFirstRevenueDays: 35,
        teamSize: 1,
        preferredOfferTypes: ["hybrid"],
        preferredCustomerTypes: ["smb"],
        salesTolerance: "medium",
        riskTolerance: "medium",
        regulatoryTolerance: "low",
      },
      constraints: [],
      accessAdvantages: [],
      sourceEvidenceIds: [evidenceId],
      claims: { observed: [], inferred: [], assumptions: [] },
      capturedAt: "2026-08-01T12:00:00.000Z",
      confirmedAt: "2026-08-29T12:00:00.000Z",
    };
    const published = await client.callTool({
      name: "bizforge_save_confirmed_founder_profile",
      arguments: {
        setupRunId,
        expectedVersion: 3,
        idempotencyKey: "persistent-confirm",
        profile,
        isSynthetic: false,
      },
    });
    expect(published.isError, JSON.stringify(published.content)).not.toBe(true);
    expect(asObject(published.structuredContent)).toMatchObject({
      storageBackend: "sqlite",
      isMock: false,
      ephemeral: false,
      isSynthetic: false,
    });
    expect(payloadOf(published)).toMatchObject({
      stage2HandoffEligible: true,
      mockStep2DemoEligible: false,
      mockStep2Bundle: null,
    });
  });

  it("serves health and rejects cross-origin or unknown routes", async () => {
    const { server, baseUrl } = await startServer();
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await expect(
      fetch(`${baseUrl}/healthz`).then((response) => response.json()),
    ).resolves.toMatchObject({
      ok: true,
      dataMode: "mock",
      storageBackend: "memory",
      ephemeral: true,
    });
    expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/healthz`, {
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });
});
