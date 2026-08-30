import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { EvidenceItemSchema } from "../domain/evidence.js";
import {
  ConfirmedFounderProfileSnapshotSchema,
  FounderProfileSnapshotSchema,
} from "../domain/founder-profile.js";
import { ConfidenceBoundsSchema, DateRangeSchema } from "../domain/common.js";
import { MarketSignalSchema, type MarketSignal } from "../domain/market-signal.js";
import {
  OpportunityDossierSchema,
  type OpportunityDossier,
} from "../domain/opportunity-dossier.js";
import { ResearchBundleSchema, type ResearchBundle } from "../domain/research-bundle.js";
import type { BizForgeDataStore } from "./data-store.js";
import {
  ConsentRecordSchema,
  ConsentScopeSchema,
  DataStoreStatusSchema,
  type DataStoreStatus,
  DESTRUCTIVE_WRITE_ANNOTATIONS,
  DeletionRecordSchema,
  FounderSetupRunSchema,
  FounderSetupStateSchema,
  IDEMPOTENT_WRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  type RecordOrigin,
  type StoredResearchBundleRecord,
  WRITE_ANNOTATIONS,
} from "./contracts.js";
import { canonicalContentSha256 } from "./integrity.js";

const EnvelopeBaseSchema = DataStoreStatusSchema.extend({
  schemaVersion: z.literal("1.0.0"),
  isSynthetic: z.boolean(),
  provenanceMode: z.enum(["synthetic_fixture", "mock_user_input", "mixed_mock", "recorded_data"]),
  source: z.enum(["mock_seed", "mcp_write", "mixed"]),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const envelopeWithPayload = <T extends z.ZodType>(payload: T) =>
  EnvelopeBaseSchema.extend({ payload });

const DataStatusPayloadSchema = DataStoreStatusSchema.extend({
  domainSchemaVersion: z.literal("1.0.0"),
  capabilities: z.object({
    step1Writes: z.boolean(),
    mockStep2Synthesis: z.boolean(),
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

const EligibleGrowthProjectionSchema = z.object({
  signalId: z.string(),
  eligible: z.literal(true),
  demoEligible: z.boolean(),
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
  inferenceStatus: z.enum(["synthetic_evidence_backed_inference", "evidence_backed_inference"]),
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
  profile: ConfirmedFounderProfileSnapshotSchema,
  run: FounderSetupRunSchema,
  replayed: z.boolean(),
  stage2HandoffEligible: z.boolean(),
  mockStep2DemoEligible: z.boolean(),
  mockStep2Bundle: z
    .object({
      bundleId: z.string(),
      bundleVersion: z.number().int().positive(),
      founderProfileSnapshotId: z.string(),
    })
    .nullable(),
});
const DeletionPayloadSchema = z.object({ deletion: DeletionRecordSchema });

type EnvelopeOptions = {
  isSynthetic?: boolean;
  source?: "mock_seed" | "mcp_write" | "mixed";
  provenanceMode?: "synthetic_fixture" | "mock_user_input" | "mixed_mock" | "recorded_data";
  warnings?: readonly string[];
};

const syntheticWarning =
  "Synthetic fixtures demonstrate product behavior only and are not real market or buyer evidence.";

export function createResponseEnvelope(
  payload: unknown,
  status: DataStoreStatus,
  options: EnvelopeOptions = {},
) {
  const isSynthetic = options.isSynthetic ?? false;
  const source = options.source ?? "mcp_write";
  return {
    ...status,
    schemaVersion: "1.0.0" as const,
    isSynthetic,
    provenanceMode:
      options.provenanceMode ??
      (isSynthetic ? "synthetic_fixture" : status.isMock ? "mock_user_input" : "recorded_data"),
    source,
    contentSha256: canonicalContentSha256(payload),
    warnings: [
      ...status.warnings,
      ...(isSynthetic ? [syntheticWarning] : []),
      ...(options.warnings ?? []),
    ],
    payload,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown BizForge MCP error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function createResponder(store: BizForgeDataStore) {
  const success = (payload: unknown, options?: EnvelopeOptions) => {
    const structuredContent = createResponseEnvelope(payload, store.getDataStatus(), options);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  };
  const safelyWithOrigin = async (
    operation: () => unknown,
    options: EnvelopeOptions | (() => EnvelopeOptions),
  ) => {
    try {
      const payload = await operation();
      return success(payload, typeof options === "function" ? options() : options);
    } catch (error) {
      return failure(error);
    }
  };
  return { safelyWithOrigin, success };
}

function originOf(record: RecordOrigin): EnvelopeOptions {
  return {
    isSynthetic: record.isSynthetic,
    source: record.source,
  };
}

const AcceptMockStorageSchema = z
  .boolean()
  .default(false)
  .describe(
    "Set true to acknowledge mock/ephemeral storage when the active adapter requires it; persistent adapters accept false.",
  );

const IsSyntheticInputSchema = z
  .boolean()
  .describe("Whether the submitted record is explicitly synthetic rather than real founder data.");

function assertWritePolicy(
  store: BizForgeDataStore,
  acceptMockStorage: boolean,
  isSynthetic?: boolean,
): void {
  const { writePolicy } = store.getDataStatus();
  if (writePolicy.requiresExplicitMockAcceptance && !acceptMockStorage) {
    throw new Error(
      "The active mock storage adapter requires acceptMockStorage: true because writes are ephemeral",
    );
  }
  if (isSynthetic === false && !writePolicy.acceptsNonSyntheticWrites) {
    throw new Error("The active storage adapter accepts synthetic records only");
  }
}

const BundleLocatorSchema = z.object({
  bundleId: z.string().min(1).optional(),
  bundleVersion: z.number().int().positive().optional(),
  founderId: z.string().min(1).optional(),
});

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

function projectGrowth(signal: MarketSignal, isSynthetic: boolean) {
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
    demoEligible: isSynthetic,
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
    inferenceStatus: isSynthetic
      ? ("synthetic_evidence_backed_inference" as const)
      : ("evidence_backed_inference" as const),
  };
}

export function registerBizForgeTools(server: McpServer, store: BizForgeDataStore): void {
  const { safelyWithOrigin, success } = createResponder(store);
  server.registerTool(
    "bizforge_get_data_status",
    {
      title: "Get BizForge data status",
      description: "Report mock/persistence mode and available projection capabilities.",
      inputSchema: z.object({}),
      outputSchema: envelopeWithPayload(DataStatusPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const status = store.getDataStatus();
      return success(
        {
          ...status,
          domainSchemaVersion: "1.0.0",
          capabilities: {
            step1Writes: true,
            mockStep2Synthesis: status.isMock,
            step3ReadProjections: true,
            growthChartProjection: true,
            buyerEvidenceProjection: false,
            opportunityRerank: false,
          },
        },
        {
          isSynthetic: status.isMock,
          source: status.isMock ? "mock_seed" : "mcp_write",
          provenanceMode: status.isMock ? "synthetic_fixture" : "recorded_data",
        },
      );
    },
  );

  server.registerTool(
    "bizforge_create_founder_setup_run",
    {
      title: "Create founder setup run",
      description: "Create a versioned Step 1 setup run in the active storage adapter.",
      inputSchema: z.object({
        founderId: z.string().min(1),
        setupRunId: z.string().min(1).optional(),
        isSynthetic: IsSyntheticInputSchema,
        acceptMockStorage: AcceptMockStorageSchema,
      }),
      outputSchema: envelopeWithPayload(SetupRunPayloadSchema),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ founderId, setupRunId, isSynthetic, acceptMockStorage }) => {
      let record: ReturnType<BizForgeDataStore["createSetupRun"]> | undefined;
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage, isSynthetic);
          record = store.createSetupRun({
            founderId,
            isSynthetic,
            ...(setupRunId === undefined ? {} : { setupRunId }),
          });
          return { run: record.value };
        },
        () => (record === undefined ? { isSynthetic } : originOf(record)),
      );
    },
  );

  server.registerTool(
    "bizforge_get_founder_setup_run",
    {
      title: "Get founder setup run",
      description: "Read the current version and state of a Step 1 setup run.",
      inputSchema: z.object({ setupRunId: z.string().min(1) }),
      outputSchema: envelopeWithPayload(SetupRunPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ setupRunId }) => {
      const record = store.getSetupRun(setupRunId);
      if (record === undefined) return failure(new Error(`Setup run ${setupRunId} was not found`));
      return success({ run: record.value }, originOf(record));
    },
  );

  server.registerTool(
    "bizforge_transition_founder_setup_run",
    {
      title: "Transition founder setup run",
      description: "Compare-and-set a setup state with an idempotency key.",
      inputSchema: z.object({
        setupRunId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        targetState: FounderSetupStateSchema,
        idempotencyKey: z.string().min(1),
        stateData: z.record(z.string(), z.unknown()).optional(),
        acceptMockStorage: AcceptMockStorageSchema,
      }),
      outputSchema: envelopeWithPayload(TransitionPayloadSchema),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ acceptMockStorage, ...input }) => {
      const before = store.getSetupRun(input.setupRunId);
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage);
          return store.transitionSetupRun({
            setupRunId: input.setupRunId,
            expectedVersion: input.expectedVersion,
            targetState: input.targetState,
            idempotencyKey: input.idempotencyKey,
            ...(input.stateData === undefined ? {} : { stateData: input.stateData }),
          });
        },
        { isSynthetic: before?.isSynthetic ?? false, source: before?.source ?? "mcp_write" },
      );
    },
  );

  server.registerTool(
    "bizforge_record_consent",
    {
      title: "Record founder consent",
      description: "Persist an immutable, separately scoped consent event.",
      inputSchema: z.object({
        consent: ConsentRecordSchema,
        acceptMockStorage: AcceptMockStorageSchema,
      }),
      outputSchema: envelopeWithPayload(ConsentPayloadSchema),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ consent, acceptMockStorage }) => {
      let record: ReturnType<BizForgeDataStore["recordConsent"]> | undefined;
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage);
          record = store.recordConsent(consent);
          return { consent: record.value };
        },
        () => (record === undefined ? {} : originOf(record)),
      );
    },
  );

  server.registerTool(
    "bizforge_get_consent",
    {
      title: "Get founder consent",
      description: "Resolve consent history for a setup run and optional scope.",
      inputSchema: z.object({
        setupRunId: z.string().min(1),
        scope: ConsentScopeSchema.optional(),
      }),
      outputSchema: envelopeWithPayload(ConsentListPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ setupRunId, scope }) =>
      safelyWithOrigin(
        () => {
          const records = store.getConsent(setupRunId, scope);
          return { consents: records.map(({ value }) => value) };
        },
        { isSynthetic: store.getSetupRun(setupRunId)?.isSynthetic ?? false, source: "mixed" },
      ),
  );

  server.registerTool(
    "bizforge_put_evidence",
    {
      title: "Put canonical evidence",
      description: "Store a canonical evidence item in the active storage adapter.",
      inputSchema: z.object({
        setupRunId: z.string().min(1),
        evidence: EvidenceItemSchema,
        isSynthetic: IsSyntheticInputSchema,
        acceptMockStorage: AcceptMockStorageSchema,
      }),
      outputSchema: envelopeWithPayload(z.object({ evidence: EvidenceItemSchema })),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ setupRunId, evidence, isSynthetic, acceptMockStorage }) => {
      let record: ReturnType<BizForgeDataStore["putEvidence"]> | undefined;
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage, isSynthetic);
          record = store.putEvidence(setupRunId, evidence, "mcp_write", isSynthetic);
          return { evidence: record.value };
        },
        () => (record === undefined ? { isSynthetic } : originOf(record)),
      );
    },
  );

  server.registerTool(
    "bizforge_get_evidence",
    {
      title: "Get canonical evidence",
      description: "Read a minimized evidence item by ID without exposing provider payloads.",
      inputSchema: z.object({ evidenceId: z.string().min(1) }),
      outputSchema: envelopeWithPayload(z.object({ evidence: EvidenceItemSchema })),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ evidenceId }) => {
      const record = store.getEvidence(evidenceId);
      if (record === undefined) return failure(new Error(`Evidence ${evidenceId} was not found`));
      return success({ evidence: record.value }, originOf(record));
    },
  );

  server.registerTool(
    "bizforge_validate_founder_profile_snapshot",
    {
      title: "Validate founder profile snapshot",
      description: "Validate a draft or confirmed snapshot using the pinned canonical schema.",
      inputSchema: z.object({ snapshot: z.unknown(), confirmationLevel: z.boolean() }),
      outputSchema: envelopeWithPayload(ValidationPayloadSchema),
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
        "Validate and immutably publish a founder snapshot; mock adapters may synthesize clearly labeled demo Step 2 data.",
      inputSchema: z.object({
        setupRunId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        idempotencyKey: z.string().min(1),
        profile: ConfirmedFounderProfileSnapshotSchema,
        isSynthetic: IsSyntheticInputSchema,
        acceptMockStorage: AcceptMockStorageSchema,
      }),
      outputSchema: envelopeWithPayload(SavedProfilePayloadSchema),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ acceptMockStorage, ...input }) => {
      let profileOrigin: RecordOrigin | undefined;
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage, input.isSynthetic);
          const result = store.confirmFounderProfile(input);
          profileOrigin = result.profile;
          const generated = result.mockStep2DemoEligible
            ? store.getLatestResearchBundle(input.profile.founderId)
            : undefined;
          return {
            profile: result.profile.value,
            run: result.run,
            replayed: result.replayed,
            stage2HandoffEligible: result.stage2HandoffEligible,
            mockStep2DemoEligible: result.mockStep2DemoEligible,
            mockStep2Bundle:
              generated === undefined
                ? null
                : {
                    bundleId: generated.value.bundleId,
                    bundleVersion: generated.value.bundleVersion,
                    founderProfileSnapshotId: generated.value.founderProfile.snapshotId,
                  },
          };
        },
        () =>
          profileOrigin === undefined
            ? { isSynthetic: input.isSynthetic }
            : originOf(profileOrigin),
      );
    },
  );

  server.registerTool(
    "bizforge_get_confirmed_founder_profile",
    {
      title: "Get confirmed founder profile",
      description: "Read an immutable confirmed founder snapshot by ID.",
      inputSchema: z.object({ snapshotId: z.string().min(1) }),
      outputSchema: envelopeWithPayload(
        z.object({ profile: ConfirmedFounderProfileSnapshotSchema }),
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ snapshotId }) => {
      const record = store.getFounderProfile(snapshotId);
      if (record === undefined)
        return failure(new Error(`Founder snapshot ${snapshotId} was not found`));
      return success({ profile: record.value }, originOf(record));
    },
  );

  server.registerTool(
    "bizforge_request_founder_data_deletion",
    {
      title: "Request founder data deletion",
      description:
        "Delete controllable records and report external/provider/backup obligations truthfully.",
      inputSchema: z.object({
        setupRunId: z.string().min(1),
        founderId: z.string().min(1),
        reason: z.string().min(1),
        idempotencyKey: z.string().min(1),
        acceptMockStorage: AcceptMockStorageSchema,
      }),
      outputSchema: envelopeWithPayload(DeletionPayloadSchema),
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
    },
    async ({ acceptMockStorage, ...input }) => {
      let record: ReturnType<BizForgeDataStore["requestDeletion"]> | undefined;
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage);
          record = store.requestDeletion(input);
          return { deletion: record.value };
        },
        () => (record === undefined ? {} : originOf(record)),
      );
    },
  );

  server.registerTool(
    "bizforge_get_deletion_status",
    {
      title: "Get deletion status",
      description: "Read per-system deletion status without collapsing unresolved obligations.",
      inputSchema: z.object({ deletionRequestId: z.string().min(1) }),
      outputSchema: envelopeWithPayload(DeletionPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ deletionRequestId }) => {
      const deletion = store.getDeletionStatus(deletionRequestId);
      return deletion === undefined
        ? failure(new Error(`Deletion request ${deletionRequestId} was not found`))
        : success({ deletion: deletion.value }, originOf(deletion));
    },
  );

  server.registerTool(
    "bizforge_save_research_bundle",
    {
      title: "Save research bundle",
      description: "Validate and save a Step 2 research bundle in the active storage adapter.",
      inputSchema: z.object({
        bundle: ResearchBundleSchema,
        isSynthetic: IsSyntheticInputSchema,
        acceptMockStorage: AcceptMockStorageSchema,
      }),
      outputSchema: envelopeWithPayload(z.object({ bundle: ResearchBundleSchema })),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ bundle, isSynthetic, acceptMockStorage }) => {
      let record: ReturnType<BizForgeDataStore["saveResearchBundle"]> | undefined;
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage, isSynthetic);
          record = store.saveResearchBundle(bundle, "mcp_write", isSynthetic);
          return { bundle: record.value };
        },
        () => (record === undefined ? { isSynthetic } : originOf(record)),
      );
    },
  );

  server.registerTool(
    "bizforge_get_research_bundle",
    {
      title: "Get research bundle",
      description: "Read a specific or latest version of a research bundle.",
      inputSchema: z.object({
        bundleId: z.string().min(1),
        bundleVersion: z.number().int().positive().optional(),
      }),
      outputSchema: envelopeWithPayload(z.object({ bundle: ResearchBundleSchema })),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ bundleId, bundleVersion }) => {
      const record = store.getResearchBundle(bundleId, bundleVersion);
      return record === undefined
        ? failure(new Error(`Research bundle ${bundleId} was not found`))
        : success({ bundle: record.value }, originOf(record));
    },
  );

  server.registerTool(
    "bizforge_get_latest_research_bundle",
    {
      title: "Get latest research bundle",
      description:
        "Read the latest bundle globally by calling with an empty object, or supply one exact founderId. Wildcards and global selector strings are not supported.",
      inputSchema: z.object({
        founderId: z
          .string()
          .min(1)
          .optional()
          .describe("Exact founder ID. Omit this field for the global latest bundle."),
      }),
      outputSchema: envelopeWithPayload(z.object({ bundle: ResearchBundleSchema })),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ founderId }) => {
      const record = store.getLatestResearchBundle(founderId);
      return record === undefined
        ? failure(new Error("No matching research bundle was found"))
        : success({ bundle: record.value }, originOf(record));
    },
  );

  server.registerTool(
    "bizforge_list_opportunities",
    {
      title: "List opportunity projections",
      description: "List evidence-aware Step 3 opportunity summaries from a research bundle.",
      inputSchema: BundleLocatorSchema,
      outputSchema: envelopeWithPayload(
        z.object({
          bundleId: z.string(),
          bundleVersion: z.number().int().positive(),
          opportunities: z.array(OpportunitySummarySchema),
        }),
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      let record: StoredResearchBundleRecord<ResearchBundle> | undefined;
      return safelyWithOrigin(
        () => {
          record = resolveBundle(store, input);
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
        },
        () => (record === undefined ? {} : originOf(record)),
      );
    },
  );

  server.registerTool(
    "bizforge_get_opportunity",
    {
      title: "Get opportunity projection",
      description: "Read one full opportunity with an explicit buyer-evidence limitation.",
      inputSchema: BundleLocatorSchema.extend({ opportunityId: z.string().min(1) }),
      outputSchema: envelopeWithPayload(
        z.object({
          bundleId: z.string(),
          opportunity: OpportunityDossierSchema,
          buyerEvidenceStatus: z.literal("unlinked/hypothesis_only"),
          buyerEvidenceWarning: z.string(),
        }),
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ opportunityId, ...locator }) => {
      let record: StoredResearchBundleRecord<ResearchBundle> | undefined;
      return safelyWithOrigin(
        () => {
          record = resolveBundle(store, locator);
          return {
            bundleId: record.value.bundleId,
            opportunity: findOpportunity(record.value, opportunityId),
            buyerEvidenceStatus: "unlinked/hypothesis_only" as const,
            buyerEvidenceWarning:
              "The current ResearchBundle schema does not link economicBuyer text to buyer-specific claims; treat it as a hypothesis.",
          };
        },
        () => (record === undefined ? {} : originOf(record)),
      );
    },
  );

  server.registerTool(
    "bizforge_get_market_signals",
    {
      title: "Get market signals",
      description: "Read market signals and their evidence IDs without inventing trend claims.",
      inputSchema: BundleLocatorSchema,
      outputSchema: envelopeWithPayload(
        z.object({
          bundleId: z.string(),
          bundleVersion: z.number().int().positive(),
          marketSignals: z.array(MarketSignalSchema),
        }),
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      let record: StoredResearchBundleRecord<ResearchBundle> | undefined;
      return safelyWithOrigin(
        () => {
          record = resolveBundle(store, input);
          return {
            bundleId: record.value.bundleId,
            bundleVersion: record.value.bundleVersion,
            marketSignals: record.value.marketSignals,
          };
        },
        () => (record === undefined ? {} : originOf(record)),
      );
    },
  );

  server.registerTool(
    "bizforge_get_growth_chart_data",
    {
      title: "Get growth chart data",
      description:
        "Project chart-ready growth only when both windows, values, changes, methodology, coverage, and evidence are present.",
      inputSchema: BundleLocatorSchema.extend({ signalId: z.string().min(1).optional() }),
      outputSchema: envelopeWithPayload(GrowthChartPayloadSchema),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ signalId, ...locator }) => {
      let record: StoredResearchBundleRecord<ResearchBundle> | undefined;
      return safelyWithOrigin(
        () => {
          record = resolveBundle(store, locator);
          const signals =
            signalId === undefined
              ? record.value.marketSignals
              : record.value.marketSignals.filter((signal) => signal.signalId === signalId);
          if (signalId !== undefined && signals.length === 0) {
            throw new Error(`Market signal ${signalId} was not found`);
          }
          return {
            bundleId: record.value.bundleId,
            charts: signals.map((signal) => projectGrowth(signal, record?.isSynthetic ?? false)),
            chartPolicy:
              "Render numeric growth only for eligible projections and keep methodology, coverage, evidence IDs, and inference status visible.",
          };
        },
        () => (record === undefined ? {} : originOf(record)),
      );
    },
  );
}
