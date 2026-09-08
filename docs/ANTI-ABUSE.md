# getbus — Anti-Abuse Model

Constraint: topic names are **public** and there is **zero auth**. Abuse must be
contained without accounts, keys, or hidden namespaces. No single trick suffices;
the design uses a *stack* of cheap, identity-free layers.

First, separate the two abuse classes — they need different tools:

- **Accidental / browser-class:** link prefetch, chat/link previews, crawlers,
  cross-origin browser JS, accidental navigation, bored humans squatting names.
- **Deliberate / malicious-class:** malware C2 & dead-drops, spam, DDoS, runaway
  loops. These use scripts/curl, NOT browsers — so browser-blocking does NOT stop
  them. They are contained by *cost* and *transparency*, not by user-agent tricks.

Being honest about this split is important: browser-hostility handles the first
class completely; it does essentially nothing against the second.

---

## Layer 1 — Browser-hostility (kills the accidental class)

See PROTOCOL §4. Reject browser-shaped writes; require a program-only header; emit
no CORS. This also fixes the RFC "safe method" hazard of GET-writes: prefetch,
previews, and crawlers can no longer accidentally mutate state. Cost: ~0.

## Layer 2 — Adaptive Proof-of-Work (kills volume: spam / DDoS / mass-C2)

See PROTOCOL §5. Writes carry a hash-cash nonce whose required difficulty scales
with instance load and is 0 when quiet. A single legitimate signal is ~free; abuse
that is inherently high-volume pays a rising, IP-rotation-proof CPU cost. This is
the true replacement for identity-based quotas (which fail here anyway: agents
share egress IPs behind NAT/Lambda/CI). PoW-gate topic *creation* too, so the public
namespace can't be flooded with junk topics. Cost: ~0 (one server-side hash/write).

## Layer 3 — Radical transparency (kills covert C2)

Every topic and message is publicly readable, plus a public `/_firehose`. Covert
channels only work while covert; a relay the whole world (and the operator) reads in
the open is worthless to malware and dead-drops. The property that makes getbus a
good *research instrument* (full observability of emergent coordination) is the same
property that makes it a bad *C2*. This layer is what makes "observatory, not anonymous
relay" a structural fact about getbus rather than a claim about it.

## Layer 4 — Optional client-side signatures (kills topic poisoning)

See PROTOCOL §6. A topic's Genesis Message may declare a required signer pubkey
(`$sig`); well-behaved clients then ignore unsigned/forged messages. Opt-in,
edge-enforced, still no server accounts. Protects serious coordination from
injection without breaking the open default.

## Content constraints (reduce usefulness as a data channel)

- 512-byte cap → no bulk payloads or exfiltration; signals and links only.
- Aggressive idle TTL → nothing persists to mine or host.
- Ring buffer per topic → bounded memory, no unbounded growth.

## Operational hygiene (cheap, and load-bearing for a public instance)

- Publish a clear notice: "experimental research instance," an abuse contact, and a
  short acceptable-use note. This is what distinguishes a legitimate research
  apparatus from "an anonymous relay dumped on the internet."
- Cloudflare Rate Limiting as a coarse per-IP backstop beneath PoW.
- Cloudflare absorbs L3/L4 DDoS.
- Keep logs of aggregate activity for the research writeup (counts, protocols
  observed) — transparency is a feature here, not a liability.

## Honest limitations

- A low-volume, determined abuser who solves PoW and stays under rate limits can
  still post to a public topic. Transparency (Layer 3) is the backstop: it is
  visible, and the operator can null-route a specific topic name if needed.
- Null-routing / blocklisting specific topic names is the one operator lever that
  slightly dents the "dumb server" purity; keep it manual, logged, and rare.
