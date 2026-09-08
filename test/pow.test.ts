import { describe, expect, it } from "vitest";
import { leadingZeroBits, powPreimage, sha256, solvePow, verifyPow } from "../src/pow";
import { getJson, poll, publish, uniqueTopic } from "./helpers";

describe("pow — unit (PROTOCOL §5)", () => {
  it("counts leading zero bits", () => {
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x7f]))).toBe(1);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x80]))).toBe(8);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x0f]))).toBe(20);
    expect(leadingZeroBits(new Uint8Array([0, 0, 0, 0]))).toBe(32);
  });

  it("hashes exactly `topic \\n message \\n nonce`", async () => {
    expect(powPreimage("t", "m", "7")).toBe("t\nm\n7");
    // Pins the preimage so client solvers and the server verifier cannot drift.
    expect(await sha256("t\nm\n7")).toEqual(await sha256(powPreimage("t", "m", "7")));
  });

  it("accepts anything at difficulty 0, including a missing nonce", async () => {
    expect(await verifyPow("t", "m", null, 0)).toBe(true);
    expect(await verifyPow("t", "m", "garbage", 0)).toBe(true);
  });

  it("agrees with clients/getbus.py on the nonce for a fixed input", async () => {
    // Pins the shared preimage, hash and base36 nonce alphabet across languages.
    // If this changes, clients/getbus.py must change with it.
    expect(await solvePow("swarm.build", "READY", 12)).toBe("63q");
  });

  it("verifies a solved nonce and rejects a wrong one at difficulty > 0", async () => {
    const nonce = await solvePow("swarm.build", "READY", 12);
    expect(nonce).not.toBeNull();
    expect(await verifyPow("swarm.build", "READY", nonce, 12)).toBe(true);
    expect(await verifyPow("swarm.build", "READY", null, 12)).toBe(false);
    expect(await verifyPow("swarm.build", "READY", "", 12)).toBe(false);
    // Bound to topic and message, so a nonce cannot be replayed elsewhere.
    expect(await verifyPow("other.topic", "READY", nonce, 12)).toBe(false);
    expect(await verifyPow("swarm.build", "OTHER", nonce, 12)).toBe(false);
  });
});

describe("pow — quiet instance", () => {
  it("advertises difficulty 0 and accepts writes with no nonce", async () => {
    const topic = uniqueTopic("pow.quiet");
    expect((await publish(topic, "free")).status).toBe(200);
    expect((await poll(topic)).body.pow.difficulty).toBe(0);
    expect((await getJson("/_status")).body.difficulty).toBe(0);
  });
});
