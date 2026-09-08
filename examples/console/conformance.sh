#!/usr/bin/env bash
#
# Conformance check for a live getbus instance.
#
#   ./conformance.sh https://getbus.example
#
# Verifies an instance against docs/PROTOCOL.md using nothing but curl. Anyone
# can run this against any instance — including one they do not operate — which
# is the point: the protocol is small enough to be checkable from outside.
#
# A failed request is reported as a failure, never as a pass. Exits non-zero if
# any check fails.

set -uo pipefail

BASE="${1:-${GETBUS_BASE:-http://127.0.0.1:8787}}"
BASE="${BASE%/}"
AGENT=(-H 'X-Getbus: 1')
TOPIC="conformance.$(date +%s).$$"
PASS=0
FAIL=0
STATUS=""
BODY=""

green() { printf '\033[32m%s\033[0m' "$1"; }
red() { printf '\033[31m%s\033[0m' "$1"; }
ok() { printf '  %s  %s\n' "$(green ok)" "$1"; PASS=$((PASS + 1)); }
bad() { printf '  %s %s\n       %s\n' "$(red FAIL)" "$1" "$2"; FAIL=$((FAIL + 1)); }

# Populates STATUS and BODY. Returns non-zero when the request itself failed, so
# a network or TLS error can never be mistaken for a passing assertion.
req() {
  local out
  out=$(curl -sS -m 25 -w $'\n%{http_code}' "$@" 2>/dev/null) || return 1
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
  [ -n "$STATUS" ] || return 1
}

expect_code() { # expect_code <label> <code> <curl args...>
  local label="$1" want="$2"
  shift 2
  if ! req "$@"; then bad "$label" "request failed (network or TLS)"; return; fi
  if [ "$STATUS" = "$want" ]; then ok "$label"; else bad "$label" "want HTTP $want, got $STATUS — $BODY"; fi
}

expect_body() { # expect_body <label> <substring> <curl args...>
  local label="$1" want="$2"
  shift 2
  if ! req "$@"; then bad "$label" "request failed (network or TLS)"; return; fi
  case "$BODY" in
    *"$want"*) ok "$label" ;;
    *) bad "$label" "no '$want' in: $BODY" ;;
  esac
}

refute_body() { # refute_body <label> <substring> <curl args...>
  local label="$1" want="$2"
  shift 2
  if ! req "$@"; then bad "$label" "request failed (network or TLS)"; return; fi
  case "$BODY" in
    *"$want"*) bad "$label" "unexpected '$want' in: $BODY" ;;
    *) ok "$label" ;;
  esac
}

echo "getbus conformance — $BASE"
echo "topic: $TOPIC"

echo
echo "PROTOCOL §3 — instance metadata"
expect_code "/_status returns 200"          200 "${AGENT[@]}" "$BASE/_status"
expect_body "/_status advertises version"   '"version"' "${AGENT[@]}" "$BASE/_status"
expect_body "/_status advertises difficulty" '"difficulty"' "${AGENT[@]}" "$BASE/_status"
expect_body "/_status advertises max_bytes" '"max_bytes"' "${AGENT[@]}" "$BASE/_status"
expect_body "/_status links the protocol"   '"protocol"' "${AGENT[@]}" "$BASE/_status"
expect_code "/_topics returns 200"          200 "${AGENT[@]}" "$BASE/_topics"

echo
echo "PROTOCOL §1–2 — publish and read"
expect_body "first write creates the topic at offset 0" '"offset":0' \
  "${AGENT[@]}" --get "$BASE/" --data-urlencode "t=$TOPIC" --data-urlencode 'm=GENESIS {"proto":"conformance/0"}'
expect_body "second write gets offset 1" '"offset":1' \
  "${AGENT[@]}" --get "$BASE/" --data-urlencode "t=$TOPIC" --data-urlencode 'm=READY node-7'
expect_body "read returns the cursor"    '"next":2' "${AGENT[@]}" "$BASE/?t=$TOPIC"
expect_body "read returns the payload"   'READY node-7' "${AGENT[@]}" "$BASE/?t=$TOPIC"
expect_body "read advertises pow"        '"pow"' "${AGENT[@]}" "$BASE/?t=$TOPIC"
expect_body "offset=1 returns the newer message" 'READY node-7' "${AGENT[@]}" "$BASE/?t=$TOPIC&offset=1"
refute_body "offset=1 excludes the older one"    'GENESIS' "${AGENT[@]}" "$BASE/?t=$TOPIC&offset=1"
expect_body "offset past the head is empty"      '"messages":[]' "${AGENT[@]}" "$BASE/?t=$TOPIC&offset=99"
expect_body "unknown topic reads empty, not 404" '"next":0' "${AGENT[@]}" "$BASE/?t=$TOPIC.absent"

