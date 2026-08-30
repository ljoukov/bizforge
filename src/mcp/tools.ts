import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { ConfidenceBoundsSchema, DateRangeSchema } from "../domain/common.js";
import { EvidenceItemSchema } from "../domain/evidence.js";
import {
  ConfirmedFounderProfileSnapshotSchema,
  FounderProfileSnapshotSchema,
} from "../domain/founder-profile.js";
import { type MarketSignal, MarketSignalSchema } from "../domain/market-signal.js";
import {
  type OpportunityDossier,
  OpportunityDossierSchema,
} from "../domain/opportunity-dossier.js";
import { type ResearchBundle, ResearchBundleSchema } from "../domain/research-bundle.js";
import {
  ConsentRecordSchema,
  ConsentScopeSchema,
  DESTRUCTIVE_WRITE_ANNOTATIONS,
  DeletionRecordSchema,
  FounderSetupRunSchema,
  FounderSetupStateSchema,
  IDEMPOTENT_WRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  type StoredResearchBundleRecord,
  WRITE_ANNOTATIONS,
} from "./contracts.js";
import type { BizForgeDataStore } from "./data-store.js";

const resultWithPayload = <T extends z.ZodType>(payload: T) => z.object({ payload });

const PersistentDataStatusPayloadSchema = z.object({
  persistenceReady: z.boolean(),
  founderDataWrites: z.boolean(),
  domainSchemaVersion: z.literal("1.0.0"),
  capabilities: z.object({
    step1Writes: z.boolean(),
    step2ResearchHandoff: z.boolean(),
    step3ReadProjections: z.boolean(),
    growthChartProjection: z.boolean(),
    buyerEvidenceProjection: z.boolean(),
    opportunityRerank: z.boolean(),
  }),
});

const OpportunitySummarySchema = z.object({
  opportunityId: z.string(),
  title: z.string(),
  summary: z.string(),
  market: z.string(),
  founderFit: z.enum(["weak", "plausible", "strong"]),
  economicBuyerHypothesis: z.string(),
  buyerEvidenceStatus: z.literal("unlinked/hypothesis_only"),
  confidence: ConfidenceBoundsSchema,
  evidenceIds: z.array(z.string()),
});

const IneligibleGrowthProjectionSchema = z.object({
  signalId: z.string(),
  eligible: z.literal(false),
  reason: z.string(),
  evidenceIds: z.array(z.string()),
  inferenceStatus: z.literal("insufficient_growth_inputs"),
});

const GrowthProjectionCoreSchema = z.object({
  signalId: z.string(),
  eligible: z.literal(true),
  market: z.string(),
  title: z.string(),
  metric: z.string(),
  unit: z.string(),
  direction: z.literal("rising"),
  series: z
    .array(
      z.object({
        label: z.enum(["Baseline", "Current"]),
        window: DateRangeSchema,
        value: z.number(),
      }),
    )
    .length(2),
  absoluteChange: z.number(),
  percentageChange: z.number(),
  sampleSize: z.number().int().nonnegative(),
  distinctEntityCount: z.number().int().nonnegative(),
  methodology: z.string(),
  coverageNote: z.string(),
  evidenceIds: z.array(z.string()),
});

const EligibleGrowthProjectionSchema = GrowthProjectionCoreSchema.extend({
  inferenceStatus: z.literal("evidence_backed_inference"),
});

const GrowthChartPayloadSchema = z.object({
  bundleId: z.string(),
  charts: z.array(
    z.discriminatedUnion("eligible", [
      IneligibleGrowthProjectionSchema,
      EligibleGrowthProjectionSchema,
    ]),
  ),
  chartPolicy: z.string(),
});

