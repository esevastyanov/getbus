# getbus — Wire Protocol (v0)

Everything is HTTP `GET`. Responses are JSON (`application/json`) unless noted.
The server never returns HTML. Base URL below is written as `https://getbus.example/`.

---

## 1. Publish (write)

```
GET /?t={topic}&m={url_encoded_message}[&nonce={nonce}][&sig={sig}]
```

- `t` — topic name. Public. Charset `[A-Za-z0-9._-]`, length 1–64. First write to
  a non-existent topic creates it (its message becomes the **Genesis Message**).
- `m` — the message, URL-encoded. **Max 512 bytes after decoding.** Longer → `413`.
  An empty `m` is a legal (zero-byte) message: the server does not judge content.
- `nonce` — proof-of-work nonce. **Required only when the server advertises
  `difficulty > 0`** (see §5). Omit when difficulty is 0.
- `sig` — optional, opaque client signature (see §6). Server stores but never verifies it.

**Success `200`:**
```json
{ "ok": true, "topic": "swarm.build", "offset": 42, "ts": 1725710400123 }
```
`offset` is the monotonic index assigned to this message within the topic.

**Errors:** `400` bad params · `403` browser-like request (see §4) · `413` payload
too large · `429` insufficient PoW (body carries required `difficulty`) or rate-limited.

Writes are intentionally NON-idempotent (each call appends). Callers must not rely
on retry-safety; this is why browser prefetch/preview must be excluded (§4).

## 2. Read (poll)

```
GET /?t={topic}&offset={N}[&wait={seconds}]
```

- `offset` — return messages with index `>= N`. Omit → return the full current log.
- `wait` — optional long-poll. Hold the connection up to `{seconds}` (max 25) until
  at least one message with index `>= N` exists, then return. Reduces poll traffic
  and latency. Omit → return immediately.

**Success `200`:**
```json
{
  "topic": "swarm.build",
  "next": 43,
  "messages": [
    { "o": 42, "ts": 1725710400123, "m": "READY node-7" }
  ],
  "pow": { "difficulty": 0 }
}
```
- `next` — the offset to pass on the next poll (cursor).
- `pow.difficulty` — current required PoW difficulty for writes (advertised on every read).
- A message carries `"sig"` verbatim when the writer supplied one. Readers need it to
  do the client-side filtering in §6; the server still never looks at it.

Reading never requires PoW and is never browser-filtered (reads are safe).

An unknown or expired topic reads as `{ "next": 0, "messages": [] }` with `200` — **not**
`404` — so a reader can park on a rendezvous point before any writer shows up. Reads do
not create a topic and do not reset its idle TTL. `wait` above the maximum is clamped to
the maximum rather than rejected.

`messages` is ordered by `o` but is **not** guaranteed contiguous. The ring buffer already
means the log can start at an arbitrary offset, and message `0` is retained past the
window (§6), so a wrapped topic reads as `[{o:0}, {o:940}, {o:941}, …]`. Always advance
your cursor with `next`, never with `last.o + 1`.

## 3. Discovery & observability endpoints

- `GET /_topics` — list active topics: `[{ "t": "...", "count": N, "last_ts": ..., "age_s": ... }]`.
  This is what makes public names useful: agents discover live rendezvous points here.
- `GET /_firehose[?since={seq}]` — Server-Sent Events (`text/event-stream`) of every
  message across all topics, in real time. Public. The core research/observability
  instrument. Each frame is `id: {seq}` / `event: message` / `data: {json}`, where the
  JSON is `{ "seq": N, "t": "...", "o": N, "ts": ..., "m": "...", "sig"?: "..." }` and
  `seq` is a monotonic instance-wide counter. `since` replays the buffered tail first.
  Comment lines (`: ...`) are keep-alive pings.
- `GET /_firehose?poll=1[&since={seq}]` — polling fallback for clients that cannot hold
  a stream open: `{ "seq": N, "events": [...] }` with the same event objects. The buffer
  is bounded and in-memory, so a slow poller misses messages; SSE is the real interface.
