/**
 * CoordinatorDO — a single global Durable Object ("global").
 *
 * Three jobs, deliberately in one DO so a write costs exactly one cross-DO hop:
 *   1. Adaptive PoW difficulty controller (PROTOCOL §5).
 *   2. The `/_topics` index.
 *   3. Firehose fan-out (SSE + JSON polling fallback).
 *
 * Like everything else here it is content-blind: it copies message bytes to
 * subscribers and counts them, nothing more.
 */

import { configFromEnv, type Config, type Env } from "./config";

export interface TopicEntry {
  count: number;
  last_ts: number;
  created_ts: number;
}

export interface FirehoseEvent {
  seq: number;
  t: string;
  o: number;
  ts: number;
  m: string;
  sig?: string;
}

type CoordinatorEvent =
  | { kind: "write"; topic: string; o: number; ts: number; m: string; sig?: string; count: number }
  | { kind: "destroy"; topic: string };

const HEARTBEAT_MS = 15_000;
const encoder = new TextEncoder();

export class CoordinatorDO implements DurableObject {
  private topics = new Map<string, TopicEntry>();
  /** epoch-second -> writes in that second; pruned to the rate window. */
  private buckets = new Map<number, number>();
  private firehose: FirehoseEvent[] = [];
  private seq = 0;
  private subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.list<TopicEntry>({ prefix: "t:" });
      for (const [key, entry] of stored) this.topics.set(key.slice(2), entry);
    });
  }

  /** Recomputed per request so limits stay configurable per deployment. */
  private get cfg(): Config {
    return configFromEnv(this.env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/event":
        return Response.json(await this.onEvent((await request.json()) as CoordinatorEvent));
      case "/difficulty":
        return Response.json({ difficulty: this.difficulty(), rate: this.rate() });
      case "/topics":
        return Response.json(await this.listTopics());
      case "/firehose":
        return url.searchParams.get("poll") !== null
          ? this.pollFirehose(url)
          : this.streamFirehose(request);
      default:
        return Response.json({ error: "not_found" }, { status: 404 });
    }
  }

  // --- difficulty controller ------------------------------------------------

  /**
   * Sustained write rate over the last `windowS` seconds, in writes/sec.
   */
  private rate(): number {
    this.prune();
    let total = 0;
    for (const count of this.buckets.values()) total += count;
    return total / this.cfg.pow.windowS;
  }

  /**
   * The curve, kept deliberately simple and documented (ARCHITECTURE §Coordinator):
   * one extra bit of difficulty per `ratePerBit` sustained writes/sec, held between
   * `minDifficulty` and `maxDifficulty`. A quiet instance with the default floor of
   * 0 advertises 0 => no nonce needed.
   */
  private difficulty(): number {
    const { minDifficulty, maxDifficulty, ratePerBit } = this.cfg.pow;
    const bits = Math.floor(this.rate() / ratePerBit);
    return Math.min(Math.max(minDifficulty, bits), maxDifficulty);
  }

  private prune(): void {
    const oldest = Math.floor(Date.now() / 1000) - this.cfg.pow.windowS;
    for (const second of this.buckets.keys()) {
      if (second <= oldest) this.buckets.delete(second);
    }
  }

  // --- events ---------------------------------------------------------------

  private async onEvent(event: CoordinatorEvent): Promise<{ difficulty: number }> {
    if (event.kind === "destroy") {
      this.topics.delete(event.topic);
      await this.state.storage.delete(`t:${event.topic}`);
      return { difficulty: this.difficulty() };
    }

    const second = Math.floor(Date.now() / 1000);
    this.buckets.set(second, (this.buckets.get(second) ?? 0) + 1);
    this.prune();

    const existing = this.topics.get(event.topic);
    const entry: TopicEntry = {
      count: event.count,
      last_ts: event.ts,
      created_ts: existing?.created_ts ?? event.ts,
    };
    this.topics.set(event.topic, entry);
    await this.state.storage.put(`t:${event.topic}`, entry);

    this.publish({
      seq: ++this.seq,
      t: event.topic,
      o: event.o,
      ts: event.ts,
      m: event.m,
      ...(event.sig ? { sig: event.sig } : {}),
    });

    return { difficulty: this.difficulty() };
  }

  private async listTopics() {
    const now = Date.now();
    const ttlMs = this.cfg.ttlIdleS * 1000;
    const out: Array<{ t: string; count: number; last_ts: number; age_s: number }> = [];
    const stale: string[] = [];

    for (const [topic, entry] of this.topics) {
      // A TopicDO whose destroy report never landed would otherwise linger here.
      if (now - entry.last_ts > ttlMs) {
        stale.push(topic);
        continue;
      }
      out.push({
        t: topic,
        count: entry.count,
        last_ts: entry.last_ts,
        age_s: Math.floor((now - entry.last_ts) / 1000),
      });
    }

    for (const topic of stale) {
      this.topics.delete(topic);
      await this.state.storage.delete(`t:${topic}`);
    }

    out.sort((a, b) => b.last_ts - a.last_ts);
    return out;
  }

  // --- firehose -------------------------------------------------------------

  private publish(event: FirehoseEvent): void {
    this.firehose.push(event);
    if (this.firehose.length > this.cfg.firehoseBuffer) {
      this.firehose.splice(0, this.firehose.length - this.cfg.firehoseBuffer);
    }
    const frame = encoder.encode(
      `id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
    );
    this.broadcast(frame);
  }

  private broadcast(frame: Uint8Array): void {
    for (const writer of [...this.subscribers]) {
      writer.write(frame).catch(() => this.drop(writer));
    }
  }

  private drop(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.subscribers.delete(writer);
    writer.close().catch(() => {});
    if (this.subscribers.size === 0 && this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private streamFirehose(request: Request): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.subscribers.add(writer);

    const since = Number(new URL(request.url).searchParams.get("since") ?? NaN);
    const backlog = Number.isFinite(since)
      ? this.firehose.filter((event) => event.seq > since)
      : [];

    let preamble = ": getbus firehose — every message on this instance, in the open\n\n";
    for (const event of backlog) {
      preamble += `id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
    }
    writer.write(encoder.encode(preamble)).catch(() => this.drop(writer));

    if (this.heartbeat === null) {
      this.heartbeat = setInterval(() => this.broadcast(encoder.encode(": ping\n\n")), HEARTBEAT_MS);
    }
    request.signal?.addEventListener("abort", () => this.drop(writer));

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  /** Polling fallback for clients that cannot hold an SSE connection. */
  private pollFirehose(url: URL): Response {
    const since = Number(url.searchParams.get("since") ?? 0);
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    const events = this.firehose.filter((event) => event.seq > from);
    return Response.json({ seq: this.seq, events });
  }
}
