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
  type DataStoreStatus,
  DataStoreStatusSchema,
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
import type { BizForgeDataStore } from "./data-store.js";
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

const persistentResultWithPayload = <T extends z.ZodType>(payload: T) =>
  z.object({ dataNotice: z.string().optional(), payload });

const DataStatusPayloadSchema = DataStoreStatusSchema.extend({
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
  inferenceStatus: z.enum(["synthetic_evidence_backed_inference", "evidence_backed_inference"]),
});

const PersistentEligibleGrowthProjectionSchema = GrowthProjectionCoreSchema.extend({
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

const PersistentGrowthChartPayloadSchema = z.object({
  bundleId: z.string(),
  charts: z.array(
    z.discriminatedUnion("eligible", [
      IneligibleGrowthProjectionSchema,
      PersistentEligibleGrowthProjectionSchema,
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
});
const PersistentSavedProfilePayloadSchema = z.object({
  snapshotId: z.string(),
  setupState: z.literal("CONFIRMED"),
  stage2HandoffEligible: z.boolean(),
});
const DeletionPayloadSchema = z.object({ deletion: DeletionRecordSchema });

type EnvelopeOptions = {
  isSynthetic?: boolean;
  source?: "mock_seed" | "mcp_write" | "mixed";
  provenanceMode?: "synthetic_fixture" | "mock_user_input" | "mixed_mock" | "recorded_data";
  warnings?: readonly string[];
};

const syntheticWarning =
  "Synthetic fixtures are for testing only and are not real market or buyer evidence.";

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
  const exposeDiagnosticEnvelope = store.getDataStatus().isMock;
  const success = (
    payload: unknown,
    options?: EnvelopeOptions,
    persistentText = "Completed successfully.",
  ) => {
    const dataNotice = options?.isSynthetic === true ? syntheticWarning : undefined;
    const structuredContent = exposeDiagnosticEnvelope
      ? createResponseEnvelope(payload, store.getDataStatus(), options)
      : { ...(dataNotice === undefined ? {} : { dataNotice }), payload };
    return {
      content: [
        {
          type: "text" as const,
          text: exposeDiagnosticEnvelope
            ? JSON.stringify(structuredContent)
            : [dataNotice, persistentText].filter(Boolean).join(" "),
        },
      ],
      structuredContent,
    };
  };
  const safelyWithOrigin = async (
    operation: () => unknown,
    options: EnvelopeOptions | (() => EnvelopeOptions),
    persistentText?: string | (() => string),
  ) => {
    try {
      const payload = await operation();
      return success(
        payload,
        typeof options === "function" ? options() : options,
        typeof persistentText === "function" ? persistentText() : persistentText,
      );
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

function booleanControl(input: object, key: "isSynthetic" | "acceptMockStorage"): boolean {
  return (input as Record<string, unknown>)[key] === true;
}

function optionalStringControl(input: object, key: "founderId" | "setupRunId"): string | undefined {
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
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

function projectGrowth(signal: MarketSignal, isSynthetic: boolean, exposeDataMode: boolean) {
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
  const projection = {
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
  return exposeDataMode
    ? {
        ...projection,
        inferenceStatus: isSynthetic
          ? ("synthetic_evidence_backed_inference" as const)
          : projection.inferenceStatus,
      }
    : projection;
}

export function registerBizForgeTools(server: McpServer, store: BizForgeDataStore): void {
  const { safelyWithOrigin, success } = createResponder(store);
  const mockMode = store.getDataStatus().isMock;
  const responseWithPayload = <T extends z.ZodType>(payload: T) =>
    mockMode ? envelopeWithPayload(payload) : persistentResultWithPayload(payload);
  server.registerTool(
    "bizforge_get_data_status",
    {
      title: "Get BizForge data status",
      description: mockMode
        ? "Report mock/persistence mode and available projection capabilities."
        : "Check whether BizForge is ready for founder onboarding and downstream work.",
      inputSchema: z.object({}),
      outputSchema: responseWithPayload(
        mockMode ? DataStatusPayloadSchema : PersistentDataStatusPayloadSchema,
      ),
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
      const persistenceReady =
        status.persistenceStatus === "persistent" && !status.ephemeral && !status.isMock;
      const founderDataWrites = persistenceReady && status.writePolicy.acceptsNonSyntheticWrites;
      const payload = mockMode
        ? {
            ...status,
            domainSchemaVersion: "1.0.0" as const,
            capabilities,
          }
        : {
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
        {
          isSynthetic: status.isMock,
          source: status.isMock ? "mock_seed" : "mcp_write",
          provenanceMode: status.isMock ? "synthetic_fixture" : "recorded_data",
        },
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
        "Optional for legacy compatibility. New interactive onboarding must generate a fresh UUID internally, reuse it for exact retries after a lost response, and never request it from an end user.",
      ),
  };
  const legacySetupRuntimeIdInputShape = {
    founderId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional internal runtime ID for backward-compatible replay or integration use. Omit for a new onboarding; the server assigns founder-*. Never request this ID from an end user.",
      ),
    setupRunId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional internal runtime ID for backward-compatible replay or integration use. Omit for a new onboarding; the server assigns setup-*. Never request this ID from an end user.",
      ),
  };
  server.registerTool(
    "bizforge_create_founder_setup_run",
    {
      title: "Start founder setup with server-assigned runtime IDs",
      description:
        "Create a versioned Step 1 setup run. Keyed requests replay safely: for each new interactive onboarding, the calling application or agent should generate a fresh clientRequestId UUID internally and reuse it only for an exact retry; never ask the end user for this key. Legacy callers may omit clientRequestId, but unkeyed creation is not retry-safe when IDs are server assigned. founderId and setupRunId are internal runtime IDs: omit both for a new onboarding and never ask an end user to provide them.",
      inputSchema: mockMode
        ? z.object({
            ...createSetupRunInputShape,
            ...legacySetupRuntimeIdInputShape,
            isSynthetic: IsSyntheticInputSchema,
            acceptMockStorage: AcceptMockStorageSchema,
          })
        : z.object(createSetupRunInputShape).strict(),
      outputSchema: responseWithPayload(SetupRunPayloadSchema),
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      const { clientRequestId } = input;
      const founderId = optionalStringControl(input, "founderId");
      const setupRunId = optionalStringControl(input, "setupRunId");
      const isSynthetic = booleanControl(input, "isSynthetic");
      const acceptMockStorage = booleanControl(input, "acceptMockStorage");
      let record: ReturnType<BizForgeDataStore["createSetupRun"]> | undefined;
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage, isSynthetic);
          record = store.createSetupRun({
            isSynthetic,
            ...(clientRequestId === undefined ? {} : { clientRequestId }),
            ...(founderId === undefined ? {} : { founderId }),
            ...(setupRunId === undefined ? {} : { setupRunId }),
          });
          return { run: record.value };
        },
        () => (record === undefined ? { isSynthetic } : originOf(record)),
        "Setup started.",
      );
    },
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
      inputSchema: z.object({ setupRunId: z.string().min(1) }),
      outputSchema: responseWithPayload(SetupRunPayloadSchema),
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
      description:
        "Compare-and-set a setup state with an idempotency key. INTERVIEW may transition to INTERVIEW for incremental checkpoints. Supplied stateData replaces the prior object, so read and merge the current stateData before writing a checkpoint.",
      inputSchema: mockMode
        ? z.object({
            ...transitionSetupRunInputShape,
            acceptMockStorage: AcceptMockStorageSchema,
          })
        : z.object(transitionSetupRunInputShape).strict(),
      outputSchema: responseWithPayload(TransitionPayloadSchema),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async (rawInput) => {
      const acceptMockStorage = booleanControl(rawInput, "acceptMockStorage");
      const { setupRunId, expectedVersion, targetState, idempotencyKey, stateData } = rawInput;
      const input = { setupRunId, expectedVersion, targetState, idempotencyKey, stateData };
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
      inputSchema: mockMode
        ? z.object({
            consent: ConsentRecordSchema,
            acceptMockStorage: AcceptMockStorageSchema,
          })
        : z.object({ consent: ConsentRecordSchema }).strict(),
      outputSchema: responseWithPayload(ConsentPayloadSchema),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async (input) => {
      const { consent } = input;
      const acceptMockStorage = booleanControl(input, "acceptMockStorage");
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
      outputSchema: responseWithPayload(ConsentListPayloadSchema),
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
      description: "Store a canonical evidence item.",
      inputSchema: mockMode
        ? z.object({
            setupRunId: z.string().min(1),
            evidence: EvidenceItemSchema,
            isSynthetic: IsSyntheticInputSchema,
            acceptMockStorage: AcceptMockStorageSchema,
          })
        : z
            .object({
              setupRunId: z.string().min(1),
              evidence: EvidenceItemSchema,
            })
            .strict(),
      outputSchema: responseWithPayload(z.object({ evidence: EvidenceItemSchema })),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async (input) => {
      const { setupRunId, evidence } = input;
      const isSynthetic = booleanControl(input, "isSynthetic");
      const acceptMockStorage = booleanControl(input, "acceptMockStorage");
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
      outputSchema: responseWithPayload(z.object({ evidence: EvidenceItemSchema })),
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
      outputSchema: responseWithPayload(ValidationPayloadSchema),
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
      inputSchema: mockMode
        ? z.object({
            setupRunId: z.string().min(1),
            expectedVersion: z.number().int().positive(),
            idempotencyKey: z.string().min(1),
            profile: ConfirmedFounderProfileSnapshotSchema,
            isSynthetic: IsSyntheticInputSchema,
            acceptMockStorage: AcceptMockStorageSchema,
          })
        : z
            .object({
              setupRunId: z.string().min(1),
              expectedVersion: z.number().int().positive(),
              idempotencyKey: z.string().min(1),
              profile: ConfirmedFounderProfileSnapshotSchema,
            })
            .strict(),
      outputSchema: responseWithPayload(
        mockMode ? SavedProfilePayloadSchema : PersistentSavedProfilePayloadSchema,
      ),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async (rawInput) => {
      const acceptMockStorage = booleanControl(rawInput, "acceptMockStorage");
      const isSynthetic = booleanControl(rawInput, "isSynthetic");
      const { setupRunId, expectedVersion, idempotencyKey, profile } = rawInput;
      const input = { setupRunId, expectedVersion, idempotencyKey, profile, isSynthetic };
      let profileOrigin: RecordOrigin | undefined;
      let persistentConfirmation:
        | {
            snapshotId: string;
            setupState: "CONFIRMED";
            stage2HandoffEligible: boolean;
          }
        | undefined;
      return safelyWithOrigin(
        () => {
          assertWritePolicy(store, acceptMockStorage, input.isSynthetic);
          const result = store.confirmFounderProfile(input);
          profileOrigin = result.profile;
          if (result.run.state !== "CONFIRMED") {
            throw new Error("Confirmed profile save returned an invalid setup state");
          }
          persistentConfirmation = {
            snapshotId: result.profile.value.snapshotId,
            setupState: result.run.state,
            stage2HandoffEligible: result.stage2HandoffEligible,
          };
          return mockMode
            ? {
                profile: result.profile.value,
                run: result.run,
                replayed: result.replayed,
                stage2HandoffEligible: result.stage2HandoffEligible,
              }
            : persistentConfirmation;
        },
        () =>
          profileOrigin === undefined
            ? { isSynthetic: input.isSynthetic }
            : originOf(profileOrigin),
        () =>
          persistentConfirmation === undefined
            ? "Founder profile confirmed."
            : `Founder profile confirmed. Snapshot ${persistentConfirmation.snapshotId}; setup ${persistentConfirmation.setupState}; downstream research ${persistentConfirmation.stage2HandoffEligible ? "eligible" : "not enabled"}.`,
      );
    },
  );

  server.registerTool(
    "bizforge_get_confirmed_founder_profile",
    {
      title: "Get confirmed founder profile",
      description: "Read an immutable confirmed founder snapshot by ID.",
      inputSchema: z.object({ snapshotId: z.string().min(1) }),
      outputSchema: responseWithPayload(
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
      title: "Request setup-run data deletion",
      description:
        "Delete controllable records associated with one setup run and report remaining external, provider, or backup obligations truthfully.",
      inputSchema: mockMode
        ? z.object({
            setupRunId: z.string().min(1),
            founderId: z.string().min(1),
            reason: z.string().min(1),
            idempotencyKey: z.string().min(1),
            acceptMockStorage: AcceptMockStorageSchema,
          })
        : z
            .object({
              setupRunId: z.string().min(1),
              founderId: z.string().min(1),
              reason: z.string().min(1),
              idempotencyKey: z.string().min(1),
            })
            .strict(),
      outputSchema: responseWithPayload(DeletionPayloadSchema),
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
    },
    async (rawInput) => {
      const acceptMockStorage = booleanControl(rawInput, "acceptMockStorage");
      const { setupRunId, founderId, reason, idempotencyKey } = rawInput;
      const input = { setupRunId, founderId, reason, idempotencyKey };
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
      outputSchema: responseWithPayload(DeletionPayloadSchema),
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
      description: "Validate and save a Step 2 research bundle.",
      inputSchema: mockMode
        ? z.object({
            bundle: ResearchBundleSchema,
            isSynthetic: IsSyntheticInputSchema,
            acceptMockStorage: AcceptMockStorageSchema,
          })
        : z.object({ bundle: ResearchBundleSchema }).strict(),
      outputSchema: responseWithPayload(z.object({ bundle: ResearchBundleSchema })),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async (input) => {
      const { bundle } = input;
      const isSynthetic = booleanControl(input, "isSynthetic");
      const acceptMockStorage = booleanControl(input, "acceptMockStorage");
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
      outputSchema: responseWithPayload(z.object({ bundle: ResearchBundleSchema })),
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
      outputSchema: responseWithPayload(z.object({ bundle: ResearchBundleSchema })),
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
      outputSchema: responseWithPayload(
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
      outputSchema: responseWithPayload(
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
      outputSchema: responseWithPayload(
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
      outputSchema: responseWithPayload(
        mockMode ? GrowthChartPayloadSchema : PersistentGrowthChartPayloadSchema,
      ),
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
            charts: signals.map((signal) =>
              projectGrowth(signal, record?.isSynthetic ?? false, mockMode),
            ),
            chartPolicy:
              "Render numeric growth only for eligible projections and keep methodology, coverage, evidence IDs, and inference status visible.",
          };
        },
        () => (record === undefined ? {} : originOf(record)),
      );
    },
  );
}
