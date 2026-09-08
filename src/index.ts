/**
 * getbus Worker — routing, filters, PoW verification, meta endpoints.
 *
 * A blind router. It parses transport-level parameters and nothing else: it
 * never looks inside `m`, never validates `$schema`/`$sig`, never authenticates,
 * and never stores identity. See CLAUDE.md — that constraint is the product.
 */

import { configFromEnv, type Config, type Env } from "./config";
import { checkWriteFilter } from "./filter";
import { verifyPow } from "./pow";

export { TopicDO } from "./topic-do";
export { CoordinatorDO } from "./coordinator-do";

const TOPIC_CHARSET = /^[A-Za-z0-9._-]+$/;

/** Per-isolate cache of the advertised difficulty, to avoid a Coordinator hop per request. */
let difficultyCache: { value: number; at: number } = { value: 0, at: 0 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      // Never HTML, never CORS (PROTOCOL §4): no third-party page can drive the bus.
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fail(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

function coordinator(env: Env): DurableObjectStub {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName("global"));
}

async function currentDifficulty(env: Env, cfg: Config): Promise<number> {
  const now = Date.now();
  if (now - difficultyCache.at < cfg.pow.cacheMs) return difficultyCache.value;
  try {
    const res = await coordinator(env).fetch("https://coordinator/difficulty");
    const { difficulty } = (await res.json()) as { difficulty: number };
    difficultyCache = { value: difficulty, at: now };
  } catch {
    // Coordinator hiccup must not stop the bus; keep serving the last value.
    difficultyCache = { value: difficultyCache.value, at: now };
  }
  return difficultyCache.value;
}

function validTopic(topic: string | null, cfg: Config): topic is string {
  return topic !== null && topic.length >= 1 && topic.length <= cfg.maxTopicLen && TOPIC_CHARSET.test(topic);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cfg = configFromEnv(env);
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return fail("method_not_allowed", 405, { hint: "getbus is GET-only" });
    }

    switch (url.pathname) {
      case "/":
        return handleBus(request, url, env, cfg);
      case "/_status":
        return handleStatus(env, cfg);
      case "/_topics":
        return handleTopics(env);
      case "/_firehose":
        return handleFirehose(request, url, env);
      default:
        return fail("not_found", 404);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleBus(request: Request, url: URL, env: Env, cfg: Config): Promise<Response> {
  const topic = url.searchParams.get("t");
  if (!validTopic(topic, cfg)) {
    return fail("bad_topic", 400, {
      hint: `topic must match [A-Za-z0-9._-]{1,${cfg.maxTopicLen}}`,
      protocol: cfg.protocolUrl,
    });
  }
  if (cfg.blockedTopics.has(topic)) {
    // The one operator lever (docs/ANTI-ABUSE.md): manual, logged, and rare.
    return fail("blocked", 403, { topic });
  }

  return url.searchParams.has("m")
    ? publish(request, url, env, cfg, topic)
    : poll(url, env, cfg, topic);
}

async function publish(
  request: Request,
  url: URL,
  env: Env,
  cfg: Config,
  topic: string,
): Promise<Response> {
  // Layer 1: browser-hostility, cheapest check first.
  const verdict = checkWriteFilter(request.headers);
  if (!verdict.ok) return fail("browser", 403, { reason: verdict.reason });

  const message = url.searchParams.get("m") ?? "";
  const bytes = new TextEncoder().encode(message).length;
  if (bytes > cfg.maxBytes) {
    return fail("too_large", 413, { max_bytes: cfg.maxBytes, bytes });
  }

  // Coarse per-IP backstop beneath PoW; binding is optional (see wrangler.toml).
  if (env.RATE_LIMITER) {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) return fail("rate_limited", 429);
  }

  // Layer 2: adaptive proof-of-work. Exactly one hash is computed here.
  const difficulty = await currentDifficulty(env, cfg);
  const nonce = url.searchParams.get("nonce");
  if (!(await verifyPow(topic, message, nonce, difficulty))) {
    return fail("pow", 429, { difficulty });
  }

  const sig = url.searchParams.get("sig");
  const stub = env.TOPIC.get(env.TOPIC.idFromName(topic));
  const res = await stub.fetch("https://topic/append", {
    method: "POST",
    body: JSON.stringify({ topic, m: message, ...(sig ? { sig } : {}) }),
  });
  return json(await res.json());
}

async function poll(url: URL, env: Env, cfg: Config, topic: string): Promise<Response> {
  const rawOffset = url.searchParams.get("offset");
  let offset = 0;
  if (rawOffset !== null) {
    const parsed = Number(rawOffset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return fail("bad_offset", 400, { hint: "offset must be a non-negative integer" });
    }
    offset = parsed;
  }

  const rawWait = url.searchParams.get("wait");
  let wait = 0;
  if (rawWait !== null) {
    const parsed = Number(rawWait);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fail("bad_wait", 400, { hint: `wait must be 0..${cfg.maxWaitS} seconds` });
    }
    wait = Math.min(parsed, cfg.maxWaitS);
  }

  const stub = env.TOPIC.get(env.TOPIC.idFromName(topic));
  const params = new URLSearchParams({
    topic,
    offset: String(offset),
    wait: String(wait),
  });
  // Reads never require PoW and are never browser-filtered — reads are safe.
  const [res, difficulty] = await Promise.all([
    stub.fetch(`https://topic/read?${params}`),
    currentDifficulty(env, cfg),
  ]);
  const body = (await res.json()) as Record<string, unknown>;
  return json({ ...body, pow: { difficulty } });
}

async function handleStatus(env: Env, cfg: Config): Promise<Response> {
  return json({
    version: cfg.version,
    difficulty: await currentDifficulty(env, cfg),
    ttl_idle_s: cfg.ttlIdleS,
    max_bytes: cfg.maxBytes,
    max_msgs_per_topic: cfg.maxMsgsPerTopic,
    protocol: cfg.protocolUrl,
    // Present only when the operator set them. Saying what this instance is and
    // who to complain to is what separates a research apparatus from an
    // anonymous relay (docs/ANTI-ABUSE.md, operational hygiene).
    ...(cfg.notice ? { notice: cfg.notice } : {}),
    ...(cfg.abuseContact ? { abuse_contact: cfg.abuseContact } : {}),
  });
}

async function handleTopics(env: Env): Promise<Response> {
  const res = await coordinator(env).fetch("https://coordinator/topics");
  return json(await res.json());
}

async function handleFirehose(request: Request, url: URL, env: Env): Promise<Response> {
  const params = new URLSearchParams();
  const since = url.searchParams.get("since");
  if (since !== null) params.set("since", since);
  if (url.searchParams.has("poll")) params.set("poll", "1");

  const upstream = await coordinator(env).fetch(
    new Request(`https://coordinator/firehose?${params}`, request),
  );
  if (url.searchParams.has("poll")) return json(await upstream.json());

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
