"""getbus — tiny Python client. Standard library only.

    bus = Getbus("https://getbus.example")
    bus.publish("swarm.build", "READY node-7")
    for msg in bus.subscribe("swarm.build"):
        print(msg["m"])

Proof-of-work here must match src/pow.ts byte for byte:

    SHA-256( topic + "\\n" + message + "\\n" + nonce )  ->  >= d leading zero bits
"""

from __future__ import annotations

import base64
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterator

USER_AGENT = "getbus.py/0.1 (+https://github.com/esevastyanov/getbus)"

# Headers that mark us as a program, not a browser (PROTOCOL §4).
#
# The explicit User-Agent is not cosmetic: an instance behind Cloudflare rejects
# the stdlib default `Python-urllib/*` at the edge with a 403 (error 1010), long
# before the request reaches getbus. Identify yourself and the block goes away.
AGENT_HEADERS = {
    "X-Getbus": "1",
    "Accept": "application/json",
    "User-Agent": USER_AGENT,
}


class GetbusError(Exception):
    def __init__(self, status: int, code: str, body: dict[str, Any]) -> None:
        super().__init__(f"getbus: {code} (HTTP {status})")
        self.status = status
        self.code = code
        self.body = body


# --- proof of work (PROTOCOL §5) -------------------------------------------


def pow_preimage(topic: str, message: str, nonce: str) -> bytes:
    return f"{topic}\n{message}\n{nonce}".encode()


def leading_zero_bits(digest: bytes) -> int:
    bits = 0
    for byte in digest:
        if byte == 0:
            bits += 8
            continue
        bits += 8 - byte.bit_length()
        break
    return bits


def solve_pow(topic: str, message: str, difficulty: int, max_iterations: int = 50_000_000) -> str | None:
    """Find a nonce meeting `difficulty`. Client-side only; the server hashes once."""
    if difficulty <= 0:
        return None
    for i in range(max_iterations):
        # base36, to match the TypeScript client's nonce alphabet.
        nonce = _base36(i)
        if leading_zero_bits(hashlib.sha256(pow_preimage(topic, message, nonce)).digest()) >= difficulty:
            return nonce
    raise RuntimeError(f"getbus: no nonce found for difficulty {difficulty}")


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, rem = divmod(n, 36)
        out = digits[rem] + out
    return out


# --- client -----------------------------------------------------------------


class Getbus:
    def __init__(self, base: str, timeout: float = 30.0, pow_retries: int = 3) -> None:
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.pow_retries = pow_retries

    # meta
    def status(self) -> dict[str, Any]:
        return self._get("/_status")

    def topics(self) -> list[dict[str, Any]]:
        return self._get("/_topics")

    # write
    def publish(self, topic: str, message: str, sig: str | None = None, difficulty: int = 0) -> dict[str, Any]:
        """Publish one signal, solving proof-of-work only if the instance asks for it."""
        for _ in range(self.pow_retries + 1):
            params = {"t": topic, "m": message}
            if sig:
                params["sig"] = sig
            if difficulty > 0:
                nonce = solve_pow(topic, message, difficulty)
                if nonce is not None:
                    params["nonce"] = nonce
            try:
                return self._get("/?" + urllib.parse.urlencode(params))
            except GetbusError as err:
                # The instance got busier between our read and our write.
                if err.status == 429 and err.code == "pow":
                    difficulty = int(err.body.get("difficulty", difficulty + 1))
                    continue
                raise
        raise RuntimeError(f"getbus: gave up solving proof-of-work for {topic}")

    # read
    def poll(self, topic: str, offset: int | None = None, wait: int | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"t": topic}
        if offset is not None:
            params["offset"] = offset
        if wait is not None:
            params["wait"] = wait
        return self._get("/?" + urllib.parse.urlencode(params))

    def subscribe(self, topic: str, offset: int = 0, wait: int = 25) -> Iterator[dict[str, Any]]:
        """Long-poll a topic forever, yielding each message once."""
        cursor = offset
        while True:
            result = self.poll(topic, offset=cursor, wait=wait)
            for message in result["messages"]:
                yield message
            # A destroyed topic restarts at 0; follow it back rather than stalling.
            cursor = result["next"] if result["next"] < cursor else max(cursor, result["next"])

    def firehose(self, since: int | None = None) -> Iterator[dict[str, Any]]:
        """Every message on the instance, in the open (PROTOCOL §3)."""
        query = f"?since={since}" if since is not None else ""
        request = urllib.request.Request(
            f"{self.base}/_firehose{query}",
            headers={"X-Getbus": "1", "Accept": "text/event-stream", "User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(request, timeout=None) as response:
            for raw in response:
                line = raw.decode("utf-8").rstrip("\n")
                if line.startswith("data: "):
                    yield json.loads(line[6:])

    def _get(self, path: str) -> Any:
        request = urllib.request.Request(self.base + path, headers=AGENT_HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as err:
            body = {}
            try:
                body = json.loads(err.read())
            except Exception:
                pass
            raise GetbusError(err.code, str(body.get("error", "unknown")), body) from None


# --- Genesis contracts & client-side signatures (PROTOCOL §6) ---------------
#
# The server stores $schema/$sig and sig as opaque bytes and enforces nothing.
# Everything below runs on the client, by convention.


def parse_genesis(messages: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Read a topic's first message as a Genesis contract, or None if it isn't one."""
    first = next((m for m in messages if m["o"] == 0), None)
    if first is None:
        return None
    try:
        contract = json.loads(first["m"])
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(contract, dict):
        return None
    return contract if ("$schema" in contract or "$sig" in contract) else None


def signing_preimage(topic: str, message: str) -> bytes:
    """Reference convention: sign topic + "\\n" + message, so sigs don't replay across topics."""
    return f"{topic}\n{message}".encode()


def verify_message(public_key: str, topic: str, message: str, signature: str | None) -> bool:
    """Ed25519 verification. Requires `cryptography`; without it, treat as unverified."""
    if not signature or not public_key.startswith("ed25519:"):
        return False
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:  # pragma: no cover - optional dependency
        raise RuntimeError("getbus: signature verification needs `pip install cryptography`") from None
    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key[len("ed25519:"):]))
        key.verify(base64.b64decode(signature), signing_preimage(topic, message))
        return True
    except (InvalidSignature, ValueError):
        return False


def verified_messages(topic: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop messages that don't verify against the topic's Genesis $sig (ANTI-ABUSE Layer 4).

    A topic with no $sig contract is returned untouched — the open default.
    """
    contract = parse_genesis(messages)
    if not contract or "$sig" not in contract:
        return messages
    key = contract["$sig"]
    # The Genesis message declares the key, so it is trusted by definition.
    return [
        m for m in messages
        if m["o"] == 0 or verify_message(key, topic, m["m"], m.get("sig"))
    ]
