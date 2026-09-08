/**
 * getbus — tiny TypeScript client.
 *
 * Wire an agent to a bus in a few lines:
 *
 *   const bus = new Getbus("https://getbus.example");
 *   await bus.publish("swarm.build", "READY node-7");
 *   for await (const msg of bus.subscribe("swarm.build")) console.log(msg.m);
 *
 * PoW is shared with the server (`src/pow.ts`) so both sides compute the same
 * hash. Everything else — schemas, signatures, meaning — is the client's job;
 * the server understands none of it.
 */

import { solvePow } from "../src/pow.ts";

export interface Message {
  o: number;
  ts: number;
  m: string;
  sig?: string;
}

export interface ReadResult {
  topic: string;
  next: number;
  messages: Message[];
  pow: { difficulty: number };
}

export interface PublishResult {
  ok: true;
  topic: string;
  offset: number;
  ts: number;
}

export interface Status {
  version: string;
  difficulty: number;
  ttl_idle_s: number;
  max_bytes: number;
  max_msgs_per_topic: number;
  protocol: string;
}

export interface TopicInfo {
  t: string;
  count: number;
  last_ts: number;
  age_s: number;
}

export interface FirehoseEvent {
  seq: number;
  t: string;
  o: number;
  ts: number;
  m: string;
  sig?: string;
}

export class GetbusError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;

  constructor(status: number, code: string, body: Record<string, unknown>) {
    super(`getbus: ${code} (HTTP ${status})`);
    this.name = "GetbusError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface GetbusOptions {
  /** Injected for tests or non-standard runtimes. */
  fetch?: typeof fetch;
  /** How many times to re-solve PoW when the difficulty moves under us. */
  powRetries?: number;
}

const USER_AGENT = "getbus.ts/0.1 (+https://github.com/esevastyanov/getbus)";

/**
 * Headers that mark us as a program, not a browser (PROTOCOL §4).
 *
 * The User-Agent matters on instances behind an edge that filters default
 * library agents. Browsers drop this header per the Fetch spec, which is fine:
 * a browser cannot write to the bus anyway.
 */
const AGENT_HEADERS = {
  "X-Getbus": "1",
  Accept: "application/json",
  "User-Agent": USER_AGENT,
};

export class Getbus {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly powRetries: number;

  constructor(base: string, options: GetbusOptions = {}) {
    this.base = base.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.powRetries = options.powRetries ?? 3;
  }

  // --- meta -----------------------------------------------------------------

  status(): Promise<Status> {
    return this.json<Status>("/_status");
  }

  topics(): Promise<TopicInfo[]> {
    return this.json<TopicInfo[]>("/_topics");
  }

  // --- write ----------------------------------------------------------------

  /**
   * Publish one signal. Solves proof-of-work transparently: writes go out with
   * no nonce while the instance is quiet, and pay the toll when it is not.
   */
  async publish(
    topic: string,
    message: string,
    options: { sig?: string; difficulty?: number } = {},
  ): Promise<PublishResult> {
    let difficulty = options.difficulty ?? 0;

    for (let attempt = 0; attempt <= this.powRetries; attempt++) {
      const params = new URLSearchParams({ t: topic, m: message });
      if (options.sig) params.set("sig", options.sig);
      if (difficulty > 0) {
        const nonce = await solvePow(topic, message, difficulty);
        if (nonce !== null) params.set("nonce", nonce);
      }

      const res = await this.fetch(`${this.base}/?${params}`, { headers: AGENT_HEADERS });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.ok) return body as unknown as PublishResult;

      // The instance got busier between our read and our write: pay up and retry.
      if (res.status === 429 && body.error === "pow") {
        difficulty = Number(body.difficulty) || difficulty + 1;
        continue;
      }
      throw new GetbusError(res.status, String(body.error ?? "unknown"), body);
    }

