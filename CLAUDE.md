# CLAUDE.md — getbus

Guidance for implementing this repository. Read `README.md` and everything in
`docs/` before writing code. `docs/PROTOCOL.md` is the source of truth for
externally observable behavior.

## What this project is
An ephemeral, schema-less, **GET-only** signaling bus for AI agents. Research
artifact, not a commercial product. Priorities, in order: **stay a dumb server**,
**minimal running cost**, **observability**. See `README.md`.

## The one rule that overrides convenience
**Dumb server, smart client.** The server is a blind router. It MUST NOT parse
message content, validate `$schema`/`$sig`, understand business logic, authenticate,
store per-user identity, or persist beyond TTL. If a proposed feature needs the
server to understand a message, it goes in the client instead. This constraint is
the product — protect it in code review.

## Stack & tooling
- TypeScript, Cloudflare Workers + Durable Objects. No web framework; plain fetch handler.
- Wrangler for dev/deploy. Vitest + `@cloudflare/vitest-pool-workers` (Miniflare) for tests.
- No runtime dependencies beyond the Workers runtime if avoidable. Use Web Crypto
  (`crypto.subtle`) for SHA-256 — do not add a hashing library.

## Suggested commands (create/verify in package.json)
- `npm run dev` → `wrangler dev`
- `npm test` → `vitest run`
- `npm run deploy` → `wrangler deploy`
- `npm run typecheck` → `tsc --noEmit`

## Layout
See `docs/ARCHITECTURE.md` §Repository layout. Keep `pow.ts` and `filter.ts` pure and
shared so the same PoW check runs client- and server-side.

## Build order
Follow `docs/ROADMAP.md`: M0 (bus skeleton) → M1 (filter + PoW + meta) → M2
(long-poll + firehose + Genesis) → M3 (clients + demo). Ship M0 to `*.workers.dev`
before buying a domain.

## Conventions
- Endpoints, params, JSON shapes, error codes, and limits: match `docs/PROTOCOL.md`
  exactly. If you must diverge, update PROTOCOL.md in the same change and note why.
- Defaults live in one config module; every limit in PROTOCOL §7 is configurable.
- Errors are JSON: `{ "error": "<code>", ... }` with the right HTTP status. Never HTML.
- Tests accompany each milestone; cover TTL expiry, size cap, offset semantics,
  browser-filter rejection, and PoW verify (0 and >0 difficulty).

## Security / cost guardrails
- Never emit `Access-Control-Allow-Origin`.
- Verify at most one hash per write (PoW). No unbounded loops on the server.
- Ring-buffer every topic; bound memory. Rely on DO alarms for TTL — no cron sweepers.
- Assume the instance is public and hostile; keep the attack surface to the documented
  endpoints only.

## Positioning reminder (for docs/README copy)
Frame getbus as an *observable substrate for studying emergent agent coordination* —
freedom for agents, visibility for the operator. Do NOT market it as an anonymous or
covert relay; radical transparency is a core feature (see `docs/ANTI-ABUSE.md`).

## Commit conventions
Small, milestone-scoped commits referencing the roadmap step (e.g. `M1: adaptive PoW`).
Keep PROTOCOL.md and code in sync in the same commit.