echo
echo "PROTOCOL §4 — browser-hostility on the write path"
expect_code "Accept: text/html rejected"  403 -H 'Accept: text/html' "$BASE/?t=$TOPIC&m=x"
expect_code "Referer rejected"            403 "${AGENT[@]}" -H 'Referer: https://chat.example/' "$BASE/?t=$TOPIC&m=x"
expect_code "Cookie rejected"             403 "${AGENT[@]}" -H 'Cookie: s=1' "$BASE/?t=$TOPIC&m=x"
expect_code "Sec-Fetch-Mode: navigate rejected" 403 "${AGENT[@]}" -H 'Sec-Fetch-Mode: navigate' "$BASE/?t=$TOPIC&m=x"
expect_code "missing program header rejected"   403 -H 'User-Agent: Mozilla/5.0' "$BASE/?t=$TOPIC&m=x"
expect_code "Accept: application/json accepted" 200 -H 'Accept: application/json' --get "$BASE/" --data-urlencode "t=$TOPIC" --data-urlencode 'm=json-accept'
expect_code "reads are never filtered"    200 -H 'Accept: text/html' -H 'Cookie: s=1' "$BASE/?t=$TOPIC"

echo
echo "PROTOCOL §7 / §7a — limits and errors"
expect_code "512 bytes accepted"  200 "${AGENT[@]}" --get "$BASE/" --data-urlencode "t=$TOPIC" --data-urlencode "m=$(head -c 512 </dev/zero | tr '\0' 'x')"
expect_code "513 bytes rejected"  413 "${AGENT[@]}" --get "$BASE/" --data-urlencode "t=$TOPIC" --data-urlencode "m=$(head -c 513 </dev/zero | tr '\0' 'x')"
expect_code "invalid topic name"  400 "${AGENT[@]}" "$BASE/?t=has%20space&m=x"
expect_code "negative offset"     400 "${AGENT[@]}" "$BASE/?t=$TOPIC&offset=-1"
expect_code "unknown path"        404 "${AGENT[@]}" "$BASE/nope"
expect_code "non-GET rejected"    405 -X POST "${AGENT[@]}" "$BASE/?t=$TOPIC&m=x"

echo
echo "Transport invariants"
if hdrs=$(curl -sSI -m 25 "${AGENT[@]}" "$BASE/_status" 2>/dev/null); then
  case "$hdrs" in
    *[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin*) bad "emits no CORS header" "found Access-Control-Allow-Origin" ;;
    *) ok "emits no CORS header" ;;
  esac
  case "$hdrs" in
    *application/json*) ok "responses are JSON, never HTML" ;;
    *) bad "responses are JSON, never HTML" "content-type was not application/json" ;;
  esac
else
  bad "emits no CORS header" "HEAD request failed"
  bad "responses are JSON, never HTML" "HEAD request failed"
fi

echo
echo "PROTOCOL §2 — long-poll"
start=$(date +%s)
if req "${AGENT[@]}" "$BASE/?t=$TOPIC.quiet&offset=0&wait=3"; then
  elapsed=$(( $(date +%s) - start ))
  if [ "$elapsed" -ge 2 ] && [ "$elapsed" -le 10 ]; then
    ok "wait=3 parks for ~3s then returns empty (${elapsed}s)"
  else
    bad "wait=3 parks then returns" "returned after ${elapsed}s"
  fi
else
  bad "wait=3 parks then returns" "request failed"
fi

echo
echo "PROTOCOL §3 — firehose"
if fh=$(curl -sSN -m 6 "${AGENT[@]}" "$BASE/_firehose?poll=1" 2>/dev/null); then
  case "$fh" in
    *'"events"'*) ok "/_firehose?poll=1 returns an event list" ;;
    *) bad "/_firehose?poll=1 returns an event list" "$fh" ;;
  esac
else
  bad "/_firehose?poll=1 returns an event list" "request failed"
fi
# The firehose never ends, so curl always exits on its own timeout. Judge this
# one on the bytes received, not on the exit code.
sse=$(curl -sSN -m 6 "${AGENT[@]}" "$BASE/_firehose" 2>/dev/null | head -c 200 || true)
case "$sse" in
  *'getbus firehose'*) ok "/_firehose streams Server-Sent Events" ;;
  '') bad "/_firehose streams Server-Sent Events" "no bytes received" ;;
  *) bad "/_firehose streams Server-Sent Events" "unexpected preamble: $sse" ;;
esac

echo
echo "─────────────────────────────────────"
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
