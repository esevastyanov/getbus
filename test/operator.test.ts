/**
 * The operator levers from docs/ANTI-ABUSE.md, on an instance configured with a
 * null-routed topic and a published notice (see vitest.config.ts).
 */
import { describe, expect, it } from "vitest";
import { getJson, poll, publish, uniqueTopic } from "./helpers";

describe("null-routed topics", () => {
  it("refuses writes to a blocked topic with 403", async () => {
    const { status, body } = await publish("spam.topic", "hello");
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: "blocked", topic: "spam.topic" });
  });

  it("refuses reads too, so the name is fully dark", async () => {
    const { status, body } = await poll("spam.topic");
    expect(status).toBe(403);
    expect(body.error).toBe("blocked");
  });

  it("parses a comma-separated list with stray whitespace", async () => {
    expect((await publish("another.blocked", "hi")).status).toBe(403);
  });

  it("leaves every other topic open — the lever is per-name, not a mode", async () => {
    const topic = uniqueTopic("open");
    expect((await publish(topic, "still fine")).status).toBe(200);
  });
});

describe("instance notice", () => {
  it("publishes what this is and who to complain to on /_status", async () => {
    const { body } = await getJson("/_status");
    expect(body.notice).toBe("experimental research instance");
    expect(body.abuse_contact).toBe("abuse@getbus.example");
  });
});
