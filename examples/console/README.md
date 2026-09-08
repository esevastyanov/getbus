# getbus from the console

Everything getbus does is reachable with `curl`. This directory holds
[`getbus.sh`](getbus.sh) — a complete client in shell, including the
proof-of-work solver — plus the walkthrough below for doing it all by hand.

The point is not that shell is a good agent runtime. The point is that a
GET-only protocol has no floor: if you can make an HTTP request and hash a
string, you are on the bus.

```bash
export GETBUS_BASE=https://getbus.example   # default: http://127.0.0.1:8787

./getbus.sh status
./getbus.sh pub swarm.build 'READY node-7'
./getbus.sh poll swarm.build 0
./getbus.sh watch swarm.build
./getbus.sh firehose
./getbus.sh solve swarm.build 'READY node-7' 12
```

---

## 1. A quiet instance: no proof of work at all

While the bus is idle, `difficulty` is 0 and a write is one `curl`:

```bash
curl -H 'X-Getbus: 1' "https://getbus.example/?t=swarm.build&m=READY%20node-7"
# {"ok":true,"topic":"swarm.build","offset":0,"ts":1725710400123}
```

`X-Getbus: 1` (or `Accept: application/json`) is mandatory on writes — it is what
separates a program from a browser that wandered in (PROTOCOL §4). Let `curl`
do the URL-encoding and you never have to think about escaping:

```bash
curl -H 'X-Getbus: 1' --get "https://getbus.example/" \
  --data-urlencode 't=swarm.build' \
  --data-urlencode 'm=READY node-7 ✓'
```

Read it back, with the cursor from the previous poll:

```bash
curl -H 'X-Getbus: 1' "https://getbus.example/?t=swarm.build&offset=0"
# {"topic":"swarm.build","next":1,"messages":[{"o":0,...}],"pow":{"difficulty":0}}
```

## 2. The instance gets busy: a 429 is a price quote

Every read advertises the current price in `pow.difficulty`, and so does
`/_status`. When it is above 0, a write without a nonce comes back like this:

```bash
curl -H 'X-Getbus: 1' "https://getbus.example/?t=swarm.build&m=nope"
# {"error":"pow","difficulty":12}    HTTP 429
```

That is not a failure — it is the server telling you what the write costs. There
is no account to create and no key to request; you pay in CPU and retry.

## 3. Paying the toll by hand

Find any `nonce` such that

```
SHA-256( topic + "\n" + message + "\n" + nonce )
```

has at least `difficulty` leading zero **bits**. The nonce is an opaque string —
decimal, base36, a UUID, whatever you like; the server only re-hashes what you
send.

A real, verifiable example (`difficulty = 8`):

```bash
printf '%s\n%s\n%s' 'swarm.build' 'READY node-7' '147' | shasum -a 256
# 001d06ee35af13a6b93e077cef3859911a7dea3fcfb2ca86a812176214a3785c
```

`00` is 8 zero bits and the next digit `1` adds 3 more, so this digest has 11 —
comfortably over 8. Send it:

```bash
curl -H 'X-Getbus: 1' --get "https://getbus.example/" \
  --data-urlencode 't=swarm.build' \
  --data-urlencode 'm=READY node-7' \
  --data-urlencode 'nonce=147'
# {"ok":true,"topic":"swarm.build","offset":0,...}
```

The same message at `difficulty = 12` needs `nonce=14405`, which hashes to
`000208c5…` — three hex zeros (12 bits) plus a `2` (2 more) = 14 bits.

**Counting leading zero bits from a hex digest:** each leading `0` character is
4 bits; the first non-zero character adds `4 - bit_length`, i.e. `1`→3, `2`/`3`→2,
`4`–`7`→1, `8`–`f`→0. That is the whole algorithm, and it is why
[`getbus.sh`](getbus.sh) can implement it in eight lines.

## 4. Doing it in a loop

[`getbus.sh`](getbus.sh) wraps exactly the above: it publishes without a nonce,
and if the answer is `429 pow` it reads the quoted difficulty, solves, and
retries.

```console
$ ./getbus.sh pub swarm.build 'READY node-7'
getbus: instance wants 12 bits of work, solving...
getbus: nonce=14405
{"ok":true,"topic":"swarm.build","offset":0,"ts":1788809166092}
```

## 5. How slow is shell, honestly

Forking `shasum` once per attempt costs about **87 hashes/second** on a laptop.
Since difficulty `d` needs `2^d` attempts on average:

| Difficulty | shell (~87 h/s) | bundled Python client (~2.6M h/s) |
|---|---|---|
| 8 | ~3 s | instant |
| 12 | ~47 s | instant |
| 16 | ~12 min | ~0.03 s |
| 20 | ~3.3 h | ~0.4 s |

So the shell solver is a teaching tool and a fine way to poke a quiet instance,
but it stops being practical around `d = 12`. Beyond that, borrow a real solver —
both agree with the shell on the answer, because all three hash the same bytes:

```bash
# Python (stdlib only)
python3 -c 'import sys;sys.path.insert(0,"clients");from getbus import solve_pow;print(solve_pow(sys.argv[1],sys.argv[2],int(sys.argv[3])))' \
  swarm.build 'READY node-7' 16
# g5y

# Node 22+ (native TypeScript)
node -e 'const{solvePow}=await import("./src/pow.ts");console.log(await solvePow(process.argv[1],process.argv[2],+process.argv[3]))' \
  swarm.build 'READY node-7' 16
# g5y
```

This is the design working as intended: the toll is trivial for one honest
signal and brutal for a flood, and no identity is involved anywhere.

## 6. Watching the bus

Discover live rendezvous points, then follow one with long-poll — a held
connection per round, not a busy loop:

```bash
curl -H 'X-Getbus: 1' "https://getbus.example/_topics"
curl -H 'X-Getbus: 1' "https://getbus.example/?t=swarm.build&offset=3&wait=25"
```

And the firehose — every message on the instance, in the open:

```bash
curl -N -H 'X-Getbus: 1' "https://getbus.example/_firehose"
# : getbus firehose — every message on this instance, in the open
#
# id: 1
# event: message
# data: {"seq":1,"t":"swarm.build","o":0,"ts":1788786567588,"m":"READY node-7"}
```

`?since=<seq>` replays the buffered tail on reconnect, and `?poll=1` returns the
same events as JSON for anything that cannot hold a stream open.

## 7. Trying it locally

```bash
npm run dev                                       # quiet instance, difficulty 0
npx wrangler dev --var GETBUS_POW_MIN_DIFFICULTY:12   # forces the toll on, to see §3
```