const SetupRunPayloadSchema = z.object({ run: FounderSetupRunSchema });
const TransitionPayloadSchema = z.object({
  run: FounderSetupRunSchema,
  replayed: z.boolean(),
});
const ConsentPayloadSchema = z.object({ consent: ConsentRecordSchema });
const ConsentListPayloadSchema = z.object({ consents: z.array(ConsentRecordSchema) });
const ValidationPayloadSchema = z.object({
  valid: z.boolean(),
  validator: z.enum(["FounderProfileSnapshotSchema", "ConfirmedFounderProfileSnapshotSchema"]),
  issues: z.array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])),
      message: z.string(),
      code: z.string(),
    }),
  ),
});
const SavedProfilePayloadSchema = z.object({
  snapshotId: z.string(),
  setupState: z.literal("CONFIRMED"),
  stage2HandoffEligible: z.boolean(),
});
const DeletionPayloadSchema = z.object({ deletion: DeletionRecordSchema });

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown BizForge MCP error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function createResponder() {
  const success = (payload: unknown, text = "Completed successfully.") => {
    const structuredContent = { payload };
    return {
      content: [{ type: "text" as const, text }],
      structuredContent,
    };
  };
  const safely = async (operation: () => unknown, responseText?: string | (() => string)) => {
    try {
      const payload = await operation();
      return success(payload, typeof responseText === "function" ? responseText() : responseText);
    } catch (error) {
      return failure(error);
    }
  };
  return { safely, success };
}

const BundleLocatorSchema = z
  .object({
    bundleId: z.string().min(1).optional(),
    bundleVersion: z.number().int().positive().optional(),
    founderId: z.string().min(1).optional(),
  })
  .strict();

function resolveBundle(
  store: BizForgeDataStore,
  input: z.infer<typeof BundleLocatorSchema>,
): StoredResearchBundleRecord<ResearchBundle> {
  const record =
    input.bundleId === undefined
      ? store.getLatestResearchBundle(input.founderId)
      : store.getResearchBundle(input.bundleId, input.bundleVersion);
  if (record === undefined) {
    throw new Error("No matching research bundle was found");
  }
  return record;
}

function findOpportunity(bundle: ResearchBundle, opportunityId: string): OpportunityDossier {
  const opportunity = bundle.opportunities.find(
    (candidate) => candidate.opportunityId === opportunityId,
  );
  if (opportunity === undefined) {
    throw new Error(`Opportunity ${opportunityId} was not found in the selected research bundle`);
  }
  return opportunity;
}

function projectGrowth(signal: MarketSignal) {
  const { measurement } = signal;
  const eligible =
    measurement.direction === "rising" &&
    measurement.baselineWindow !== undefined &&
    measurement.baselineValue !== undefined &&
    measurement.absoluteChange !== undefined &&
    measurement.percentageChange !== undefined &&
    measurement.methodology.trim().length > 0 &&
    measurement.coverageNote.trim().length > 0;
  if (!eligible) {
    return {
      signalId: signal.signalId,
      eligible: false as const,
      reason:
        "Numeric growth requires a rising direction plus baseline/current windows and values, absolute and percentage change, methodology, and a coverage note.",
      evidenceIds: signal.evidenceIds,
      inferenceStatus: "insufficient_growth_inputs" as const,
    };
  }
  return {
    signalId: signal.signalId,
    eligible: true as const,
    market: signal.market,
    title: signal.name,
    metric: measurement.metric,
    unit: measurement.unit,
    direction: measurement.direction,
    series: [
      {
        label: "Baseline",
        window: measurement.baselineWindow,
        value: measurement.baselineValue,
      },
      { label: "Current", window: measurement.currentWindow, value: measurement.value },
    ],
    absoluteChange: measurement.absoluteChange,
    percentageChange: measurement.percentageChange,
    sampleSize: measurement.sampleSize,
    distinctEntityCount: measurement.distinctEntityCount,
    methodology: measurement.methodology,
    coverageNote: measurement.coverageNote,
    evidenceIds: signal.evidenceIds,
    inferenceStatus: "evidence_backed_inference" as const,
  };
}

