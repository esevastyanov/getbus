/**
 * TopicDO — one Durable Object instance per topic name.
 *
 * Holds the append-only log for that topic: monotonic offsets, ring buffer,
 * idle-TTL alarm, and long-poll waiters. It never inspects message content.
 */

import { configFromEnv, type Config, type Env } from "./config";

export interface StoredMessage {
  /** Monotonic offset within the topic. */
  o: number;
  ts: number;
  m: string;
  /** Opaque client signature; stored blindly, never verified (PROTOCOL §6). */
  sig?: string;
}

interface Meta {
  topic: string;
  next: number;
}

interface Waiter {
  from: number;
  resolve: () => void;
}

/** Zero-padded so DO storage's lexicographic key order matches offset order. */
function msgKey(offset: number): string {
  return `m:${offset.toString().padStart(16, "0")}`;
}

export class TopicDO implements DurableObject {
  private topic = "";
  private next = 0;
  private msgs: StoredMessage[] = [];
  private waiters = new Set<Waiter>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // Hydrate before serving anything; cheap on a warm DO, one list() when cold.
    void this.state.blockConcurrencyWhile(async () => {
      const meta = await this.state.storage.get<Meta>("meta");
      if (meta) {
        this.topic = meta.topic;
        this.next = meta.next;
      }
      const stored = await this.state.storage.list<StoredMessage>({ prefix: "m:" });
      this.msgs = [...stored.values()];
    });
  }

  /** Recomputed per request so limits stay configurable per deployment. */
  private get cfg(): Config {
    return configFromEnv(this.env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/append": {
        const body = (await request.json()) as { topic: string; m: string; sig?: string };
        return Response.json(await this.append(body.topic, body.m, body.sig));
      }
      case "/read": {
        const topic = url.searchParams.get("topic") ?? this.topic;
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const wait = Number(url.searchParams.get("wait") ?? 0);
        return Response.json(await this.read(topic, offset, wait));
      }
      default:
        return Response.json({ error: "not_found" }, { status: 404 });
    }
  }

  private async append(topic: string, m: string, sig?: string) {
    this.topic = topic;
    const ts = Date.now();
    const o = this.next++;
    const msg: StoredMessage = sig ? { o, ts, m, sig } : { o, ts, m };
    this.msgs.push(msg);

    // Ring buffer: drop the oldest once we exceed the cap. Bounded memory.
    //
    // Offset 0 is exempt. It is the Genesis Message — the only thing that says
    // what this topic IS (PROTOCOL §6) — so a topic busy enough to wrap would
    // otherwise throw away its own contract and become unjoinable. This is a
    // positional retention rule, exactly like "keep the newest N": the server
    // still never looks inside the message.
    const pinned = this.msgs.length > 0 && this.msgs[0].o === 0 ? 1 : 0;
    const dropped: string[] = [];
    while (this.msgs.length - pinned > this.cfg.maxMsgsPerTopic) {
      dropped.push(msgKey(this.msgs.splice(pinned, 1)[0].o));
    }

    const meta: Meta = { topic, next: this.next };
    await this.state.storage.put({ [msgKey(o)]: msg, meta });
    if (dropped.length > 0) await this.state.storage.delete(dropped);

    // Every write resets the idle timer; the alarm is the whole TTL mechanism.
    await this.state.storage.setAlarm(Date.now() + this.cfg.ttlIdleS * 1000);

    this.wake(o);
    await this.report({ kind: "write", topic, o, ts, m, sig, count: this.msgs.length });

    return { ok: true, topic, offset: o, ts };
  }

  private async read(topic: string, offset: number, wait: number) {
    const from = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;

    if (wait > 0 && !this.hasFrom(from)) {
      await this.waitFor(from, Math.min(wait, this.cfg.maxWaitS) * 1000);
    }

    return {
      topic: this.topic || topic,
      next: this.next,
      messages: this.msgs.filter((msg) => msg.o >= from),
    };
  }

  private hasFrom(from: number): boolean {
    return this.msgs.some((msg) => msg.o >= from);
  }

  private waitFor(from: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter: Waiter = { from, resolve: () => {} };
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve();
      };
      waiter.resolve = finish;
      const timer = setTimeout(finish, ms);
      this.waiters.add(waiter);
    });
  }

  private wake(offset: number): void {
    for (const waiter of [...this.waiters]) {
      if (offset >= waiter.from) waiter.resolve();
    }
  }

  /**
   * Idle TTL expired: the topic ceases to exist. No cron, no sweeper —
   * just this alarm (docs/ARCHITECTURE.md §TopicDO).
   */
  async alarm(): Promise<void> {
    const topic = this.topic;
    await this.state.storage.deleteAll();
    this.msgs = [];
    this.next = 0;
    this.topic = "";
    for (const waiter of [...this.waiters]) waiter.resolve();
    if (topic) await this.report({ kind: "destroy", topic });
  }

  /**
   * Report to the Coordinator (topic index, rate counter, firehose fan-out).
   * A coordinator failure must never fail a write — the log is the product.
   */
  private async report(event: Record<string, unknown>): Promise<void> {
    try {
      const stub = this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName("global"));
      await stub.fetch("https://coordinator/event", {
        method: "POST",
        body: JSON.stringify(event),
      });
    } catch {
      // Blind router: observability is best-effort, the append already happened.
    }
  }
}
