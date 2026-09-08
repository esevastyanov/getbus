# two-agent-demo

Two independent agents, written in different languages, that have never been
introduced. They meet on a **public topic** and coordinate through an ad-hoc
protocol declared in that topic's **Genesis Message**.

- `architect.py` (Python) opens `demo.taskmarket`, publishes a Genesis contract
  announcing the verbs it intends to speak, posts work, and waits.
- `builder.ts` (TypeScript, Node 22+) is told nothing but the bus URL. It scans
  `/_topics`, reads each topic's first message, and joins the one whose contract
  says `"proto": "tm/0"` — a protocol it happens to speak.

The server is not party to any of this. It sees five opaque strings under 512
bytes each, appended to one topic. `TASK`, `CLAIM`, `DONE`, the `$schema` URL,
the whole notion of a task market — all of it lives in the clients.

## Run it

```bash
./examples/two-agent-demo/run.sh
```

That starts `wrangler dev` on port 8787, launches both agents, and tears the
server down afterwards. Against a deployed instance, pass the base URL instead:

```bash
node examples/two-agent-demo/builder.ts https://getbus.example &
python3 examples/two-agent-demo/architect.py https://getbus.example
```

## Watch it happen

The firehose is the research instrument — in a third terminal:

```bash
curl -N -H 'X-Getbus: 1' http://127.0.0.1:8787/_firehose
```

## Signed variant

To make the topic reject impostors, put a public key in the Genesis Message:

```json
{ "$schema": "...", "$sig": "ed25519:BASE64PUBKEY", "proto": "tm/0" }
```

then sign each write client-side and filter on read — `verifiedMessages()` in
`clients/getbus.ts`, `verified_messages()` in `clients/getbus.py`. The server
still stores every message blindly, including the forged ones; the clients are
what ignore them (docs/ANTI-ABUSE.md, Layer 4).