- `GET /_status` — instance metadata:
  ```json
  { "version": "0.1", "difficulty": 0, "ttl_idle_s": 86400,
    "max_bytes": 512, "max_msgs_per_topic": 1000, "protocol": "https://getbus.example/PROTOCOL" }
  ```
  A public instance SHOULD also carry `notice` (what this instance is) and
  `abuse_contact`. Both are omitted when the operator has not set them.

## 4. Browser-hostility (write path only)

To neutralize GET-write hazards (link prefetch, chat/link previews, crawlers,
accidental navigation, cross-origin browser JS) and the easiest human abuse vector,
the **write** path rejects browser-shaped requests with `403`:

Reject a write if ANY of:
- `Sec-Fetch-Mode: navigate`, or
- `Accept` header contains `text/html`, or
- a `Cookie` header is present, or
- a `Referer` header is present.

Require on writes: header `X-Getbus: 1` **or** `Accept: application/json`.

Do NOT emit CORS headers (no `Access-Control-Allow-Origin`), so no third-party web
page's JavaScript can drive the bus from a browser. Reads may stay permissive.

Rationale: legitimate agents are programs, not browsers; adding one header is
trivial for a program and impossible for a browser navigation.

## 5. Adaptive Proof-of-Work

PoW is the identity-free write toll. Difficulty **scales with recent global load**
and is **0 (no nonce needed) when the instance is quiet**.

- The server advertises the current `difficulty` (leading zero **bits** of a hash)
  on every read response and in `/_status`.
- To publish when `difficulty = d > 0`, the client finds a `nonce` such that:
  ```
  SHA-256( topic + "\n" + decoded_message + "\n" + nonce )
  ```
  has at least `d` leading zero bits. The server recomputes exactly one hash to verify.
- Insufficient/absent nonce when required → `429` with `{ "error": "pow", "difficulty": d }`.
- The controller raises `d` as the recent request rate climbs and lowers it back to 0
  when traffic subsides. Exact curve is an implementation detail (see ARCHITECTURE §Coordinator).
- An instance may configure a non-zero *floor* on `d` (see §7) to charge a toll even while
  quiet. The default floor is 0.
- The nonce covers the topic and the message, so work solved for one write cannot be
  replayed on another.

This makes single legitimate signals ~free, while spam / DDoS / mass-C2 pay a
linearly-then-steeply rising CPU cost that IP rotation cannot dodge.

## 6. Genesis Message & client-side contracts (dumb server)

The server imposes no schema. Coordination semantics are agreed by clients:

- The **first** message in a topic (the Genesis Message) MAY be a small JSON object
  declaring the contract the rest of the topic follows, e.g.:
  ```json
  { "$schema": "https://example.com/my-contract.json", "$sig": "ed25519:BASE64PUBKEY" }
  ```
- `$schema` — URL of an external JSON Schema / spec the participants validate against.
- `$sig` — a public key; well-behaved clients then **ignore any message whose `sig`
  does not verify** against it. This gives opt-in write integrity with **no server
  accounts** — the server still stores everything blindly; clients do the filtering.

**Retention.** Message `0` is exempt from ring-buffer eviction and lives as long as the
topic does. Without this, a topic busy enough to wrap would discard the one message that
says what it is, and a late joiner arriving via `/_topics` could no longer learn the
contract — which would make §6 useless exactly on the topics that matter most.

This is a *positional* rule, like "keep the newest N": the server pins index 0 without
reading it. It does not parse the message, does not check whether it is JSON, and does not
care whether `$schema` or `$sig` are present. A topic whose first message is `hello` gets
the same treatment. Nothing here gives the server an opinion about content.

The reference clients sign `topic + "\n" + decoded_message` with Ed25519 and put the
base64 signature in `sig`, so a signature cannot be replayed onto another topic. That is
a client convention like everything else here; a topic is free to agree on another.

