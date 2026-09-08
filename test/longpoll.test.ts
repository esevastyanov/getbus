import { describe, expect, it } from "vitest";
import { poll, publish, uniqueTopic } from "./helpers";

describe("long-poll (M2)", () => {
  it("returns immediately when a message at >= offset already exists", async () => {
    const topic = uniqueTopic("lp.ready");
    await publish(topic, "already here");

    const started = Date.now();
    const { body } = await poll(topic, "&offset=0&wait=20");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(body.messages).toHaveLength(1);
  });

  it("holds the connection until a writer appends, then returns the new message", async () => {
    const topic = uniqueTopic("lp.rendezvous");
    await publish(topic, "GENESIS");

    const waiting = poll(topic, "&offset=1&wait=20");
    // The reader is parked; a second agent shows up and signals.
    const written = await publish(topic, "READY node-7");
    expect(written.status).toBe(200);

    const { body } = await waiting;
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ o: 1, m: "READY node-7" });
    expect(body.next).toBe(2);
  });

  it("times out to an empty response instead of hanging forever", async () => {
    const topic = uniqueTopic("lp.silence");
    const started = Date.now();
    const { status, body } = await poll(topic, "&offset=0&wait=1");
    const elapsed = Date.now() - started;

    expect(status).toBe(200);
    expect(body.messages).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
  });

  it("clamps wait to the advertised maximum", async () => {
    const topic = uniqueTopic("lp.clamp");
    const started = Date.now();
    // wait=9999 must not park for 9999s; the DO clamps to max_wait_s (25).
    const waiting = poll(topic, "&offset=0&wait=9999");
    await publish(topic, "unblock");
    await waiting;
    expect(Date.now() - started).toBeLessThan(25_000);
  });
});
