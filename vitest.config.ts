import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Limits shared by every test project. Small caps keep the suite fast. */
const COMMON = {
  GETBUS_MAX_MSGS_PER_TOPIC: "5",
  GETBUS_TTL_IDLE_S: "60",
  // No isolate-level caching, so a test sees difficulty changes immediately.
  GETBUS_DIFFICULTY_CACHE_MS: "0",
  // wrangler.toml carries the real deployment's notice; blank it here so the
  // default projects test an instance whose operator has set neither. The
  // "operator" project below supplies its own values.
  GETBUS_NOTICE: "",
  GETBUS_ABUSE_CONTACT: "",
};

const workers = (bindings: Record<string, string>) =>
  cloudflareTest({
    wrangler: { configPath: "./wrangler.toml" },
    miniflare: { bindings: { ...COMMON, ...bindings } },
  });

export default defineConfig({
  test: {
    projects: [
      {
        // A quiet instance: difficulty 0, no nonce needed.
        plugins: [workers({ GETBUS_POW_MIN_DIFFICULTY: "0" })],
        test: {
          name: "bus",
          include: ["test/*.test.ts"],
          exclude: ["test/pow-write.test.ts", "test/operator.test.ts"],
        },
      },
      {
        // A loaded instance: the difficulty floor stands in for a busy rate window,
        // so the write-path PoW gate is deterministic rather than timing-dependent.
        plugins: [workers({ GETBUS_POW_MIN_DIFFICULTY: "10", GETBUS_POW_MAX_DIFFICULTY: "10" })],
        test: { name: "pow", include: ["test/pow-write.test.ts"] },
      },
      {
        // An instance where the operator has null-routed a topic and published
        // a notice — the two levers in docs/ANTI-ABUSE.md §Operational hygiene.
        plugins: [
          workers({
            GETBUS_BLOCKED_TOPICS: "spam.topic, another.blocked",
            GETBUS_NOTICE: "experimental research instance",
            GETBUS_ABUSE_CONTACT: "abuse@getbus.example",
          }),
        ],
        test: { name: "operator", include: ["test/operator.test.ts"] },
      },
    ],
  },
});
