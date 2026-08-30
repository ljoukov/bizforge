import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { BizForgeDataStore } from "../../src/mcp/data-store.js";
import { createBizForgeHttpServer, listenForBizForgeMcp } from "../../src/mcp/http-server.js";
import {
  createConfiguredBizForgeDataStore,
  createSeededBizForgeDataStore,
} from "../../src/mcp/server.js";
import { SqliteBizForgeDataStore } from "../../src/mcp/sqlite-data-store.js";

type JsonObject = Record<string, unknown>;

const createRequestIds = {
  missingMockAcceptance: "00000000-0000-4000-8000-000000000001",
  seededReplay: "00000000-0000-4000-8000-000000000002",
  rejectedRealData: "00000000-0000-4000-8000-000000000003",
  generatedRun: "00000000-0000-4000-8000-000000000004",
  explicitReplay: "00000000-0000-4000-8000-000000000005",
  endToEnd: "00000000-0000-4000-8000-000000000006",
  persistent: "00000000-0000-4000-8000-000000000007",
  persistentSynthetic: "00000000-0000-4000-8000-000000000008",
} as const;

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as JsonObject;
}

function payloadOf(result: { structuredContent?: unknown }): JsonObject {
  return asObject(asObject(result.structuredContent).payload);
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
    const growthOutputSchema = listed.tools.find(
      ({ name }) => name === "bizforge_get_growth_chart_data",
    )?.outputSchema;
    expect(growthOutputSchema).toBeDefined();
    expect(JSON.stringify(growthOutputSchema)).not.toContain('"prefixItems"');
    expect(JSON.stringify(growthOutputSchema)).not.toContain('"items":false');
    const createSetupTool = listed.tools.find(
      ({ name }) => name === "bizforge_create_founder_setup_run",
    );
    if (createSetupTool === undefined) throw new Error("missing setup creation tool");
    const createSetupInputSchema = asObject(createSetupTool.inputSchema);
    expect(createSetupInputSchema.required as unknown[] | undefined).not.toContain("founderId");
    expect(createSetupInputSchema.required as unknown[] | undefined).not.toContain("setupRunId");
    expect(createSetupInputSchema.required as unknown[] | undefined).not.toContain(
      "clientRequestId",
    );
    expect(createSetupTool.title).toContain("server-assigned");
    expect(createSetupTool.description).toContain("never ask the end user");
    expect(createSetupTool.annotations).toMatchObject({ idempotentHint: false });
    expect(asObject(asObject(createSetupInputSchema.properties).clientRequestId)).toMatchObject({
      format: "uuid",
    });
    expect(
      asObject(asObject(createSetupInputSchema.properties).clientRequestId).description,
    ).toContain("never request it from an end user");
    expect(asObject(asObject(createSetupInputSchema.properties).founderId).description).toContain(
      "Never request this ID from an end user",
    );
    expect(asObject(asObject(createSetupInputSchema.properties).setupRunId).description).toContain(
      "Never request this ID from an end user",
    );

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
        clientRequestId: createRequestIds.missingMockAcceptance,
        founderId: "founder-missing-mock-acceptance",
        isSynthetic: true,
      },
    });
    expect(missingMockAcceptance.isError).toBe(true);
    expect(JSON.stringify(missingMockAcceptance.content)).toContain("acceptMockStorage: true");

    const seededRunReplay = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: {
        clientRequestId: createRequestIds.seededReplay,
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
        clientRequestId: createRequestIds.rejectedRealData,
        founderId: "founder-rejected-real-data",
        isSynthetic: false,
        acceptMockStorage: true,
      },
    });
    expect(rejectedRealData.isError).toBe(true);
    expect(JSON.stringify(rejectedRealData.content)).toContain("synthetic records only");
    const legacyUnkeyedRun = payloadOf(
      await client.callTool({
        name: "bizforge_create_founder_setup_run",
        arguments: {
          isSynthetic: true,
          acceptMockStorage: true,
        },
      }),
    );
    expect(asObject(legacyUnkeyedRun.run).setupRunId).toMatch(/^setup-/);
    expect(asObject(legacyUnkeyedRun.run).founderId).toMatch(/^founder-/);
    const generatedRunArguments = {
      clientRequestId: createRequestIds.generatedRun,
      isSynthetic: true,
      acceptMockStorage: true,
    };
    const autoRun = payloadOf(
      await client.callTool({
        name: "bizforge_create_founder_setup_run",
        arguments: generatedRunArguments,
      }),
    );
    expect(asObject(autoRun.run).setupRunId).toMatch(/^setup-/);
    expect(asObject(autoRun.run).founderId).toMatch(/^founder-/);
    const retriedAutoRun = payloadOf(
      await client.callTool({
        name: "bizforge_create_founder_setup_run",
        arguments: generatedRunArguments,
      }),
    );
    expect(retriedAutoRun.run).toEqual(autoRun.run);
    const conflictingAutoRun = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: { ...generatedRunArguments, founderId: "founder-conflicting-retry" },
    });
    expect(conflictingAutoRun.isError).toBe(true);
    expect(JSON.stringify(conflictingAutoRun.content)).toContain(
      "clientRequestId was already used with different parameters",
    );
    const explicitReplayWithoutFounder = payloadOf(
      await client.callTool({
        name: "bizforge_create_founder_setup_run",
        arguments: {
          clientRequestId: createRequestIds.explicitReplay,
          setupRunId: "setup-synthetic-demo",
          isSynthetic: true,
          acceptMockStorage: true,
        },
      }),
    );
    expect(explicitReplayWithoutFounder).toMatchObject({
      run: {
        setupRunId: "setup-synthetic-demo",
        founderId: "founder-synthetic-demo",
      },
    });
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
      arguments: {
        clientRequestId: createRequestIds.endToEnd,
        founderId,
        setupRunId,
        isSynthetic: true,
        acceptMockStorage: true,
      },
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

    for (const [name, toolArguments, message] of [
      [
        "bizforge_list_opportunities",
        { bundleId: "missing-bundle", bundleVersion: 1 },
        "No matching research bundle",
      ],
      [
        "bizforge_get_opportunity",
        { bundleId, bundleVersion, opportunityId: "missing-opportunity" },
        "Opportunity missing-opportunity was not found",
      ],
      [
        "bizforge_get_latest_research_bundle",
        { founderId: "missing-founder" },
        "No matching research bundle",
      ],
    ] as const) {
      const missingResult = await client.callTool({ name, arguments: toolArguments });
      expect(missingResult.isError).toBe(true);
      expect(JSON.stringify(missingResult.content)).toContain(message);
    }

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

    const evidenceResource = await client.readResource({
      uri: `bizforge://evidence/${evidenceId}`,
    });
    expect(evidenceResource.contents[0]).toMatchObject({ mimeType: "application/json" });
    const evidenceContent = evidenceResource.contents[0];
    if (evidenceContent === undefined || !("text" in evidenceContent)) {
      throw new Error("Expected text evidence resource content");
    }
    expect(JSON.parse(evidenceContent.text)).toMatchObject({
      payload: { evidence: { evidenceId } },
    });
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
    await expect(client.readResource({ uri: "bizforge://evidence/missing" })).rejects.toThrow(
      /not found/,
    );
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

  it("persists the backend-neutral tool contract across a SQLite restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bizforge-mcp-http-"));
    const databasePath = join(directory, "bizforge.sqlite");
    const firstStore = new SqliteBizForgeDataStore(databasePath);
    const { server, baseUrl } = await startServer(firstStore);
    const client = new Client({ name: "bizforge-persistent-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    let clientClosed = false;
    let serverClosed = false;
    let restartedStore: SqliteBizForgeDataStore | undefined;
    let restartedServer: ReturnType<typeof createBizForgeHttpServer> | undefined;
    let restartedClient: Client | undefined;
    let restartedClientClosed = false;
    let restartedServerClosed = false;
    cleanup.push(async () => {
      if (!clientClosed) await client.close();
      if (!serverClosed && server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (!restartedClientClosed && restartedClient !== undefined) await restartedClient.close();
      if (!restartedServerClosed && restartedServer?.listening === true) {
        await new Promise<void>((resolve) => restartedServer?.close(() => resolve()));
      }
      firstStore.close();
      restartedStore?.close();
      await rm(directory, { recursive: true, force: true });
    });
    await client.connect(transport);

    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const outputSchema = asObject(tool.outputSchema);
      expect(Object.keys(asObject(outputSchema.properties))).toEqual(["dataNotice", "payload"]);
      expect(outputSchema.required).toEqual(["payload"]);
      expect(tool.description?.toLowerCase()).not.toMatch(
        /mock|synthetic|demo|ephemeral|storage adapter|provenance/,
      );
    }
    const persistentSaveTool = listed.tools.find(
      ({ name }) => name === "bizforge_save_confirmed_founder_profile",
    );
    if (persistentSaveTool === undefined) throw new Error("missing profile save tool");
    expect(JSON.stringify(persistentSaveTool.outputSchema)).not.toMatch(
      /mockStep2|founderId|setupRunId|profile"|run"/,
    );
    const persistentStatusTool = listed.tools.find(
      ({ name }) => name === "bizforge_get_data_status",
    );
    if (persistentStatusTool === undefined) throw new Error("missing data status tool");
    expect(JSON.stringify(persistentStatusTool.outputSchema)).not.toMatch(
      /isMock|storageBackend|storageMode|mockStep2|ephemeral|provenance|fixture|source/i,
    );
    const persistentCreateTool = listed.tools.find(
      ({ name }) => name === "bizforge_create_founder_setup_run",
    );
    if (persistentCreateTool === undefined) throw new Error("missing setup creation tool");
    expect(asObject(asObject(persistentCreateTool.inputSchema).properties)).not.toHaveProperty(
      "founderId",
    );
    expect(asObject(asObject(persistentCreateTool.inputSchema).properties)).not.toHaveProperty(
      "setupRunId",
    );
    const persistentGrowthTool = listed.tools.find(
      ({ name }) => name === "bizforge_get_growth_chart_data",
    );
    if (persistentGrowthTool === undefined) throw new Error("missing growth chart tool");
    expect(JSON.stringify(persistentGrowthTool.outputSchema)).not.toMatch(
      /mock|synthetic|demo|ephemeral|fixture/i,
    );
    const deletionTool = listed.tools.find(
      ({ name }) => name === "bizforge_request_founder_data_deletion",
    );
    if (deletionTool === undefined) throw new Error("missing setup-run deletion tool");
    expect(deletionTool.title).toContain("setup-run");
    expect(deletionTool.description).toContain("one setup run");
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
      expect(properties).not.toHaveProperty("acceptMockStorage");
      expect((inputSchema.required as unknown[] | undefined) ?? []).not.toContain(
        "acceptMockStorage",
      );
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
      expect(properties).not.toHaveProperty("isSynthetic");
      expect((inputSchema.required as unknown[] | undefined) ?? []).not.toContain("isSynthetic");
    }

    const status = await client.callTool({ name: "bizforge_get_data_status", arguments: {} });
    expect(Object.keys(asObject(status.structuredContent))).toEqual(["payload"]);
    expect(status.content).toEqual([
      {
        type: "text",
        text: "BizForge is ready for founder onboarding and durable retention.",
      },
    ]);
    expect(payloadOf(status)).toEqual({
      persistenceReady: true,
      founderDataWrites: true,
      domainSchemaVersion: "1.0.0",
      capabilities: {
        step1Writes: true,
        step2ResearchHandoff: true,
        step3ReadProjections: true,
        growthChartProjection: true,
        buyerEvidenceProjection: false,
        opportunityRerank: false,
      },
    });
    expect(JSON.stringify(status.structuredContent)).not.toMatch(
      /isMock|storageBackend|storageMode|mockStep2|ephemeral|provenance|fixture|source/i,
    );

    const evidenceId = "evidence-persistent";
    const proposedSnapshotId = "snapshot-persistent";
    const created = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: {
        clientRequestId: createRequestIds.persistent,
      },
    });
    expect(created.isError).not.toBe(true);
    expect(Object.keys(asObject(created.structuredContent))).toEqual(["payload"]);
    const createdRun = asObject(payloadOf(created).run);
    const founderId = String(createdRun.founderId);
    const setupRunId = String(createdRun.setupRunId);
    expect(founderId).toMatch(/^founder-/);
    expect(setupRunId).toMatch(/^setup-/);
    expect(createdRun).toMatchObject({ founderId, setupRunId, state: "CONSENT_PENDING" });
    expect(created.content).toEqual([{ type: "text", text: "Setup started." }]);
    expect(JSON.stringify(created.content)).not.toMatch(
      /mock|synthetic|demo|ephemeral|storage|provenance|source/i,
    );

    const rejectedLegacyOriginFlag = await client.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: {
        clientRequestId: createRequestIds.persistentSynthetic,
        founderId: "founder-persistent-synthetic-check",
        setupRunId: "setup-persistent-synthetic-check",
        isSynthetic: true,
      },
    });
    expect(rejectedLegacyOriginFlag.isError).toBe(true);

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
      expect(Object.keys(asObject(result.structuredContent))).toEqual(["payload"]);
      expect(JSON.stringify(result.content)).not.toMatch(
        /mock|synthetic|demo|ephemeral|storage|provenance|source/i,
      );
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
      rawArtifactRef: `bizforge://evidence/${evidenceId}`,
      locator: { jsonPointer: "/founder/competencies/0" },
      extraction: { method: "manual", version: "test-v1" },
      attributes: {},
      tags: ["founder-self-report"],
    };
    const storedEvidence = await client.callTool({
      name: "bizforge_put_evidence",
      arguments: { setupRunId, evidence },
    });
    expect(storedEvidence.isError).not.toBe(true);
    expect(Object.keys(asObject(storedEvidence.structuredContent))).toEqual(["payload"]);
    expect(payloadOf(storedEvidence)).toMatchObject({ evidence: { evidenceId } });

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
      snapshotId: proposedSnapshotId,
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
      },
    });
    expect(published.isError, JSON.stringify(published.content)).not.toBe(true);
    const publishedPayload = payloadOf(published);
    const canonicalSnapshotId = String(publishedPayload.snapshotId);
    expect(canonicalSnapshotId).toMatch(
      /^snapshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(canonicalSnapshotId).not.toBe(proposedSnapshotId);
    expect(asObject(published.structuredContent)).toEqual({
      payload: {
        snapshotId: canonicalSnapshotId,
        setupState: "CONFIRMED",
        stage2HandoffEligible: true,
      },
    });
    expect(published.content).toEqual([
      {
        type: "text",
        text: `Founder profile confirmed. Snapshot ${canonicalSnapshotId}; setup CONFIRMED; downstream research eligible.`,
      },
    ]);
    expect(publishedPayload).toEqual({
      snapshotId: canonicalSnapshotId,
      setupState: "CONFIRMED",
      stage2HandoffEligible: true,
    });

    const replayed = await client.callTool({
      name: "bizforge_save_confirmed_founder_profile",
      arguments: {
        setupRunId,
        expectedVersion: 3,
        idempotencyKey: "persistent-confirm",
        profile,
      },
    });
    expect(replayed.isError, JSON.stringify(replayed.content)).not.toBe(true);
    expect(payloadOf(replayed)).toEqual(publishedPayload);

    await client.close();
    clientClosed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    serverClosed = true;
    expect(firstStore.getFounderProfile(proposedSnapshotId)).toBeUndefined();
    expect(firstStore.getFounderProfile(canonicalSnapshotId)?.value).toMatchObject({
      snapshotId: canonicalSnapshotId,
    });
    firstStore.close();

    restartedStore = new SqliteBizForgeDataStore(databasePath);
    const restarted = await startServer(restartedStore);
    restartedServer = restarted.server;
    restartedClient = new Client({ name: "bizforge-restarted-test", version: "1.0.0" });
    const restartedTransport = new StreamableHTTPClientTransport(
      new URL(`${restarted.baseUrl}/mcp`),
    );
    await restartedClient.connect(restartedTransport);

    expect(
      payloadOf(
        await restartedClient.callTool({
          name: "bizforge_get_founder_setup_run",
          arguments: { setupRunId },
        }),
      ),
    ).toMatchObject({ run: { founderId, state: "CONFIRMED", version: 4 } });
    expect(
      payloadOf(
        await restartedClient.callTool({
          name: "bizforge_get_evidence",
          arguments: { evidenceId },
        }),
      ),
    ).toMatchObject({ evidence: { evidenceId, rawArtifactRef: evidence.rawArtifactRef } });
    expect(
      payloadOf(
        await restartedClient.callTool({
          name: "bizforge_get_confirmed_founder_profile",
          arguments: { snapshotId: canonicalSnapshotId },
        }),
      ),
    ).toMatchObject({ profile: { snapshotId: canonicalSnapshotId, founderId } });

    const replayedAfterRestart = await restartedClient.callTool({
      name: "bizforge_save_confirmed_founder_profile",
      arguments: {
        setupRunId,
        expectedVersion: 3,
        idempotencyKey: "persistent-confirm",
        profile,
      },
    });
    expect(replayedAfterRestart.isError, JSON.stringify(replayedAfterRestart.content)).not.toBe(
      true,
    );
    expect(payloadOf(replayedAfterRestart)).toEqual(publishedPayload);

    const persistedEvidenceResource = await restartedClient.readResource({
      uri: `bizforge://evidence/${evidenceId}`,
    });
    const persistedEvidenceContent = persistedEvidenceResource.contents[0];
    if (persistedEvidenceContent === undefined || !("text" in persistedEvidenceContent)) {
      throw new Error("Expected text evidence resource content after restart");
    }
    expect(JSON.parse(persistedEvidenceContent.text)).toMatchObject({
      storageBackend: "sqlite",
      isMock: false,
      payload: {
        evidence: {
          evidenceId,
          summary: evidence.summary,
          rawArtifactRef: evidence.rawArtifactRef,
        },
      },
    });

    await restartedClient.close();
    restartedClientClosed = true;
    await new Promise<void>((resolve) => restarted.server.close(() => resolve()));
    restartedServerClosed = true;
    restartedStore.close();
  });

  it("defaults to local SQLite and uses memory only with an explicit mock mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bizforge-store-config-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));

    const persistentStore = createConfiguredBizForgeDataStore({
      cwd: directory,
      environment: {},
    });
    expect(persistentStore).toBeInstanceOf(SqliteBizForgeDataStore);
    expect(persistentStore.getDataStatus()).toMatchObject({
      dataMode: "persistent",
      storageBackend: "sqlite",
      ephemeral: false,
    });
    if (persistentStore instanceof SqliteBizForgeDataStore) persistentStore.close();

    const mockStore = createConfiguredBizForgeDataStore({
      cwd: directory,
      environment: { BIZFORGE_STORAGE_MODE: "mock" },
    });
    expect(mockStore.getDataStatus()).toMatchObject({
      dataMode: "mock",
      storageBackend: "memory",
      ephemeral: true,
    });
    expect(() =>
      createConfiguredBizForgeDataStore({
        cwd: directory,
        environment: { BIZFORGE_STORAGE_MODE: "unknown" },
      }),
    ).toThrow(/must be either/);
    expect(() =>
      createConfiguredBizForgeDataStore({
        cwd: directory,
        environment: { BIZFORGE_DB_PATH: "" },
      }),
    ).toThrow(/must not be empty/);
  });

  it("starts and closes an owned configured SQLite store through the listen helper", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bizforge-owned-store-"));
    let server: Awaited<ReturnType<typeof listenForBizForgeMcp>> | undefined;
    cleanup.push(async () => {
      const activeServer = server;
      if (activeServer?.listening === true) {
        await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      }
      await rm(directory, { recursive: true, force: true });
    });

    server = await listenForBizForgeMcp({
      host: "127.0.0.1",
      port: 0,
      storeConfiguration: {
        cwd: directory,
        environment: { BIZFORGE_DB_PATH: "profile.sqlite" },
      },
    });
    const address = server.address() as AddressInfo;
    await expect(
      fetch(`http://127.0.0.1:${address.port}/healthz`).then((response) => response.json()),
    ).resolves.toMatchObject({
      ok: true,
      dataMode: "persistent",
      storageBackend: "sqlite",
      ephemeral: false,
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    const reopened = new SqliteBizForgeDataStore(join(directory, "profile.sqlite"));
    expect(reopened.getDataStatus()).toMatchObject({ storageBackend: "sqlite" });
    reopened.close();
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
