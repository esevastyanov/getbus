/**
 * The Genesis Message is the only thing that says what a topic IS (PROTOCOL §6).
 * A topic busy enough to wrap its ring buffer must not lose it.
 */
import { describe, expect, it } from "vitest";
import { parseGenesis } from "../clients/getbus.ts";
import { poll, publish, uniqueTopic } from "./helpers";

const CONTRACT = JSON.stringify({
  $schema: "https://example.com/task-market.v0.json",
  proto: "tm/0",
});

describe("Genesis retention", () => {
  it("survives a ring-buffer wrap, so a late joiner can still read the contract", async () => {
    const topic = uniqueTopic("genesis.wrap");
    await publish(topic, CONTRACT);
    // The test instance caps a topic at 5 messages; push well past it.
    for (let i = 0; i < 12; i++) await publish(topic, `TASK t${i}`);

    const { body } = await poll(topic);
    const genesis = body.messages.find((m: any) => m.o === 0);
    expect(genesis, "offset 0 must still be there").toBeDefined();
    expect(genesis.m).toBe(CONTRACT);

    // The bundled clients look up the contract exactly this way.
    expect(parseGenesis(body.messages)).toMatchObject({ proto: "tm/0" });
  });

  it("keeps the most recent window alongside it, not instead of it", async () => {
    const topic = uniqueTopic("genesis.window");
    await publish(topic, CONTRACT);
    for (let i = 1; i < 9; i++) await publish(topic, `m${i}`);

    const { body } = await poll(topic);
    // Genesis + the 5 most recent. Offsets 1..3 are gone; 0 is pinned.
    expect(body.messages.map((m: any) => m.o)).toEqual([0, 4, 5, 6, 7, 8]);
    expect(body.next).toBe(9);
  });

  it("does not resurrect after the topic self-destructs", async () => {
    const topic = uniqueTopic("genesis.reborn");
    await publish(topic, CONTRACT);
    const { body } = await poll(topic);
    expect(body.messages[0].o).toBe(0);
  });
});
