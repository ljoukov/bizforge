import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { type EvidenceItem, EvidenceItemSchema } from "../../src/domain/evidence.js";
import {
  type ConfirmedFounderProfileSnapshot,
  ConfirmedFounderProfileSnapshotSchema,
} from "../../src/domain/founder-profile.js";
import { type ResearchBundle, ResearchBundleSchema } from "../../src/domain/research-bundle.js";
import type { BizForgeDataStore } from "../../src/mcp/data-store.js";
import {
  closeBizForgeHttpServer,
  createBizForgeHttpServer,
  listenForBizForgeMcp,
} from "../../src/mcp/http-server.js";
import { createConfiguredBizForgeDataStore } from "../../src/mcp/server.js";
import { SqliteBizForgeDataStore } from "../../src/mcp/sqlite-data-store.js";

type JsonObject = Record<string, unknown>;

const CREATE_REQUEST_ID = "00000000-0000-4000-8000-000000000007";
const CAPTURED_AT = "2026-08-01T12:00:00.000Z";
const CONFIRMED_AT = "2026-08-29T12:00:00.000Z";
const MARKET_OBSERVED_AT = "2026-08-28T12:00:00.000Z";
const confidence = { lower: 0.55, estimate: 0.72, upper: 0.84 };

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
] as const;

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as JsonObject;
}

function payloadOf(result: { structuredContent?: unknown }): JsonObject {
  return asObject(asObject(result.structuredContent).payload);
}

