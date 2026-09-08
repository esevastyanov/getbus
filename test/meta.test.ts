import { describe, expect, it } from "vitest";
import { getJson, get, publish, uniqueTopic } from "./helpers";

describe("/_status", () => {
  it("advertises the instance's limits and current difficulty", async () => {
    const { status, body } = await getJson("/_status");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      version: "0.1",
      difficulty: 0,
      max_bytes: 512,
      max_msgs_per_topic: 5, // test override; 1000 in production defaults
      ttl_idle_s: 60,
    });
    expect(typeof body.protocol).toBe("string");
    // Omitted unless the operator sets them (see test/operator.test.ts).
    expect(body.notice).toBeUndefined();
    expect(body.abuse_contact).toBeUndefined();
  });
});

describe("/_topics", () => {
  it("lists live topics with counts and age, newest first", async () => {
    const topic = uniqueTopic("discoverable");
    await publish(topic, "one");
    await publish(topic, "two");

    const { status, body } = await getJson("/_topics");
    expect(status).toBe(200);
    const entry = body.find((e: any) => e.t === topic);
    expect(entry).toBeDefined();
    expect(entry.count).toBe(2);
    expect(entry.age_s).toBeGreaterThanOrEqual(0);
    expect(typeof entry.last_ts).toBe("number");
  });
});

describe("/_firehose", () => {
  it("serves every message across all topics as JSON when polled", async () => {
    const before = await getJson("/_firehose?poll=1");
    const cursor = before.body.seq;

    const a = uniqueTopic("fire.a");
    const b = uniqueTopic("fire.b");
    await publish(a, "from A");
    await publish(b, "from B");

    const { status, body } = await getJson(`/_firehose?poll=1&since=${cursor}`);
    expect(status).toBe(200);
    const seen = body.events.map((e: any) => [e.t, e.m]);
    expect(seen).toContainEqual([a, "from A"]);
    expect(seen).toContainEqual([b, "from B"]);
    expect(body.seq).toBeGreaterThan(cursor);
  });

  it("streams Server-Sent Events", async () => {
    const res = await get("/_firehose");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("getbus firehose");
    await reader.cancel();
  });
});
