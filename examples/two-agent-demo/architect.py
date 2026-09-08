#!/usr/bin/env python3
"""Agent A — "the architect". Written in Python, knows nothing about agent B.

It opens a public topic with a Genesis Message declaring the ad-hoc protocol it
intends to speak, posts work, and waits for whoever shows up to do it.

The server never sees any of this structure: to it, these are opaque strings
under 512 bytes.
"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients"))
from getbus import Getbus  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
TOPIC = "demo.taskmarket"

# The Genesis Message: the only "schema" in the system, and it is a convention
# between clients, not a rule the server enforces (PROTOCOL §6).
GENESIS = {
    "$schema": "https://getbus.example/contracts/task-market.v0.json",
    "proto": "tm/0",
    "verbs": ["TASK <id> <what>", "CLAIM <id> <who>", "DONE <id> <url>"],
}

TASKS = {
    "t1": "render histogram of run 42",
    "t2": "diff configs between staging and prod",
}


def main() -> None:
    bus = Getbus(BASE)
    print(f"[architect] instance: {bus.status()}")

    log = bus.poll(TOPIC)
    if log["next"] == 0:
        print(f"[architect] opening {TOPIC} with a Genesis contract")
        bus.publish(TOPIC, json.dumps(GENESIS, separators=(",", ":")))
    else:
        print(f"[architect] {TOPIC} already exists at offset {log['next']}")

    # Take the cursor BEFORE posting, or a fast builder finishes the work
    # before we start listening and we miss the replies entirely.
    cursor = bus.poll(TOPIC)["next"]

    for task_id, what in TASKS.items():
        bus.publish(TOPIC, f"TASK {task_id} {what}")
        print(f"[architect] posted TASK {task_id}")

    outstanding = set(TASKS)
    deadline = time.time() + 60

    while outstanding and time.time() < deadline:
        result = bus.poll(TOPIC, offset=cursor, wait=10)
        cursor = result["next"]
        for message in result["messages"]:
            verb, *rest = message["m"].split(" ")
            if verb == "CLAIM" and rest[0] in outstanding:
                print(f"[architect] {rest[1]} claimed {rest[0]}")
            elif verb == "DONE" and rest[0] in outstanding:
                outstanding.discard(rest[0])
                print(f"[architect] {rest[0]} done -> {rest[1]}")

    print("[architect] all tasks done" if not outstanding else f"[architect] gave up on {outstanding}")


if __name__ == "__main__":
    main()
