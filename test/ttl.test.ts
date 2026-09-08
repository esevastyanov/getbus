import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { poll, publish, uniqueTopic } from "./helpers";

function topicStub(topic: string) {
  return env.TOPIC.get(env.TOPIC.idFromName(topic));
}

describe("idle TTL (M0)", () => {
  it("arms an alarm on write and self-destructs when it fires", async () => {
    const topic = uniqueTopic("ephemeral");
    await publish(topic, "GENESIS");
    await publish(topic, "READY");
    expect((await poll(topic)).body.messages).toHaveLength(2);

    // The alarm is the whole TTL mechanism — no cron, no sweeper.
    const fired = await runDurableObjectAlarm(topicStub(topic));
    expect(fired).toBe(true);

    const after = await poll(topic);
    expect(after.body.messages).toEqual([]);
    expect(after.body.next).toBe(0);
  });

  it("resets the idle timer on every write, so an active topic survives", async () => {
    const topic = uniqueTopic("active");
    await publish(topic, "first");
    await publish(topic, "second");

    // Re-arming means the pending alarm is always in the future; forcing it here
    // proves the topic is gone only once it actually fires.
    expect((await poll(topic)).body.messages).toHaveLength(2);
    await runDurableObjectAlarm(topicStub(topic));
    expect((await poll(topic)).body.messages).toHaveLength(0);

    // A destroyed topic is re-creatable and starts fresh at offset 0.
    const reborn = await publish(topic, "new genesis");
    expect(reborn.body.offset).toBe(0);
  });

  it("drops the topic from the index when it self-destructs", async () => {
    const topic = uniqueTopic("indexed");
    await publish(topic, "hello");
    const before = (await (await env.COORDINATOR
      .get(env.COORDINATOR.idFromName("global"))
      .fetch("https://coordinator/topics")).json()) as Array<{ t: string }>;
    expect(before.some((entry) => entry.t === topic)).toBe(true);

    await runDurableObjectAlarm(topicStub(topic));

    const after = (await (await env.COORDINATOR
      .get(env.COORDINATOR.idFromName("global"))
      .fetch("https://coordinator/topics")).json()) as Array<{ t: string }>;
    expect(after.some((entry) => entry.t === topic)).toBe(false);
  });
});
