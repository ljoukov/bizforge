import { z } from "zod";

const nonEmptySecret = z.string().trim().min(1);

export const runtimeEnvironmentSchema = z.object({
  OPENAI_API_KEY: nonEmptySecret,
  BRIGHT_DATA_API_KEY: nonEmptySecret,
  DAYTONA_API_KEY: nonEmptySecret,
  TRUEFORGE_BASE_URL: z.url().default("http://localhost:8790"),
  TRUEFORGE_AGENT_NAME: z.string().trim().min(1).default("bizforge-research"),
  TRUEFORGE_TOKEN: nonEmptySecret.optional(),
});

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export interface RuntimeConfig {
  trueForge: {
    baseUrl: string;
    agentName: string;
    token?: string;
  };
  credentials: {
    openAiApiKey: string;
    brightDataApiKey: string;
    daytonaApiKey: string;
  };
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const parsed = runtimeEnvironmentSchema.parse(environment);

  return {
    trueForge: {
      baseUrl: parsed.TRUEFORGE_BASE_URL,
      agentName: parsed.TRUEFORGE_AGENT_NAME,
      ...(parsed.TRUEFORGE_TOKEN === undefined ? {} : { token: parsed.TRUEFORGE_TOKEN }),
    },
    credentials: {
      openAiApiKey: parsed.OPENAI_API_KEY,
      brightDataApiKey: parsed.BRIGHT_DATA_API_KEY,
      daytonaApiKey: parsed.DAYTONA_API_KEY,
    },
  };
}

export interface SafeRuntimeConfigSummary {
  trueForgeBaseUrl: string;
  trueForgeAgentName: string;
  usesTrueForgeAuthentication: boolean;
  configuredCredentials: readonly ["openai", "bright-data", "daytona"];
}

export function summarizeRuntimeConfig(config: RuntimeConfig): SafeRuntimeConfigSummary {
  return {
    trueForgeBaseUrl: config.trueForge.baseUrl,
    trueForgeAgentName: config.trueForge.agentName,
    usesTrueForgeAuthentication: config.trueForge.token !== undefined,
    configuredCredentials: ["openai", "bright-data", "daytona"],
  };
}