export function registerBizForgeTools(server: McpServer, store: BizForgeDataStore): void {
  const { safely, success } = createResponder();
  server.registerTool(
    "bizforge_get_data_status",
    {
      title: "Get BizForge data status",
      description: "Check whether BizForge is ready for founder onboarding and downstream work.",
      inputSchema: z.object({}).strict(),
      outputSchema: resultWithPayload(PersistentDataStatusPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const status = store.getDataStatus();
      const capabilities = {
        step1Writes: true,
        step2ResearchHandoff: true,
        step3ReadProjections: true,
        growthChartProjection: true,
        buyerEvidenceProjection: false,
        opportunityRerank: false,
      };
      const persistenceReady = status.persistenceStatus === "persistent";
      const founderDataWrites = persistenceReady;
      const payload = {
        persistenceReady,
        founderDataWrites,
        domainSchemaVersion: "1.0.0" as const,
        capabilities: {
          ...capabilities,
          step2ResearchHandoff: founderDataWrites,
        },
      };
      return success(
        payload,
        !persistenceReady || !founderDataWrites
          ? "BizForge data status is available."
          : "BizForge is ready for founder onboarding and durable retention.",
      );
    },
  );

  const createSetupRunInputShape = {
    clientRequestId: z
      .uuid()
      .optional()
      .describe(
        "Optional internal retry key. Generate it in the calling application, reuse it only for an exact retry, and never request it from an end user.",
      ),
  };
  server.registerTool(
    "bizforge_create_founder_setup_run",
    {
      title: "Start founder setup with server-assigned runtime IDs",
      description:
        "Create a versioned Step 1 setup run with server-assigned founder and run IDs. Generate clientRequestId internally for retry safety; never ask an end user for runtime IDs.",
      inputSchema: z.object(createSetupRunInputShape).strict(),
      outputSchema: resultWithPayload(SetupRunPayloadSchema),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ clientRequestId }) =>
      safely(() => {
        const record = store.createSetupRun({
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        });
        return { run: record.value };
      }, "Setup started."),
  );

  const transitionSetupRunInputShape = {
    setupRunId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    targetState: FounderSetupStateSchema,
    idempotencyKey: z.string().min(1),
    stateData: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Complete replacement for current stateData. For incremental interview checkpoints, merge the latest run.stateData with new answers before calling this tool.",
      ),
  };
  server.registerTool(
    "bizforge_get_founder_setup_run",
    {
      title: "Get founder setup run",
      description: "Read the current version and state of a Step 1 setup run.",
      inputSchema: z.object({ setupRunId: z.string().min(1) }).strict(),
      outputSchema: resultWithPayload(SetupRunPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ setupRunId }) => {
      const record = store.getSetupRun(setupRunId);
      if (record === undefined) return failure(new Error(`Setup run ${setupRunId} was not found`));
      return success({ run: record.value });
    },
  );

  server.registerTool(
    "bizforge_transition_founder_setup_run",
    {
      title: "Transition founder setup run",
      description:
        "Compare-and-set a setup state with an idempotency key. INTERVIEW may transition to INTERVIEW for incremental checkpoints. Supplied stateData replaces the prior object, so read and merge the current stateData before writing a checkpoint.",
      inputSchema: z.object(transitionSetupRunInputShape).strict(),
      outputSchema: resultWithPayload(TransitionPayloadSchema),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ setupRunId, expectedVersion, targetState, idempotencyKey, stateData }) => {
      const input = { setupRunId, expectedVersion, targetState, idempotencyKey, stateData };
      return safely(() =>
        store.transitionSetupRun({
          setupRunId: input.setupRunId,
          expectedVersion: input.expectedVersion,
          targetState: input.targetState,
          idempotencyKey: input.idempotencyKey,
          ...(input.stateData === undefined ? {} : { stateData: input.stateData }),
        }),
      );
    },
  );

  server.registerTool(
    "bizforge_record_consent",
    {
      title: "Record founder consent",
      description: "Persist an immutable, separately scoped consent event.",
      inputSchema: z.object({ consent: ConsentRecordSchema }).strict(),
      outputSchema: resultWithPayload(ConsentPayloadSchema),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ consent }) =>
      safely(() => {
        const record = store.recordConsent(consent);
        return { consent: record.value };
      }),
  );

  server.registerTool(
    "bizforge_get_consent",
    {
      title: "Get founder consent",
      description: "Resolve consent history for a setup run and optional scope.",
      inputSchema: z
        .object({
          setupRunId: z.string().min(1),
          scope: ConsentScopeSchema.optional(),
        })
        .strict(),
      outputSchema: resultWithPayload(ConsentListPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ setupRunId, scope }) =>
      safely(() => {
        const records = store.getConsent(setupRunId, scope);
        return { consents: records.map(({ value }) => value) };
      }),
  );

  server.registerTool(
    "bizforge_put_evidence",
    {
      title: "Put canonical evidence",
      description: "Store a canonical evidence item.",
      inputSchema: z
        .object({
          setupRunId: z.string().min(1),
          evidence: EvidenceItemSchema,
        })
        .strict(),
      outputSchema: resultWithPayload(z.object({ evidence: EvidenceItemSchema })),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ setupRunId, evidence }) =>
      safely(() => {
        const record = store.putEvidence(setupRunId, evidence);
        return { evidence: record.value };
      }),
  );

  server.registerTool(
    "bizforge_get_evidence",
    {
      title: "Get canonical evidence",
      description: "Read a minimized evidence item by ID without exposing provider payloads.",
      inputSchema: z.object({ evidenceId: z.string().min(1) }).strict(),
      outputSchema: resultWithPayload(z.object({ evidence: EvidenceItemSchema })),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ evidenceId }) => {
      const record = store.getEvidence(evidenceId);
      if (record === undefined) return failure(new Error(`Evidence ${evidenceId} was not found`));
      return success({ evidence: record.value });
    },
  );

  server.registerTool(
    "bizforge_validate_founder_profile_snapshot",
    {
      title: "Validate founder profile snapshot",
      description: "Validate a draft or confirmed snapshot using the pinned canonical schema.",
      inputSchema: z.object({ snapshot: z.unknown(), confirmationLevel: z.boolean() }).strict(),
      outputSchema: resultWithPayload(ValidationPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ snapshot, confirmationLevel }) => {
      const result = (
        confirmationLevel ? ConfirmedFounderProfileSnapshotSchema : FounderProfileSnapshotSchema
      ).safeParse(snapshot);
      return success({
        valid: result.success,
        validator: confirmationLevel
          ? "ConfirmedFounderProfileSnapshotSchema"
          : "FounderProfileSnapshotSchema",
        issues: result.success
          ? []
          : result.error.issues.map(({ path, message, code }) => ({ path, message, code })),
      });
    },
  );

  server.registerTool(
    "bizforge_save_confirmed_founder_profile",
    {
      title: "Save confirmed founder profile",
      description:
        "Validate and immutably publish a confirmed founder snapshot for downstream work.",
      inputSchema: z
        .object({
          setupRunId: z.string().min(1),
          expectedVersion: z.number().int().positive(),
          idempotencyKey: z.string().min(1),
          profile: ConfirmedFounderProfileSnapshotSchema,
        })
        .strict(),
      outputSchema: resultWithPayload(SavedProfilePayloadSchema),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ setupRunId, expectedVersion, idempotencyKey, profile }) => {
      let confirmation:
        | {
            snapshotId: string;
            setupState: "CONFIRMED";
            stage2HandoffEligible: boolean;
          }
        | undefined;
      return safely(
        () => {
          const result = store.confirmFounderProfile({
            setupRunId,
            expectedVersion,
            idempotencyKey,
            profile,
          });
          if (result.run.state !== "CONFIRMED") {
            throw new Error("Confirmed profile save returned an invalid setup state");
          }
          confirmation = {
            snapshotId: result.profile.value.snapshotId,
            setupState: result.run.state,
            stage2HandoffEligible: result.stage2HandoffEligible,
          };
          return confirmation;
        },
        () =>
          confirmation === undefined
            ? "Founder profile confirmed."
            : `Founder profile confirmed. Snapshot ${confirmation.snapshotId}; setup ${confirmation.setupState}; downstream research ${confirmation.stage2HandoffEligible ? "eligible" : "not enabled"}.`,
      );
    },
  );

  server.registerTool(
    "bizforge_get_confirmed_founder_profile",
    {
      title: "Get confirmed founder profile",
      description: "Read an immutable confirmed founder snapshot by ID.",
      inputSchema: z.object({ snapshotId: z.string().min(1) }).strict(),
      outputSchema: resultWithPayload(z.object({ profile: ConfirmedFounderProfileSnapshotSchema })),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ snapshotId }) => {
      const record = store.getFounderProfile(snapshotId);
      if (record === undefined)
        return failure(new Error(`Founder snapshot ${snapshotId} was not found`));
      return success({ profile: record.value });
    },
  );

  server.registerTool(
    "bizforge_request_founder_data_deletion",
    {
      title: "Request setup-run data deletion",
      description:
        "Delete controllable records associated with one setup run and report remaining external, provider, or backup obligations truthfully.",
      inputSchema: z
        .object({
          setupRunId: z.string().min(1),
          founderId: z.string().min(1),
          reason: z.string().min(1),
          idempotencyKey: z.string().min(1),
        })
        .strict(),
      outputSchema: resultWithPayload(DeletionPayloadSchema),
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
    },
    async ({ setupRunId, founderId, reason, idempotencyKey }) => {
      const input = { setupRunId, founderId, reason, idempotencyKey };
      return safely(() => {
        const record = store.requestDeletion(input);
        return { deletion: record.value };
      });
    },
  );

  server.registerTool(
    "bizforge_get_deletion_status",
    {
      title: "Get deletion status",
      description: "Read per-system deletion status without collapsing unresolved obligations.",
      inputSchema: z.object({ deletionRequestId: z.string().min(1) }).strict(),
      outputSchema: resultWithPayload(DeletionPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ deletionRequestId }) => {
      const deletion = store.getDeletionStatus(deletionRequestId);
      return deletion === undefined
        ? failure(new Error(`Deletion request ${deletionRequestId} was not found`))
        : success({ deletion: deletion.value });
    },
  );

  server.registerTool(
    "bizforge_save_research_bundle",
    {
      title: "Save research bundle",
      description: "Validate and save a Step 2 research bundle.",
      inputSchema: z.object({ bundle: ResearchBundleSchema }).strict(),
      outputSchema: resultWithPayload(z.object({ bundle: ResearchBundleSchema })),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ bundle }) =>
      safely(() => {
        const record = store.saveResearchBundle(bundle);
        return { bundle: record.value };
      }),
  );

  server.registerTool(
    "bizforge_get_research_bundle",
    {
      title: "Get research bundle",
      description: "Read a specific or latest version of a research bundle.",
      inputSchema: z
        .object({
          bundleId: z.string().min(1),
          bundleVersion: z.number().int().positive().optional(),
        })
        .strict(),
      outputSchema: resultWithPayload(z.object({ bundle: ResearchBundleSchema })),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ bundleId, bundleVersion }) => {
      const record = store.getResearchBundle(bundleId, bundleVersion);
      return record === undefined
        ? failure(new Error(`Research bundle ${bundleId} was not found`))
        : success({ bundle: record.value });
    },
  );

  server.registerTool(
    "bizforge_get_latest_research_bundle",
    {
      title: "Get latest research bundle",
      description:
        "Read the latest bundle globally by calling with an empty object, or supply one exact founderId. Wildcards and global selector strings are not supported.",
      inputSchema: z
        .object({
          founderId: z
            .string()
            .min(1)
            .optional()
            .describe("Exact founder ID. Omit this field for the global latest bundle."),
        })
        .strict(),
      outputSchema: resultWithPayload(z.object({ bundle: ResearchBundleSchema })),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ founderId }) => {
      const record = store.getLatestResearchBundle(founderId);
      return record === undefined
        ? failure(new Error("No matching research bundle was found"))
        : success({ bundle: record.value });
    },
  );

  server.registerTool(
    "bizforge_list_opportunities",
    {
      title: "List opportunity projections",
      description: "List evidence-aware Step 3 opportunity summaries from a research bundle.",
      inputSchema: BundleLocatorSchema,
      outputSchema: resultWithPayload(
        z.object({
          bundleId: z.string(),
          bundleVersion: z.number().int().positive(),
          opportunities: z.array(OpportunitySummarySchema),
        }),
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      safely(() => {
        const record = resolveBundle(store, input);
        return {
          bundleId: record.value.bundleId,
          bundleVersion: record.value.bundleVersion,
          opportunities: record.value.opportunities.map((opportunity) => ({
            opportunityId: opportunity.opportunityId,
            title: opportunity.title,
            summary: opportunity.summary,
            market: opportunity.scarcityHypothesis.market,
            founderFit: opportunity.founderFit.rating,
            economicBuyerHypothesis: opportunity.scarcityHypothesis.economicBuyer,
            buyerEvidenceStatus: "unlinked/hypothesis_only" as const,
            confidence: opportunity.confidence,
            evidenceIds: opportunity.evidenceIds,
          })),
        };
      }),
  );

  server.registerTool(
    "bizforge_get_opportunity",
    {
      title: "Get opportunity projection",
      description: "Read one full opportunity with an explicit buyer-evidence limitation.",
      inputSchema: BundleLocatorSchema.extend({ opportunityId: z.string().min(1) }),
      outputSchema: resultWithPayload(
        z.object({
          bundleId: z.string(),
          opportunity: OpportunityDossierSchema,
          buyerEvidenceStatus: z.literal("unlinked/hypothesis_only"),
          buyerEvidenceWarning: z.string(),
        }),
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ opportunityId, ...locator }) =>
      safely(() => {
        const record = resolveBundle(store, locator);
        return {
          bundleId: record.value.bundleId,
          opportunity: findOpportunity(record.value, opportunityId),
          buyerEvidenceStatus: "unlinked/hypothesis_only" as const,
          buyerEvidenceWarning:
            "The current ResearchBundle schema does not link economicBuyer text to buyer-specific claims; treat it as a hypothesis.",
        };
      }),
  );

  server.registerTool(
    "bizforge_get_market_signals",
    {
      title: "Get market signals",
      description: "Read market signals and their evidence IDs without inventing trend claims.",
      inputSchema: BundleLocatorSchema,
      outputSchema: resultWithPayload(
        z.object({
          bundleId: z.string(),
          bundleVersion: z.number().int().positive(),
          marketSignals: z.array(MarketSignalSchema),
        }),
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      safely(() => {
        const record = resolveBundle(store, input);
        return {
          bundleId: record.value.bundleId,
          bundleVersion: record.value.bundleVersion,
          marketSignals: record.value.marketSignals,
        };
      }),
  );

  server.registerTool(
    "bizforge_get_growth_chart_data",
    {
      title: "Get growth chart data",
      description:
        "Project chart-ready growth only when both windows, values, changes, methodology, coverage, and evidence are present.",
      inputSchema: BundleLocatorSchema.extend({ signalId: z.string().min(1).optional() }),
      outputSchema: resultWithPayload(GrowthChartPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ signalId, ...locator }) =>
      safely(() => {
        const record = resolveBundle(store, locator);
        const signals =
          signalId === undefined
            ? record.value.marketSignals
            : record.value.marketSignals.filter((signal) => signal.signalId === signalId);
        if (signalId !== undefined && signals.length === 0) {
          throw new Error(`Market signal ${signalId} was not found`);
        }
        return {
          bundleId: record.value.bundleId,
          charts: signals.map((signal) => projectGrowth(signal)),
          chartPolicy:
            "Render numeric growth only for eligible projections and keep methodology, coverage, evidence IDs, and inference status visible.",
        };
      }),
  );
}
