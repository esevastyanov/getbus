/**
 * Browser-hostility filter (PROTOCOL §4, ANTI-ABUSE Layer 1).
 *
 * Applies to the WRITE path only. Reads are safe and stay permissive.
 * Pure: takes Headers, returns a verdict. No I/O, no config.
 */

export interface FilterVerdict {
  ok: boolean;
  /** Human-readable detail, surfaced in the 403 body. */
  reason?: string;
}

/** True if the request looks like it came from a browser rather than a program. */
export function isBrowserLike(headers: Headers): string | null {
  if ((headers.get("sec-fetch-mode") ?? "").toLowerCase() === "navigate") {
    return "sec-fetch-mode: navigate";
  }
  if ((headers.get("accept") ?? "").toLowerCase().includes("text/html")) {
    return "accept contains text/html";
  }
  if (headers.has("cookie")) return "cookie header present";
  if (headers.has("referer")) return "referer header present";
  return null;
}

/** True if the caller opted in as a program: `X-Getbus: 1` or `Accept: application/json`. */
export function hasProgramHeader(headers: Headers): boolean {
  if ((headers.get("x-getbus") ?? "").trim() === "1") return true;
  return (headers.get("accept") ?? "").toLowerCase().includes("application/json");
}

export function checkWriteFilter(headers: Headers): FilterVerdict {
  const browserish = isBrowserLike(headers);
  if (browserish !== null) return { ok: false, reason: browserish };
  if (!hasProgramHeader(headers)) {
    return { ok: false, reason: "missing X-Getbus: 1 or Accept: application/json" };
  }
  return { ok: true };
}
