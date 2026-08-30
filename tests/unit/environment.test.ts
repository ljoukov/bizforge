import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, summarizeRuntimeConfig } from "../../src/config/environment.js";

const validEnvironment = {
  OPENAI_API_KEY: "openai-secret",
  BRIGHT_DATA_API_KEY: "bright-data-secret",
  DAYTONA_API_KEY: "daytona-secret",
};

describe("loadRuntimeConfig", () => {
  it("uses local TrueForge defaults", () => {
    const config = loadRuntimeConfig(validEnvironment);

    expect(config.trueForge).toEqual({
      agentName: "bizforge-research",
      baseUrl: "http://localhost:8790",
    });
  });

  it("rejects missing credentials without printing credential values", () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment,
        BRIGHT_DATA_API_KEY: "",
      }),
    ).toThrow();
  });

  it("returns a summary containing no credential values", () => {
    const config = loadRuntimeConfig({
      ...validEnvironment,
      TRUEFORGE_TOKEN: "trueforge-secret",
    });

    const summary = summarizeRuntimeConfig(config);
    const serialized = JSON.stringify(summary);

    expect(summary.usesTrueForgeAuthentication).toBe(true);
    expect(serialized).not.toContain("openai-secret");
    expect(serialized).not.toContain("bright-data-secret");
    expect(serialized).not.toContain("daytona-secret");
    expect(serialized).not.toContain("trueforge-secret");
  });
});
