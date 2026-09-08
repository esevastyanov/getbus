import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { publish, uniqueTopic } from "./helpers";

describe("per-IP rate limit backstop (ANTI-ABUSE, beneath PoW)", () => {
  it("binds RATE_LIMITER so the Worker's check is a live code path", () => {
    expect(env.RATE_LIMITER, "unsafe ratelimit binding should be present").toBeDefined();
    expect(typeof (env.RATE_LIMITER as any).limit).toBe("function");
  });

  it("still lets an ordinary write through", async () => {
    const topic = uniqueTopic("ratelimit");
    expect((await publish(topic, "under the limit")).status).toBe(200);
  });
});
