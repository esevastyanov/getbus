#!/usr/bin/env bash
#
# getbus — a complete client in shell. curl to talk, shasum to pay the toll.
#
# There is no SDK and no dependency here beyond what a POSIX box already has.
# That is the point of a GET-only protocol: if you can make an HTTP request and
# hash a string, you can join the bus.
#
#   ./getbus.sh status
#   ./getbus.sh pub swarm.build 'READY node-7'
#   ./getbus.sh poll swarm.build 0
#   ./getbus.sh watch swarm.build
#   ./getbus.sh firehose
#   ./getbus.sh solve swarm.build 'READY node-7' 12
#
# Base URL comes from $GETBUS_BASE, or -b, and defaults to a local wrangler dev.

set -euo pipefail

BASE="${GETBUS_BASE:-http://127.0.0.1:8787}"

# The one header that separates a program from a browser (PROTOCOL §4).
AGENT=(-H 'X-Getbus: 1')

if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum; }
else
  echo "getbus: need shasum or sha256sum" >&2
  exit 1
fi

# --- tiny JSON field readers ------------------------------------------------
# Enough to follow the protocol without pulling in jq. Responses are flat and
# machine-generated, so this is safe here and nowhere else.

jnum() { # jnum <field> <json>
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" <<<"$2" | head -1
}

jstr() { # jstr <field> <json>
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" <<<"$2" | head -1
}

# --- proof of work (PROTOCOL §5) --------------------------------------------

# Leading zero BITS of a hex digest. Each '0' hex char is 4 zero bits; the first
# non-zero char contributes 4 - bit_length(char).
leading_zero_bits() { # leading_zero_bits <hex>
  local hex="$1" zeros rest bits
  zeros="${hex%%[!0]*}"     # the run of leading '0' characters
  rest="${hex#"$zeros"}"    # from the first non-zero character on
  bits=$((${#zeros} * 4))
  case "$rest" in
    "") ;;                        # digest is all zeros
    1*) bits=$((bits + 3)) ;;
    [23]*) bits=$((bits + 2)) ;;
    [4-7]*) bits=$((bits + 1)) ;;
  esac
  echo "$bits"
}

# Find a nonce with >= difficulty leading zero bits in
#   SHA-256( topic \n message \n nonce )
# The server recomputes exactly one hash to check it. The nonce is an opaque
# string, so plain decimal is fine — no alphabet is mandated by the protocol.
solve_pow() { # solve_pow <topic> <message> <difficulty>
  local topic="$1" message="$2" difficulty="$3" nonce=0 digest
  [ "$difficulty" -le 0 ] && return 0
  while :; do
    digest=$(printf '%s\n%s\n%s' "$topic" "$message" "$nonce" | sha256)
    digest=${digest%% *}
    if [ "$(leading_zero_bits "$digest")" -ge "$difficulty" ]; then
      printf '%s' "$nonce"
      return 0
    fi
    nonce=$((nonce + 1))
  done
}

# --- endpoints ---------------------------------------------------------------

status() { curl -sS "${AGENT[@]}" "$BASE/_status"; echo; }
topics() { curl -sS "${AGENT[@]}" "$BASE/_topics"; echo; }
firehose() { curl -sSN "${AGENT[@]}" "$BASE/_firehose"; }

poll() { # poll <topic> [offset] [wait]
  curl -sS "${AGENT[@]}" --get "$BASE/" \
    --data-urlencode "t=$1" \
    --data-urlencode "offset=${2:-0}" \
    --data-urlencode "wait=${3:-0}"
}

# Publish, paying proof-of-work only if the instance asks for it. A quiet
# instance answers the first request with 200 and no hashing ever happens.
pub() { # pub <topic> <message>
  local topic="$1" message="$2" nonce="" difficulty=0 attempt response code body

  for attempt in 1 2 3 4; do
    local args=(--data-urlencode "t=$topic" --data-urlencode "m=$message")
    [ -n "$nonce" ] && args+=(--data-urlencode "nonce=$nonce")

    response=$(curl -sS -w $'\n%{http_code}' "${AGENT[@]}" --get "$BASE/" "${args[@]}")
    code=${response##*$'\n'}
    body=${response%$'\n'*}

    if [ "$code" = "200" ]; then
      echo "$body"
      return 0
    fi

    # 429 + "pow" is not a failure, it is a price quote.
    if [ "$code" = "429" ] && [[ "$body" == *'"pow"'* ]]; then
      difficulty=$(jnum difficulty "$body")
      echo "getbus: instance wants $difficulty bits of work, solving..." >&2
      nonce=$(solve_pow "$topic" "$message" "$difficulty")
      echo "getbus: nonce=$nonce" >&2
      continue
    fi

    echo "getbus: HTTP $code $body" >&2
    return 1
  done

  echo "getbus: gave up after 4 attempts" >&2
  return 1
}

# Follow a topic with long-poll: one held connection per round, not a busy loop.
watch() { # watch <topic> [offset]
  local topic="$1" cursor="${2:-0}" body next
  while :; do
    body=$(poll "$topic" "$cursor" 25)
    next=$(jnum next "$body")
    [ "$next" != "$cursor" ] && echo "$body"
    cursor="$next"
  done
}

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# --- dispatch ----------------------------------------------------------------

while [ $# -gt 0 ] && [ "$1" = "-b" ]; do
  BASE="$2"
  shift 2
done

[ $# -eq 0 ] && usage
command="$1"
shift

case "$command" in
  status) status ;;
  topics) topics ;;
  firehose) firehose ;;
  pub) [ $# -ge 2 ] || usage; pub "$1" "$2"; echo ;;
  poll) [ $# -ge 1 ] || usage; poll "$1" "${2:-0}" "${3:-0}"; echo ;;
  watch) [ $# -ge 1 ] || usage; watch "$1" "${2:-0}" ;;
  solve) [ $# -ge 3 ] || usage; solve_pow "$1" "$2" "$3"; echo ;;
  *) usage ;;
esac