function resourcePayload(text: string): JsonObject {
  const envelope = asObject(JSON.parse(text));
  expect(Object.keys(envelope).sort()).toEqual(["contentSha256", "payload", "schemaVersion"]);
  expect(envelope.schemaVersion).toBe("1.0.0");
  expect(envelope.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  return asObject(envelope.payload);
}

const observedClaim = (claimId: string, evidenceId: string, statement: string) => ({
  claimId,
  kind: "observed" as const,
  statement,
  evidenceIds: [evidenceId],
  confidence,
  createdAt: CONFIRMED_AT,
});

const inferredClaim = (claimId: string, evidenceId: string, statement: string) => ({
  claimId,
  kind: "inferred" as const,
  statement,
  evidenceIds: [evidenceId],
  rationale: "The bounded evidence supports this inference, subject to validation.",
  confidence,
  createdAt: CONFIRMED_AT,
});

const assumptionClaim = (claimId: string, statement: string) => ({
  claimId,
  kind: "assumption" as const,
  statement,
  evidenceIds: [],
  rationale: "Buyer interviews have not yet tested this proposition.",
  validationPlan: "Interview five budget owners and request a paid pilot commitment.",
  confidence: { lower: 0.15, estimate: 0.35, upper: 0.55 },
  createdAt: CONFIRMED_AT,
});

function buildPersistentResearchBundle(
  profile: ConfirmedFounderProfileSnapshot,
  founderEvidence: EvidenceItem,
): ResearchBundle {
  const marketEvidenceId = "evidence-market-growth";
  const baselineWindow = {
    start: "2026-02-01T00:00:00.000Z",
    end: "2026-04-30T23:59:59.000Z",
  };
  const currentWindow = {
    start: "2026-05-01T00:00:00.000Z",
    end: MARKET_OBSERVED_AT,
  };
  const marketEvidence: EvidenceItem = {
    evidenceId: marketEvidenceId,
    evidenceType: "market_report",
    title: "Workflow automation demand comparison",
    summary: "The bounded collection increased from 24 baseline records to 39 current records.",
    provenance: {
      provider: "Prepared integration dataset",
      collectionMethod: "manual_import",
      canonicalUrl: "https://example.com/research/workflow-demand",
      sourceRecordId: "workflow-growth-2026",
      retrievedAt: MARKET_OBSERVED_AT,
      publishedAt: MARKET_OBSERVED_AT,
      contentSha256: "c".repeat(64),
    },
    observedAt: MARKET_OBSERVED_AT,
    rawArtifactRef: "artifact://research/workflow-growth-2026",
    locator: { jsonPointer: "/measurements/0" },
    extraction: { method: "manual", version: "integration-v1" },
    attributes: { baselineValue: 24, currentValue: 39 },
    tags: ["growth", "workflow-automation"],
  };
  const intervention = assumptionClaim(
    "claim-intervention-assumption",
    "A buyer may pay to automate preparation while retaining human approval.",
  );

  return ResearchBundleSchema.parse({
    schemaVersion: "1.0.0",
    bundleId: "bundle-workflow-growth",
    bundleVersion: 1,
    runId: "research-workflow-growth",
    founderProfile: profile,
    researchWindow: { start: baselineWindow.start, end: currentWindow.end },
    evidence: [founderEvidence, marketEvidence],
    marketSignals: [
      {
        signalId: "signal-workflow-growth",
        market: "Operations teams",
        name: "Demand growth for workflow output",
        description: "A bounded comparison using identical collection rules in both windows.",
        evidenceIds: [marketEvidenceId],
        measurement: {
          metric: "matching_records",
          value: 39,
          unit: "records",
          direction: "rising",
          currentWindow,
          baselineWindow,
          baselineValue: 24,
          absoluteChange: 15,
          percentageChange: 62.5,
          sampleSize: 39,
          distinctEntityCount: 31,
          methodology: "Count deduplicated records using the same query in both windows.",
          coverageNote: "Bounded collection covering 31 distinct entities.",
        },
        claims: {
          observed: [
            observedClaim(
              "claim-signal-observed",
              marketEvidenceId,
              "The collection contains 39 current matches and 24 baseline matches.",
            ),
          ],
          inferred: [],
          assumptions: [],
        },
        confidence,
        calculatedAt: CONFIRMED_AT,
      },
    ],
    opportunities: [
      {
        opportunityId: "opportunity-workflow-automation",
        founderProfileSnapshotId: profile.snapshotId,
        title: "Human-approved workflow output automation",
        summary: "Automate repeatable output preparation while preserving human approval.",
        marketSignalIds: ["signal-workflow-growth"],
        evidenceIds: [marketEvidenceId, founderEvidence.evidenceId],
        scarcityHypothesis: {
          hypothesisId: "hypothesis-workflow-capacity",
          title: "Make routine workflow output abundant while preserving approval",
          market: "Operations teams",
          valueChain: [
            {
              stageId: "stage-prepare",
              name: "Prepare workflow output",
              actor: "Operations specialist",
              input: "Approved source records",
              output: "Prepared deliverable",
              currentProcess: "A specialist manually prepares each deliverable.",
            },
            {
              stageId: "stage-approve",
              name: "Approve deliverable",
              actor: "Workflow owner",
              input: "Prepared deliverable",
              output: "Approved deliverable",
              currentProcess: "A human owner reviews policy and quality before release.",
            },
          ],
          scarceResource: "Specialist preparation time",
          scarcityMechanism: "Each additional deliverable consumes specialist effort.",
          claims: {
            observed: [
              observedClaim(
                "claim-scarcity-observed",
                marketEvidenceId,
                "The collection describes repeated demand for manually prepared output.",
              ),
            ],
            inferred: [
              inferredClaim(
                "claim-scarcity-inferred",
                marketEvidenceId,
                "The comparison suggests pressure on specialist workflow capacity.",
              ),
            ],
            assumptions: [],
          },
          aiIntervention: {
            description: "Draft routine deliverables from approved inputs for human review.",
            makesAbundant: "Review-ready workflow output",
            collapsedStageIds: ["stage-prepare"],
            claims: { observed: [], inferred: [], assumptions: [intervention] },
          },
          abundantOutcome: "More review-ready deliverables without proportional preparation work",
          directBeneficiary: "Operations specialist",
          economicBuyer: "Head of operations",
          successorBottleneck: {
            description: "Human approval and policy ownership become the limiting step.",
            claims: {
              observed: [],
              inferred: [
                inferredClaim(
                  "claim-successor-inferred",
                  marketEvidenceId,
                  "Approval capacity becomes the next likely bottleneck.",
                ),
              ],
              assumptions: [],
            },
          },
          confidence,
          createdAt: CONFIRMED_AT,
        },
        offering: {
          description: "A human-approved automation service for one repeatable workflow.",
          smallestSellableWedge: "A paid pilot automating one weekly deliverable type.",
          revenueModel: "Fixed-fee pilot followed by a per-workflow subscription.",
          valueCaptureMechanism: "Own the approval policy and workflow history.",
          claims: {
            observed: [],
            inferred: [
              inferredClaim(
                "claim-offering-inferred",
                marketEvidenceId,
                "A narrow pilot can test the scarcity hypothesis.",
              ),
            ],
            assumptions: [],
          },
        },
        founderFit: {
          rating: "plausible",
          explanation: "The confirmed founder competency is relevant to the initial workflow.",
          claims: {
            observed: [],
            inferred: [
              inferredClaim(
                "claim-founder-fit-inferred",
                founderEvidence.evidenceId,
                "The founder evidence supports initial implementation ability.",
              ),
            ],
            assumptions: [],
          },
        },
        defensibilityClaims: {
          observed: [],
          inferred: [],
          assumptions: [
            assumptionClaim(
              "claim-defensibility-assumption",
              "Customer-specific approval history may create defensibility.",
            ),
          ],
        },
        counterEvidence: {
          status: "NOT_FOUND",
          searchSummary: "Reviewed the bounded evidence set for disconfirming evidence.",
          warning: "No counter-evidence was found in the limited research window.",
          claims: { observed: [], inferred: [], assumptions: [] },
        },
        falsificationExperiment: {
          assumptionClaimIds: [intervention.claimId],
          method: "Offer five operations leaders a paid workflow pilot.",
          successCriterion: "At least one paid-pilot commitment.",
          failureCriterion: "No buyer accepts the proposed pilot conditions.",
          maximumDurationDays: 14,
          maximumBudgetUsd: 500,
        },
        confidence,
        generatedAt: CONFIRMED_AT,
      },
    ],
    generatedAt: CONFIRMED_AT,
    warnings: ["Economic-buyer text remains a hypothesis without buyer-specific evidence."],
  });
}

async function startServer(store: BizForgeDataStore) {
  const server = createBizForgeHttpServer({ store });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "GET", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("BizForge MCP HTTP server", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it("serves the persistent Step 1 -> Step 2 -> Step 3 contract across a SQLite restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bizforge-mcp-http-"));
    const databasePath = join(directory, "bizforge.sqlite");
    const firstStore = new SqliteBizForgeDataStore(databasePath);
    const first = await startServer(firstStore);
    const firstClient = new Client({ name: "bizforge-persistent-test", version: "1.0.0" });
    let firstClosed = false;
    let restartedStore: SqliteBizForgeDataStore | undefined;
    let restartedServer: ReturnType<typeof createBizForgeHttpServer> | undefined;
    let restartedClient: Client | undefined;
    let restartedClosed = false;
    cleanup.push(async () => {
      if (!firstClosed) {
        await firstClient.close().catch(() => undefined);
        await closeBizForgeHttpServer(first.server, { forceCloseAfterMs: 100 }).catch(
          () => undefined,
        );
      }
      if (!restartedClosed) {
        await restartedClient?.close().catch(() => undefined);
        if (restartedServer !== undefined) {
          await closeBizForgeHttpServer(restartedServer, { forceCloseAfterMs: 100 }).catch(
            () => undefined,
          );
        }
      }
      firstStore.close();
      restartedStore?.close();
      await rm(directory, { recursive: true, force: true });
    });
    await firstClient.connect(new StreamableHTTPClientTransport(new URL(`${first.baseUrl}/mcp`)));

    const listed = await firstClient.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(expectedTools);
    expect(JSON.stringify(listed.tools)).not.toMatch(
      /temporary demo|fictional founder|alternate storage/i,
    );
    for (const tool of listed.tools) {
      const outputSchema = asObject(tool.outputSchema);
      expect(Object.keys(asObject(outputSchema.properties))).toEqual(["payload"]);
      expect(outputSchema.required).toEqual(["payload"]);
    }
    expect(
      listed.tools.find(({ name }) => name === "bizforge_get_data_status")?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(
      listed.tools.find(({ name }) => name === "bizforge_request_founder_data_deletion")
        ?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    const createTool = listed.tools.find(
      ({ name }) => name === "bizforge_create_founder_setup_run",
    );
    if (createTool === undefined) throw new Error("missing setup creation tool");
    const createInputSchema = asObject(createTool.inputSchema);
    expect(Object.keys(asObject(createInputSchema.properties))).toEqual(["clientRequestId"]);
    expect(createInputSchema.required ?? []).toEqual([]);
    expect(createTool.title).toContain("server-assigned");
    expect(createTool.description).toContain("never ask an end user");
    expect(asObject(asObject(createInputSchema.properties).clientRequestId)).toMatchObject({
      format: "uuid",
    });
    const growthTool = listed.tools.find(({ name }) => name === "bizforge_get_growth_chart_data");
    if (growthTool === undefined) throw new Error("missing growth chart tool");
    expect(JSON.stringify(growthTool.outputSchema)).not.toContain('"prefixItems"');
    expect(JSON.stringify(growthTool.outputSchema)).not.toContain('"items":false');

    const status = await firstClient.callTool({ name: "bizforge_get_data_status", arguments: {} });
    expect(Object.keys(asObject(status.structuredContent))).toEqual(["payload"]);
    expect(status.content).toEqual([
      { type: "text", text: "BizForge is ready for founder onboarding and durable retention." },
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

    const rejectedUnknownInput = await firstClient.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: { clientRequestId: CREATE_REQUEST_ID, unsupportedRuntimeOverride: true },
    });
    expect(rejectedUnknownInput.isError).toBe(true);

    const createArguments = { clientRequestId: CREATE_REQUEST_ID };
    const created = await firstClient.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: createArguments,
    });
    expect(created.isError).not.toBe(true);
    const createdRun = asObject(payloadOf(created).run);
    const founderId = String(createdRun.founderId);
    const setupRunId = String(createdRun.setupRunId);
    expect(founderId).toMatch(/^founder-/);
    expect(setupRunId).toMatch(/^setup-/);
    expect(createdRun).toMatchObject({ state: "CONSENT_PENDING", version: 1 });
    expect(created.content).toEqual([{ type: "text", text: "Setup started." }]);
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_create_founder_setup_run",
          arguments: createArguments,
        }),
      ).run,
    ).toEqual(createdRun);

    for (const [consentId, scope] of [
      ["consent-self-report-persistent", "retain_minimized_founder_self_report"],
      ["consent-retain-persistent", "retain_minimized_founder_snapshot"],
      ["consent-research-persistent", "use_confirmed_founder_snapshot_for_research"],
    ] as const) {
      const result = await firstClient.callTool({
        name: "bizforge_record_consent",
        arguments: {
          consent: {
            consentId,
            setupRunId,
            founderId,
            scope,
            status: "active",
            sourceUrls: [],
            recordedAt: CAPTURED_AT,
            grantedAt: CAPTURED_AT,
          },
        },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    }
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_get_consent",
          arguments: { setupRunId, scope: "retain_minimized_founder_snapshot" },
        }),
      ).consents,
    ).toHaveLength(1);

    const evidence = EvidenceItemSchema.parse({
      evidenceId: "evidence-persistent",
      evidenceType: "user_input",
      title: "Founder competency",
      summary: "The founder reports workflow automation experience.",
      provenance: {
        provider: "First-party founder interview",
        collectionMethod: "user_input",
        sourceRecordId: "persistent-founder-input",
        retrievedAt: CAPTURED_AT,
        contentSha256: "b".repeat(64),
      },
      observedAt: CAPTURED_AT,
      rawArtifactRef: "artifact://founder/evidence-persistent",
      locator: { jsonPointer: "/founder/competencies/0" },
      extraction: { method: "manual", version: "integration-v1" },
      attributes: {},
      tags: ["founder-self-report"],
    });
    const storedEvidence = await firstClient.callTool({
      name: "bizforge_put_evidence",
      arguments: { setupRunId, evidence },
    });
    expect(storedEvidence.isError).not.toBe(true);
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_put_evidence",
          arguments: { setupRunId, evidence },
        }),
      ),
    ).toEqual(payloadOf(storedEvidence));
    const conflictingEvidence = await firstClient.callTool({
      name: "bizforge_put_evidence",
      arguments: {
        setupRunId,
        evidence: { ...evidence, summary: "Conflicting immutable evidence content." },
      },
    });
    expect(conflictingEvidence.isError).toBe(true);

    const interviewArguments = {
      setupRunId,
      expectedVersion: 1,
      targetState: "INTERVIEW",
      idempotencyKey: "persistent-interview",
    };
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_transition_founder_setup_run",
          arguments: interviewArguments,
        }),
      ),
    ).toMatchObject({ run: { state: "INTERVIEW", version: 2 }, replayed: false });
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_transition_founder_setup_run",
          arguments: interviewArguments,
        }),
      ),
    ).toMatchObject({ run: { state: "INTERVIEW", version: 2 }, replayed: true });
    const conflictingTransition = await firstClient.callTool({
      name: "bizforge_transition_founder_setup_run",
      arguments: { ...interviewArguments, targetState: "DRAFT_REVIEW" },
    });
    expect(conflictingTransition.isError).toBe(true);
    const review = await firstClient.callTool({
      name: "bizforge_transition_founder_setup_run",
      arguments: {
        setupRunId,
        expectedVersion: 2,
        targetState: "DRAFT_REVIEW",
        idempotencyKey: "persistent-review",
      },
    });
    expect(payloadOf(review)).toMatchObject({ run: { state: "DRAFT_REVIEW", version: 3 } });

    const proposedSnapshotId = "snapshot-client-proposal";
    const profile = ConfirmedFounderProfileSnapshotSchema.parse({
      snapshotId: proposedSnapshotId,
      founderId,
      displayName: "Prepared Founder",
      competencies: [
        {
          name: "Workflow automation",
          level: "working",
          evidenceIds: [evidence.evidenceId],
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
      sourceEvidenceIds: [evidence.evidenceId],
      claims: { observed: [], inferred: [], assumptions: [] },
      capturedAt: CAPTURED_AT,
      confirmedAt: CONFIRMED_AT,
    });
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_validate_founder_profile_snapshot",
          arguments: {
            snapshot: { ...profile, confirmedAt: undefined },
            confirmationLevel: false,
          },
        }),
      ),
    ).toMatchObject({ valid: true, validator: "FounderProfileSnapshotSchema" });
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_validate_founder_profile_snapshot",
          arguments: {
            snapshot: { ...profile, confirmedAt: undefined },
            confirmationLevel: true,
          },
        }),
      ),
    ).toMatchObject({ valid: false, validator: "ConfirmedFounderProfileSnapshotSchema" });

    const confirmationArguments = {
      setupRunId,
      expectedVersion: 3,
      idempotencyKey: "persistent-confirm",
      profile,
    };
    const published = await firstClient.callTool({
      name: "bizforge_save_confirmed_founder_profile",
      arguments: confirmationArguments,
    });
    expect(published.isError, JSON.stringify(published.content)).not.toBe(true);
    const publishedPayload = payloadOf(published);
    const canonicalSnapshotId = String(publishedPayload.snapshotId);
    expect(canonicalSnapshotId).toMatch(
      /^snapshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(canonicalSnapshotId).not.toBe(proposedSnapshotId);
    expect(publishedPayload).toEqual({
      snapshotId: canonicalSnapshotId,
      setupState: "CONFIRMED",
      stage2HandoffEligible: true,
    });
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_save_confirmed_founder_profile",
          arguments: confirmationArguments,
        }),
      ),
    ).toEqual(publishedPayload);

    const canonicalProfile = ConfirmedFounderProfileSnapshotSchema.parse(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_get_confirmed_founder_profile",
          arguments: { snapshotId: canonicalSnapshotId },
        }),
      ).profile,
    );
    const researchBundle = buildPersistentResearchBundle(canonicalProfile, evidence);
    const savedBundle = await firstClient.callTool({
      name: "bizforge_save_research_bundle",
      arguments: { bundle: researchBundle },
    });
    expect(savedBundle.isError, JSON.stringify(savedBundle.content)).not.toBe(true);
    expect(payloadOf(savedBundle)).toMatchObject({
      bundle: {
        bundleId: researchBundle.bundleId,
        founderProfile: { snapshotId: canonicalSnapshotId },
      },
    });
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_save_research_bundle",
          arguments: { bundle: researchBundle },
        }),
      ),
    ).toEqual(payloadOf(savedBundle));
    const conflictingBundle = await firstClient.callTool({
      name: "bizforge_save_research_bundle",
      arguments: {
        bundle: { ...researchBundle, warnings: [...researchBundle.warnings, "Conflict."] },
      },
    });
    expect(conflictingBundle.isError).toBe(true);

    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_get_latest_research_bundle",
          arguments: { founderId },
        }),
      ),
    ).toMatchObject({ bundle: { bundleId: researchBundle.bundleId } });
    const opportunities = payloadOf(
      await firstClient.callTool({
        name: "bizforge_list_opportunities",
        arguments: { bundleId: researchBundle.bundleId, bundleVersion: 1 },
      }),
    ).opportunities as JsonObject[];
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      opportunityId: "opportunity-workflow-automation",
      buyerEvidenceStatus: "unlinked/hypothesis_only",
    });
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_get_opportunity",
          arguments: {
            bundleId: researchBundle.bundleId,
            bundleVersion: 1,
            opportunityId: "opportunity-workflow-automation",
          },
        }),
      ),
    ).toMatchObject({
      opportunity: { opportunityId: "opportunity-workflow-automation" },
      buyerEvidenceStatus: "unlinked/hypothesis_only",
    });
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_get_market_signals",
          arguments: { bundleId: researchBundle.bundleId, bundleVersion: 1 },
        }),
      ).marketSignals,
    ).toHaveLength(1);
    expect(
      payloadOf(
        await firstClient.callTool({
          name: "bizforge_get_growth_chart_data",
          arguments: {
            bundleId: researchBundle.bundleId,
            bundleVersion: 1,
            signalId: "signal-workflow-growth",
          },
        }),
      ),
    ).toMatchObject({
      charts: [
        {
          eligible: true,
          absoluteChange: 15,
          percentageChange: 62.5,
          sampleSize: 39,
          distinctEntityCount: 31,
          inferenceStatus: "evidence_backed_inference",
        },
      ],
    });
    expect(
      (
        await firstClient.callTool({
          name: "bizforge_get_growth_chart_data",
          arguments: { bundleId: researchBundle.bundleId, signalId: "missing" },
        })
      ).isError,
    ).toBe(true);

    for (const [name, arguments_] of [
      ["bizforge_get_founder_setup_run", { setupRunId: "missing" }],
      ["bizforge_get_evidence", { evidenceId: "missing" }],
      ["bizforge_get_confirmed_founder_profile", { snapshotId: "missing" }],
      ["bizforge_get_research_bundle", { bundleId: "missing" }],
      ["bizforge_get_deletion_status", { deletionRequestId: "missing" }],
    ] as const) {
      expect((await firstClient.callTool({ name, arguments: arguments_ })).isError).toBe(true);
    }

    const evidenceResource = await firstClient.readResource({
      uri: `bizforge://evidence/${evidence.evidenceId}`,
    });
    const evidenceContent = evidenceResource.contents[0];
    if (evidenceContent === undefined || !("text" in evidenceContent)) {
      throw new Error("Expected text evidence resource content");
    }
    expect(resourcePayload(evidenceContent.text)).toMatchObject({
      evidence: { evidenceId: evidence.evidenceId },
    });
    const founderResource = await firstClient.readResource({
      uri: `bizforge://founder-snapshots/${canonicalSnapshotId}`,
    });
    const founderContent = founderResource.contents[0];
    if (founderContent === undefined || !("text" in founderContent)) {
      throw new Error("Expected text founder resource content");
    }
    expect(resourcePayload(founderContent.text)).toMatchObject({
      profile: { snapshotId: canonicalSnapshotId },
    });
    const bundleResource = await firstClient.readResource({
      uri: `bizforge://research-bundles/${researchBundle.bundleId}/versions/1`,
    });
    expect(bundleResource.contents).toHaveLength(1);
    const opportunityResource = await firstClient.readResource({
      uri: "bizforge://opportunities/opportunity-workflow-automation",
    });
    expect(opportunityResource.contents).toHaveLength(1);
    await expect(
      firstClient.readResource({ uri: "bizforge://founder-snapshots/missing" }),
    ).rejects.toThrow(/not found/);
    await expect(
      firstClient.readResource({
        uri: `bizforge://research-bundles/${researchBundle.bundleId}/versions/not-a-number`,
      }),
    ).rejects.toThrow(/positive integer/);

    await firstClient.close();
    await closeBizForgeHttpServer(first.server, { forceCloseAfterMs: 100 });
    firstStore.close();
    firstClosed = true;

    restartedStore = new SqliteBizForgeDataStore(databasePath);
    const restarted = await startServer(restartedStore);
    restartedServer = restarted.server;
    restartedClient = new Client({ name: "bizforge-restarted-test", version: "1.0.0" });
    await restartedClient.connect(
      new StreamableHTTPClientTransport(new URL(`${restarted.baseUrl}/mcp`)),
    );

    expect(
      payloadOf(
        await restartedClient.callTool({
          name: "bizforge_create_founder_setup_run",
          arguments: createArguments,
        }),
      ).run,
    ).toMatchObject({ setupRunId, founderId, state: "CONFIRMED", version: 4 });
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
          name: "bizforge_get_research_bundle",
          arguments: { bundleId: researchBundle.bundleId, bundleVersion: 1 },
        }),
      ),
    ).toMatchObject({ bundle: { bundleId: researchBundle.bundleId, bundleVersion: 1 } });
    expect(
      payloadOf(
        await restartedClient.callTool({
          name: "bizforge_save_confirmed_founder_profile",
          arguments: confirmationArguments,
        }),
      ),
    ).toEqual(publishedPayload);

    const persistedEvidenceResource = await restartedClient.readResource({
      uri: `bizforge://evidence/${evidence.evidenceId}`,
    });
    const persistedEvidenceContent = persistedEvidenceResource.contents[0];
    if (persistedEvidenceContent === undefined || !("text" in persistedEvidenceContent)) {
      throw new Error("Expected text evidence resource content after restart");
    }
    expect(resourcePayload(persistedEvidenceContent.text)).toMatchObject({
      evidence: { evidenceId: evidence.evidenceId, summary: evidence.summary },
    });

    const deletionArguments = {
      setupRunId,
      founderId,
      reason: "Founder requested removal",
      idempotencyKey: "persistent-delete",
    };
    const deletionResult = await restartedClient.callTool({
      name: "bizforge_request_founder_data_deletion",
      arguments: deletionArguments,
    });
    expect(deletionResult.isError, JSON.stringify(deletionResult.content)).not.toBe(true);
    const deletion = payloadOf(deletionResult);
    const deletionRecord = asObject(deletion.deletion);
    const deletionRequestId = String(deletionRecord.deletionRequestId);
    expect(deletionRecord).toMatchObject({ setupRunId, founderId, status: "pending_expiry" });
    expect(deletionRecord.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: "sqlite_store", status: "completed" }),
      ]),
    );
    expect(
      payloadOf(
        await restartedClient.callTool({
          name: "bizforge_request_founder_data_deletion",
          arguments: deletionArguments,
        }),
      ),
    ).toEqual(deletion);
    const conflictingDeletion = await restartedClient.callTool({
      name: "bizforge_request_founder_data_deletion",
      arguments: { ...deletionArguments, reason: "Conflicting retry" },
    });
    expect(conflictingDeletion.isError).toBe(true);
    expect(
      payloadOf(
        await restartedClient.callTool({
          name: "bizforge_get_deletion_status",
          arguments: { deletionRequestId },
        }),
      ),
    ).toEqual(deletion);
    for (const [name, arguments_] of [
      ["bizforge_get_founder_setup_run", { setupRunId }],
      ["bizforge_get_evidence", { evidenceId: evidence.evidenceId }],
      ["bizforge_get_confirmed_founder_profile", { snapshotId: canonicalSnapshotId }],
      ["bizforge_get_research_bundle", { bundleId: researchBundle.bundleId }],
    ] as const) {
      expect((await restartedClient.callTool({ name, arguments: arguments_ })).isError).toBe(true);
    }
    const deletedCreationReplay = await restartedClient.callTool({
      name: "bizforge_create_founder_setup_run",
      arguments: createArguments,
    });
    expect(deletedCreationReplay.isError).toBe(true);

    await restartedClient.close();
    await closeBizForgeHttpServer(restarted.server, { forceCloseAfterMs: 100 });
    restartedStore.close();
    restartedClosed = true;
  });

  it("configures only file-backed SQLite stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bizforge-store-config-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));

    const defaultStore = createConfiguredBizForgeDataStore({ cwd: directory, environment: {} });
    expect(defaultStore).toBeInstanceOf(SqliteBizForgeDataStore);
    expect(defaultStore.getDataStatus()).toMatchObject({
      dataMode: "persistent",
      storageBackend: "sqlite",
      persistenceStatus: "persistent",
    });
    if (defaultStore instanceof SqliteBizForgeDataStore) defaultStore.close();

    const configuredStore = createConfiguredBizForgeDataStore({
      cwd: directory,
      environment: { BIZFORGE_DB_PATH: "configured.sqlite" },
    });
    expect(configuredStore).toBeInstanceOf(SqliteBizForgeDataStore);
    if (configuredStore instanceof SqliteBizForgeDataStore) configuredStore.close();
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
      if (server !== undefined) {
        await closeBizForgeHttpServer(server, { forceCloseAfterMs: 100 }).catch(() => undefined);
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
    ).resolves.toEqual({
      ok: true,
      service: "bizforge-mcp",
      persistenceReady: true,
      storageBackend: "sqlite",
    });

    await closeBizForgeHttpServer(server, { forceCloseAfterMs: 100 });
    const reopened = new SqliteBizForgeDataStore(join(directory, "profile.sqlite"));
    expect(reopened.getDataStatus()).toMatchObject({ storageBackend: "sqlite" });
    reopened.close();
  });

  it("serves health and rejects hostile hosts, cross-origin requests, and unknown routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bizforge-http-security-"));
    const store = new SqliteBizForgeDataStore(join(directory, "bizforge.sqlite"));
    const { server, baseUrl } = await startServer(store);
    cleanup.push(async () => {
      await closeBizForgeHttpServer(server, { forceCloseAfterMs: 100 }).catch(() => undefined);
      store.close();
      await rm(directory, { recursive: true, force: true });
    });

    await expect(fetch(`${baseUrl}/healthz`).then((response) => response.json())).resolves.toEqual({
      ok: true,
      service: "bizforge-mcp",
      persistenceReady: true,
      storageBackend: "sqlite",
    });
    expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/healthz`, {
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(await requestStatus(`${baseUrl}/healthz`, { host: "evil.example" })).toBe(403);
  });
});
