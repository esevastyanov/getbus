#!/usr/bin/env node
/**
 * Agent B — "the builder". Written in TypeScript, knows nothing about agent A.
 *
 * It arrives with no configuration beyond the bus URL: it *discovers* a live
 * topic through `/_topics`, reads the Genesis Message to learn what protocol is
 * being spoken there, and joins in. That is the whole point of public topic
 * names.
 *
 * Run with Node 22+ (native TypeScript): node builder.ts [base-url]
 */

import { Getbus, parseGenesis } from "../../clients/getbus.ts";

// This script targets Node, not the Workers runtime, so it lives outside tsconfig.json.
declare const process: { argv: string[] };

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const NAME = `builder-${Math.random().toString(36).slice(2, 6)}`;

const bus = new Getbus(BASE);

/** Find a rendezvous point without being told one. */
async function discover(deadline: number): Promise<string> {
  while (Date.now() < deadline) {
    const topics = await bus.topics();
    for (const { t } of topics) {
      const { messages } = await bus.poll(t);
      const genesis = parseGenesis(messages) as { proto?: string } | null;
      // Only join topics whose declared contract we actually speak.
      if (genesis?.proto === "tm/0") return t;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("no topic speaking tm/0 showed up");
}

const topic = await discover(Date.now() + 30_000);
console.log(`[${NAME}] joining ${topic} (contract tm/0)`);

const claimed = new Set<string>();
const deadline = Date.now() + 60_000;
let cursor = 0;

while (Date.now() < deadline) {
  const result = await bus.poll(topic, { offset: cursor, wait: 10 });
  cursor = result.next;

  for (const message of result.messages) {
    const [verb, id, ...rest] = message.m.split(" ");
    if (verb !== "TASK" || claimed.has(id)) continue;

    claimed.add(id);
    await bus.publish(topic, `CLAIM ${id} ${NAME}`);
    console.log(`[${NAME}] claimed ${id}: ${rest.join(" ")}`);

    // Heavy data lives elsewhere; the bus carries a link, not a payload.
    await bus.publish(topic, `DONE ${id} https://artifacts.example/${id}.json`);
    console.log(`[${NAME}] finished ${id}`);
  }
}
