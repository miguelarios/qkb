import { defineConfig } from "vitest/config";

// Integration tests (real Ollama/OpenAI/node-llama-cpp network or model calls)
// live alongside unit tests as `*.integration.test.ts` and are excluded by
// default — mirrors the Python suite's `-m "not integration"`. Set
// QKB_INTEGRATION=1 to include them (never done in CI).
const runIntegration = process.env.QKB_INTEGRATION === "1";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/legacy/**",
      "**/dist/**",
      ...(runIntegration ? [] : ["test/**/*.integration.test.ts"]),
    ],
  },
});
