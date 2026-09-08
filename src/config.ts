/**
 * Single source of truth for every configurable limit (PROTOCOL §7).
 * Defaults here; overrides come from `[vars]` in wrangler.toml.
 */

export const VERSION = "0.1";

export interface Env {
  TOPIC: DurableObjectNamespace;
  COORDINATOR: DurableObjectNamespace;
  /** Optional Cloudflare Rate Limiting binding; absent in dev/tests. */
  RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  [key: string]: unknown;
}

export interface PowConfig {
  /** Floor on advertised difficulty: charge a toll even while quiet. Default 0. */
  minDifficulty: number;
  /** Hard ceiling on advertised difficulty, in leading zero bits. */
  maxDifficulty: number;
  /** Sustained writes/sec that buy one extra bit of difficulty. */
  ratePerBit: number;
  /** Width of the rolling rate window, in seconds. */
  windowS: number;
  /** How long the Worker isolate caches `difficulty` before re-asking. */
  cacheMs: number;
}

export interface Config {
  version: string;
  maxBytes: number;
  maxMsgsPerTopic: number;
  ttlIdleS: number;
  maxTopicLen: number;
  maxWaitS: number;
  firehoseBuffer: number;
  protocolUrl: string;
  /** Operational hygiene (docs/ANTI-ABUSE.md): who to contact, and what this is. */
  notice: string;
  abuseContact: string;
  blockedTopics: Set<string>;
  pow: PowConfig;
}

export const DEFAULTS = {
  maxBytes: 512,
  maxMsgsPerTopic: 1000,
  ttlIdleS: 86_400,
  maxTopicLen: 64,
  maxWaitS: 25,
  firehoseBuffer: 500,
  protocolUrl: "https://github.com/esevastyanov/getbus/blob/main/docs/PROTOCOL.md",
  notice: "",
  abuseContact: "",
  pow: { minDifficulty: 0, maxDifficulty: 20, ratePerBit: 5, windowS: 10, cacheMs: 5_000 },
} as const;

function num(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function str(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw !== "" ? raw : fallback;
}

function list(raw: unknown): Set<string> {
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function configFromEnv(env: Env): Config {
  return {
    version: VERSION,
    maxBytes: num(env.GETBUS_MAX_BYTES, DEFAULTS.maxBytes),
    maxMsgsPerTopic: num(env.GETBUS_MAX_MSGS_PER_TOPIC, DEFAULTS.maxMsgsPerTopic),
    ttlIdleS: num(env.GETBUS_TTL_IDLE_S, DEFAULTS.ttlIdleS),
    maxTopicLen: num(env.GETBUS_MAX_TOPIC_LEN, DEFAULTS.maxTopicLen),
    maxWaitS: num(env.GETBUS_MAX_WAIT_S, DEFAULTS.maxWaitS),
    firehoseBuffer: num(env.GETBUS_FIREHOSE_BUFFER, DEFAULTS.firehoseBuffer),
    protocolUrl: str(env.GETBUS_PROTOCOL_URL, DEFAULTS.protocolUrl),
    notice: str(env.GETBUS_NOTICE, DEFAULTS.notice),
    abuseContact: str(env.GETBUS_ABUSE_CONTACT, DEFAULTS.abuseContact),
    blockedTopics: list(env.GETBUS_BLOCKED_TOPICS),
    pow: {
      minDifficulty: num(env.GETBUS_POW_MIN_DIFFICULTY, DEFAULTS.pow.minDifficulty),
      maxDifficulty: num(env.GETBUS_POW_MAX_DIFFICULTY, DEFAULTS.pow.maxDifficulty),
      ratePerBit: num(env.GETBUS_POW_RATE_PER_BIT, DEFAULTS.pow.ratePerBit),
      windowS: num(env.GETBUS_POW_WINDOW_S, DEFAULTS.pow.windowS),
      cacheMs: num(env.GETBUS_DIFFICULTY_CACHE_MS, DEFAULTS.pow.cacheMs),
    },
  };
}