    throw new Error(`getbus: gave up solving proof-of-work for ${topic}`);
  }

  // --- read -----------------------------------------------------------------

  poll(topic: string, options: { offset?: number; wait?: number } = {}): Promise<ReadResult> {
    const params = new URLSearchParams({ t: topic });
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    if (options.wait !== undefined) params.set("wait", String(options.wait));
    return this.json<ReadResult>(`/?${params}`);
  }

  /**
   * Long-poll a topic forever, yielding each message once. Cursor handling and
   * back-off are the client's business, as with everything else.
   */
  async *subscribe(
    topic: string,
    options: { offset?: number; wait?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<Message> {
    let cursor = options.offset ?? 0;
    const wait = options.wait ?? 25;

    while (!options.signal?.aborted) {
      const result = await this.poll(topic, { offset: cursor, wait });
      for (const message of result.messages) yield message;
      // A destroyed topic restarts at 0; follow it back rather than stalling.
      cursor = result.next < cursor ? result.next : Math.max(cursor, result.next);
    }
  }

  /** Every message on the instance, in the open (PROTOCOL §3). */
  async *firehose(options: { since?: number; signal?: AbortSignal } = {}): AsyncGenerator<FirehoseEvent> {
    const params = new URLSearchParams();
    if (options.since !== undefined) params.set("since", String(options.since));

    const res = await this.fetch(`${this.base}/_firehose?${params}`, {
      headers: { "X-Getbus": "1", Accept: "text/event-stream", "User-Agent": USER_AGENT },
      signal: options.signal,
    });
    if (!res.ok || res.body === null) throw new GetbusError(res.status, "firehose", {});

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as FirehoseEvent;
        }
      }
    }
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.fetch(`${this.base}${path}`, { headers: AGENT_HEADERS });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new GetbusError(res.status, String(body.error ?? "unknown"), body);
    return body as T;
  }
}

// --- Genesis contracts & client-side signatures (PROTOCOL §6) ---------------
//
// The server stores `$schema`/`$sig` and `sig` as opaque bytes and enforces
// nothing. All of the following runs on the client, by convention.

export interface GenesisContract {
  $schema?: string;
  /** "ed25519:<base64 public key>" — the only writer this topic trusts. */
  $sig?: string;
}

/** Parse a topic's first message as a Genesis contract, or null if it isn't one. */
export function parseGenesis(messages: Message[]): GenesisContract | null {
  const first = messages.find((message) => message.o === 0);
  if (!first) return null;
  try {
    const parsed = JSON.parse(first.m) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const contract = parsed as GenesisContract;
    return contract.$schema || contract.$sig ? contract : null;
  } catch {
    return null;
  }
}

/** Reference convention: sign `topic + "\n" + message`, so signatures don't replay across topics. */
export function signingPreimage(topic: string, message: string): string {
  return `${topic}\n${message}`;
}

const b64 = {
  encode: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
  decode: (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
};

export async function generateSigner(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicKey: `ed25519:${b64.encode(raw)}`, privateKey: pair.privateKey };
}

export async function signMessage(
  privateKey: CryptoKey,
  topic: string,
  message: string,
): Promise<string> {
  const data = new TextEncoder().encode(signingPreimage(topic, message));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, data));
  return b64.encode(signature);
}

export async function verifyMessage(
  publicKey: string,
  topic: string,
  message: string,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature || !publicKey.startsWith("ed25519:")) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64.decode(publicKey.slice("ed25519:".length)),
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      b64.decode(signature),
      new TextEncoder().encode(signingPreimage(topic, message)),
    );
  } catch {
    return false;
  }
}

/**
 * Drop every message that does not verify against the topic's Genesis `$sig`.
 * This is the whole of "Layer 4": opt-in write integrity with no server accounts.
 * A topic with no `$sig` contract is returned untouched — the open default.
 */
export async function verifiedMessages(topic: string, messages: Message[]): Promise<Message[]> {
  const contract = parseGenesis(messages);
  if (!contract?.$sig) return messages;

  const kept: Message[] = [];
  for (const message of messages) {
    // The Genesis message declares the key; it is trusted by definition.
    if (message.o === 0) {
      kept.push(message);
      continue;
    }
    if (await verifyMessage(contract.$sig, topic, message.m, message.sig)) kept.push(message);
  }
  return kept;
}
