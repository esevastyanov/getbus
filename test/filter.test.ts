import { describe, expect, it } from "vitest";
import { checkWriteFilter, hasProgramHeader, isBrowserLike } from "../src/filter";
import { AGENT, getJson, poll, publish, uniqueTopic } from "./helpers";

const headers = (h: Record<string, string>) => new Headers(h);

describe("browser-hostility filter — unit (PROTOCOL §4)", () => {
  it("flags each browser signal", () => {
    expect(isBrowserLike(headers({ "Sec-Fetch-Mode": "navigate" }))).toContain("navigate");
    expect(isBrowserLike(headers({ Accept: "text/html,application/xhtml+xml" }))).toContain("text/html");
    expect(isBrowserLike(headers({ Cookie: "a=b" }))).toContain("cookie");
    expect(isBrowserLike(headers({ Referer: "https://example.com/" }))).toContain("referer");
    expect(isBrowserLike(headers({ "X-Getbus": "1" }))).toBeNull();
  });

  it("requires an explicit program header", () => {
    expect(hasProgramHeader(headers({ "X-Getbus": "1" }))).toBe(true);
    expect(hasProgramHeader(headers({ Accept: "application/json" }))).toBe(true);
    expect(hasProgramHeader(headers({ "User-Agent": "curl/8" }))).toBe(false);
  });

  it("passes only program-shaped requests", () => {
    expect(checkWriteFilter(headers({ "X-Getbus": "1" })).ok).toBe(true);
    // A browser signal wins even when the program header is present.
    expect(checkWriteFilter(headers({ "X-Getbus": "1", Cookie: "a=b" })).ok).toBe(false);
    expect(checkWriteFilter(headers({})).ok).toBe(false);
  });
});

describe("browser-hostility filter — write path", () => {
  const browserish: Array<[string, Record<string, string>]> = [
    ["navigation", { ...AGENT, "Sec-Fetch-Mode": "navigate" }],
    ["html accept", { Accept: "text/html" }],
    ["cookies", { ...AGENT, Cookie: "session=1" }],
    ["referer (link preview)", { ...AGENT, Referer: "https://chat.example/" }],
    ["no program header", { "User-Agent": "Mozilla/5.0" }],
  ];

  for (const [name, h] of browserish) {
    it(`rejects ${name} with 403`, async () => {
      const topic = uniqueTopic();
      const { status, body } = await getJson(`/?t=${topic}&m=hi`, h);
      expect(status).toBe(403);
      expect(body.error).toBe("browser");
      // And nothing was appended.
      expect((await poll(topic)).body.messages).toEqual([]);
    });
  }

  it("accepts Accept: application/json as the program header", async () => {
    const topic = uniqueTopic();
    const { status } = await getJson(`/?t=${topic}&m=hi`, { Accept: "application/json" });
    expect(status).toBe(200);
  });

  it("never filters reads — reads are safe", async () => {
    const topic = uniqueTopic();
    await publish(topic, "public");
    const { status, body } = await getJson(`/?t=${topic}`, {
      Accept: "text/html",
      Cookie: "session=1",
      Referer: "https://example.com/",
      "Sec-Fetch-Mode": "navigate",
    });
    expect(status).toBe(200);
    expect(body.messages[0].m).toBe("public");
  });
});
