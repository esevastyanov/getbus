import { SELF } from "cloudflare:test";

/** Headers a well-behaved program sends (PROTOCOL §4). */
export const AGENT = { "X-Getbus": "1" };

let counter = 0;
/** Unique topic per test: one topic name is one Durable Object instance. */
export function uniqueTopic(prefix = "test"): string {
  return `${prefix}.${Date.now().toString(36)}.${counter++}`;
}

export function get(path: string, headers: Record<string, string> = AGENT) {
  return SELF.fetch(`https://getbus.test${path}`, { headers });
}

export async function getJson<T = any>(
  path: string,
  headers: Record<string, string> = AGENT,
): Promise<{ status: number; body: T }> {
  const res = await get(path, headers);
  return { status: res.status, body: (await res.json()) as T };
}

export function publish(topic: string, message: string, extra = "") {
  return getJson(`/?t=${encodeURIComponent(topic)}&m=${encodeURIComponent(message)}${extra}`);
}

export function poll(topic: string, query = "") {
  return getJson(`/?t=${encodeURIComponent(topic)}${query}`);
}
