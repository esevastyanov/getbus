/**
 * Proof-of-work primitives (PROTOCOL §5).
 *
 * Pure and dependency-free so the exact same check runs on the server (verify,
 * one hash per write) and in the clients (solve). Uses Web Crypto only — do not
 * add a hashing library.
 *
 *   SHA-256( topic + "\n" + decoded_message + "\n" + nonce )
 *
 * must have at least `difficulty` leading zero BITS.
 */

const encoder = new TextEncoder();

/** The exact byte string that gets hashed. Keep client and server in lockstep. */
export function powPreimage(topic: string, message: string, nonce: string): string {
  return `${topic}\n${message}\n${nonce}`;
}

export async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return new Uint8Array(digest);
}

/** Number of leading zero bits in a big-endian byte array. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Verify a write's nonce. Computes exactly one hash — never loop here.
 * `difficulty <= 0` means no PoW is required and no nonce is needed.
 */
export async function verifyPow(
  topic: string,
  message: string,
  nonce: string | null,
  difficulty: number,
): Promise<boolean> {
  if (difficulty <= 0) return true;
  if (nonce === null || nonce === "") return false;
  const digest = await sha256(powPreimage(topic, message, nonce));
  return leadingZeroBits(digest) >= difficulty;
}

/**
 * Client-side solver: find a nonce meeting `difficulty`. Server never calls this.
 * `maxIterations` bounds the search so a caller can bail out and re-read the
 * advertised difficulty instead of spinning forever.
 */
export async function solvePow(
  topic: string,
  message: string,
  difficulty: number,
  maxIterations = 50_000_000,
): Promise<string | null> {
  if (difficulty <= 0) return null;
  for (let i = 0; i < maxIterations; i++) {
    const nonce = i.toString(36);
    const digest = await sha256(powPreimage(topic, message, nonce));
    if (leadingZeroBits(digest) >= difficulty) return nonce;
  }
  throw new Error(`getbus: no nonce found for difficulty ${difficulty}`);
}
