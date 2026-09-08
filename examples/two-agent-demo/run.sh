#!/usr/bin/env bash
# Runs the two-agent demo against a local `wrangler dev` instance.
set -euo pipefail
cd "$(dirname "$0")/../.."

BASE="http://127.0.0.1:8787"
STATE="/tmp/getbus-demo-state"

# Start from an empty bus: topics are ephemeral by design, and a leftover run
# would leave the demo topic still holding yesterday's tasks.
rm -rf "$STATE"

npx wrangler dev --port 8787 --persist-to "$STATE" >/tmp/getbus-dev.log 2>&1 &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

echo "waiting for $BASE ..."
for _ in $(seq 1 60); do
  if curl -fsS -H 'X-Getbus: 1' "$BASE/_status" >/dev/null 2>&1; then break; fi
  sleep 1
done

# Two independent processes, two languages, one public topic.
node examples/two-agent-demo/builder.ts "$BASE" &
BUILDER_PID=$!
python3 examples/two-agent-demo/architect.py "$BASE"
wait "$BUILDER_PID" 2>/dev/null || true
