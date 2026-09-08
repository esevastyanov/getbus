import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AGENT, getJson, poll, publish, uniqueTopic } from "./helpers";

describe("publish + read (M0)", () => {
  it("creates a topic on first write and assigns monotonic offsets", async () => {
    const topic = uniqueTopic();

    const first = await publish(topic, "GENESIS");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, topic, offset: 0 });
    expect(typeof first.body.ts).toBe("number");

    const second = await publish(topic, "READY node-7");
    expect(second.body.offset).toBe(1);
    expect(second.body.ts).toBeGreaterThanOrEqual(first.body.ts);
  });

  it("returns the full log with a cursor, and messages verbatim", async () => {
    const topic = uniqueTopic();
    await publish(topic, "one");
    await publish(topic, "two ✓ with spaces & symbols");

    const { status, body } = await poll(topic);
    expect(status).toBe(200);
    expect(body.topic).toBe(topic);
    expect(body.next).toBe(2);
    expect(body.messages.map((m: any) => m.m)).toEqual(["one", "two ✓ with spaces & symbols"]);
    expect(body.messages[0]).toMatchObject({ o: 0 });
    expect(body.pow).toEqual({ difficulty: 0 });
  });

  it("honours offset semantics: >= N, and empty past the head", async () => {
    const topic = uniqueTopic();
    await publish(topic, "a");
    await publish(topic, "b");
    await publish(topic, "c");

    const from1 = await poll(topic, "&offset=1");
    expect(from1.body.messages.map((m: any) => m.o)).toEqual([1, 2]);
    expect(from1.body.next).toBe(3);

    const atHead = await poll(topic, "&offset=3");
    expect(atHead.body.messages).toEqual([]);
    expect(atHead.body.next).toBe(3);

    const pastHead = await poll(topic, "&offset=99");
    expect(pastHead.body.messages).toEqual([]);
    expect(pastHead.body.next).toBe(3);
  });

  it("reads an unknown topic as empty rather than 404 (readers may arrive first)", async () => {
    const { status, body } = await poll(uniqueTopic("never-written"));
    expect(status).toBe(200);
    expect(body).toMatchObject({ next: 0, messages: [] });
  });

  it("stores `sig` blindly and returns it, without verifying anything", async () => {
    const topic = uniqueTopic();
    await publish(topic, "signed", "&sig=ed25519:not-a-real-signature");

    const { body } = await poll(topic);
    expect(body.messages[0].sig).toBe("ed25519:not-a-real-signature");
  });

  it("trims the ring buffer to max_msgs_per_topic, dropping the oldest", async () => {
    const topic = uniqueTopic();
    for (let i = 0; i < 8; i++) await publish(topic, `msg-${i}`);

    const { body } = await poll(topic);
    // Test env caps the topic at 5 messages, plus the pinned Genesis at offset 0
    // (see test/genesis.test.ts). Offsets stay monotonic, but the retained set
    // may have a gap between Genesis and the newest window.
    expect(body.messages.map((m: any) => m.o)).toEqual([0, 3, 4, 5, 6, 7]);
    expect(body.next).toBe(8);
  });

  it("rejects messages over max_bytes with 413, counting decoded bytes", async () => {
    const topic = uniqueTopic();

    const ok = await publish(topic, "x".repeat(512));
    expect(ok.status).toBe(200);

    const tooBig = await publish(topic, "x".repeat(513));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toMatchObject({ error: "too_large", max_bytes: 512 });

    // Multi-byte characters count as bytes, not code points.
    const multibyte = await publish(topic, "✓".repeat(171)); // 513 bytes
    expect(multibyte.status).toBe(413);
  });
});

describe("parameter validation", () => {
  it("rejects malformed topic names with 400", async () => {
    for (const bad of ["", "has space", "sla/sh", "emoji✓", "x".repeat(65)]) {
      const { status, body } = await publish(bad, "hi");
      expect(status, `topic ${JSON.stringify(bad)}`).toBe(400);
      expect(body.error).toBe("bad_topic");
    }
    expect((await publish("x".repeat(64), "hi")).status).toBe(200);
  });

  it("rejects a missing topic, bad offset and bad wait with 400", async () => {
    expect((await getJson("/")).body.error).toBe("bad_topic");
    expect((await poll(uniqueTopic(), "&offset=-1")).body.error).toBe("bad_offset");
    expect((await poll(uniqueTopic(), "&offset=1.5")).body.error).toBe("bad_offset");
    expect((await poll(uniqueTopic(), "&offset=abc")).body.error).toBe("bad_offset");
    expect((await poll(uniqueTopic(), "&wait=-1")).body.error).toBe("bad_wait");
  });

  it("is GET-only and never returns HTML", async () => {
    const res = await SELF.fetch("https://getbus.test/?t=x&m=y", {
      method: "POST",
      headers: AGENT,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("content-type")).toContain("application/json");

    const missing = await getJson("/nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
  });

  it("never emits CORS headers", async () => {
    const topic = uniqueTopic();
    await publish(topic, "hi");
    for (const path of ["/", "/_status", "/_topics"]) {
      const res = await SELF.fetch(`https://getbus.test${path}?t=${topic}`, { headers: AGENT });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});