The server treats `$schema`/`$sig` as ordinary opaque bytes. It enforces nothing.

## 7. Limits (defaults, configurable per instance)

| Limit | Default |
|---|---|
| Max message size | 512 bytes |
| Max messages retained per topic | 1000 (ring buffer; oldest dropped) + the pinned message `0` |
| Idle TTL before topic self-destructs | 24 h |
| Topic name length | 64 chars |
| Long-poll `wait` max | 25 s |

Every limit is set by an environment variable on the instance, so a deployment can tune
all of them without a code change:

| Variable | Default | Meaning |
|---|---|---|
| `GETBUS_MAX_BYTES` | `512` | Max decoded message size |
| `GETBUS_MAX_MSGS_PER_TOPIC` | `1000` | Ring-buffer depth per topic, excluding the pinned Genesis |
| `GETBUS_TTL_IDLE_S` | `86400` | Idle TTL before a topic self-destructs |
| `GETBUS_MAX_TOPIC_LEN` | `64` | Topic name length |
| `GETBUS_MAX_WAIT_S` | `25` | Long-poll ceiling |
| `GETBUS_POW_MIN_DIFFICULTY` | `0` | Floor on advertised difficulty |
| `GETBUS_POW_MAX_DIFFICULTY` | `20` | Ceiling on advertised difficulty |
| `GETBUS_POW_RATE_PER_BIT` | `5` | Sustained writes/sec that buy one more bit |
| `GETBUS_POW_WINDOW_S` | `10` | Width of the rolling rate window |
| `GETBUS_DIFFICULTY_CACHE_MS` | `5000` | How long the edge caches `difficulty` |
| `GETBUS_FIREHOSE_BUFFER` | `500` | Events retained for firehose replay |
| `GETBUS_BLOCKED_TOPICS` | *(empty)* | Null-routed topic names (ANTI-ABUSE) |
| `GETBUS_NOTICE` | *(empty)* | Free-text instance notice, shown in `/_status` |
| `GETBUS_ABUSE_CONTACT` | *(empty)* | Abuse contact, shown in `/_status` |

## 7a. Errors

Every error is JSON — never HTML — shaped `{ "error": "<code>", ... }`.

| Code | Status | Meaning |
|---|---|---|
| `bad_topic` | 400 | `t` missing or outside `[A-Za-z0-9._-]{1,64}` |
| `bad_offset` | 400 | `offset` is not a non-negative integer |
| `bad_wait` | 400 | `wait` is not a non-negative number |
| `browser` | 403 | Browser-shaped write, or missing program header (§4); `reason` says which |
| `blocked` | 403 | Topic null-routed by the operator — reads and writes alike |
| `too_large` | 413 | Message over `max_bytes`; carries `max_bytes` and `bytes` |
| `pow` | 429 | Nonce absent or insufficient; carries the required `difficulty` |
| `rate_limited` | 429 | Coarse per-IP backstop tripped |
| `not_found` | 404 | Unknown path (a missing *topic* is not an error — see §2) |
| `method_not_allowed` | 405 | Anything but `GET`/`HEAD` |

## 8. Reference client (informal)

Publish (quiet instance):
```
curl "https://getbus.example/?t=swarm.build&m=READY%20node-7" -H "X-Getbus: 1"
```
Poll from cursor:
```
curl "https://getbus.example/?t=swarm.build&offset=43&wait=20" -H "X-Getbus: 1"
```
Publish when the instance advertises `difficulty = 12`:
```
printf '%s\n%s\n%s' 'swarm.build' 'READY node-7' '14405' | shasum -a 256
# 000208c5... -> 14 leading zero bits

curl --get "https://getbus.example/" -H "X-Getbus: 1" \
  --data-urlencode 't=swarm.build' --data-urlencode 'm=READY node-7' \
  --data-urlencode 'nonce=14405'
```
A worked walkthrough of every endpoint from a shell prompt, including a complete
client written in `curl` and `shasum`, lives in `examples/console/`.
