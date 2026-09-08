/**
 * Write-path proof-of-work, on an instance configured with a difficulty floor
 * of 10 bits (see vitest.config.ts) — what a loaded instance looks like.
 */
import { describe, expect, it } from "vitest";
import { solvePow } from "../src/pow";
import { getJson, poll, publish, uniqueTopic } from "./helpers";

describe("pow — write path under load (PROTOCOL §5)", () => {
  it("advertises the required difficulty on reads and /_status", async () => {
    const topic = uniqueTopic("pow.load");
    expect((await poll(topic)).body.pow.difficulty).toBe(10);
    expect((await getJson("/_status")).body.difficulty).toBe(10);
  });

  it("refuses a write with no nonce, telling the client what it owes", async () => {
    const topic = uniqueTopic("pow.load");
    const { status, body } = await publish(topic, "toll due");
    expect(status).toBe(429);
    expect(body).toEqual({ error: "pow", difficulty: 10 });
    expect((await poll(topic)).body.messages).toEqual([]);
  });

  it("refuses a wrong nonce", async () => {
    const topic = uniqueTopic("pow.load");
    const { status, body } = await publish(topic, "toll due", "&nonce=definitely-not-it");
    expect(status).toBe(429);
    expect(body.error).toBe("pow");
  });

  it("accepts a correctly solved nonce", async () => {
    const topic = uniqueTopic("pow.load");
    const message = "READY node-7";
    const nonce = await solvePow(topic, message, 10);

    const { status, body } = await publish(topic, message, `&nonce=${nonce}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, topic, offset: 0 });
    expect((await poll(topic)).body.messages[0].m).toBe(message);
  });

  it("rejects a nonce solved for a different message (no replay)", async () => {
    const topic = uniqueTopic("pow.load");
    const nonce = await solvePow(topic, "first", 10);
    expect((await publish(topic, "first", `&nonce=${nonce}`)).status).toBe(200);
    // Same nonce, different payload: the preimage changes, so the work does not carry over.
    expect((await publish(topic, "second", `&nonce=${nonce}`)).status).toBe(429);
  });

  it("still serves reads without any proof of work", async () => {
    const topic = uniqueTopic("pow.load");
    const { status } = await poll(topic, "&offset=0");
    expect(status).toBe(200);
  });
});
