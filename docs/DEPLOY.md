# getbus — Deploying

Two surfaces, one domain. They must not be the same origin.

- **The bus** is a Cloudflare Worker. It answers `GET /?t=…`, emits JSON only, sets no
  CORS headers, and refuses browser-shaped writes.
- **The project page** is static HTML in `site/`. It is for humans, and it is the one
  thing a browser is supposed to render.

---

## Why the service gets a subdomain

Put the page on the apex and the bus on `bus.`:

```
getbus.example        ->  project page   (GitHub Pages / Cloudflare Pages)
www.getbus.example    ->  redirect to apex
bus.getbus.example    ->  the Worker
```

The reason is not cosmetic. `docs/PROTOCOL.md` opens with "the server never returns
HTML", and `docs/ANTI-ABUSE.md` Layer 1 rejects anything browser-shaped on the write
path. If the page and the bus share an origin, that invariant stops being literally true
and starts being a routing detail — the origin would serve HTML to browsers and JSON to
programs, and every reader would have to check which. Separate hostnames keep the claim
checkable: `curl -I https://bus.getbus.example/_status` is JSON, always, no exceptions.

It also means a human who hears about the project and types the domain gets an
explanation instead of `{"error":"bad_topic"}`.

**The alternative** — apex for the bus, `www.` or `docs.` for the page — works too and
gives slightly prettier `curl` lines. The cost is that the front door of the project
answers humans with a JSON error. For an artifact whose point is to be read about and
cited, that is the wrong trade. Whichever way you go, the two must be different
hostnames.

## This instance

`getbus.dev`, live since 2026-09-08. The plan above, as actually built:

| Hostname | Serves | Where it is configured |
|---|---|---|
| `getbus.dev` | project page | GitHub Pages, from `site/` |
| `www.getbus.dev` | redirect to apex | DNS |
| `bus.getbus.dev` | the Worker | `wrangler.toml` route |

**The zone had to move to Cloudflare first.** The domain was registered through
Squarespace and answered from `nsa1–nsa4.squarespacedns.com`. A Cloudflare Worker can
only take a custom domain on a zone Cloudflare itself hosts — pointing a `CNAME` at
`*.workers.dev` from third-party DNS does not work and returns Cloudflare error 1014.
So:

1. Add the domain as a site in the Cloudflare dashboard. Cloudflare imports the existing
   records; delete the registrar's parking `A` records, its `www` CNAME and its
   `_domainconnect` helper. Keep the `_dmarc`, `_domainkey` and SPF `TXT` records — they
   declare that the domain sends no mail, which is free anti-spoofing for a domain that
   never will.
2. Replace the nameservers at the registrar with the two Cloudflare gives you.
3. Wait for the delegation to take effect, then configure the Worker and Pages records
   below.

Note that `.dev` is on the HSTS preload list: browsers refuse plain HTTP for it
entirely, so nothing is reachable until the certificates are issued. That is a feature
here — the bus is HTTPS-only anyway.

## Wiring the Worker to the domain

Add the custom domain to `wrangler.toml` and redeploy:

```toml
[[routes]]
pattern = "bus.getbus.dev"
custom_domain = true
```

The zone must be on Cloudflare DNS. Cloudflare creates the DNS record and issues the
certificate itself; no A records to manage. Keep `workers_dev = true` as a fallback
origin, or drop it once the domain is live.

## Wiring the page to the domain

### Option A — Cloudflare Pages (fewest moving parts)

The domain is already on Cloudflare for the Worker, so the page may as well be:
connect the repository in the Cloudflare dashboard, set the output directory to `site`
with no build command, and add `getbus.example` as a custom domain. DNS and TLS are
handled in the same place as the Worker.

### Option B — GitHub Pages

`.github/workflows/pages.yml` publishes `site/` on every push to `main`. Enable Pages in
the repository settings with source "GitHub Actions", then:

1. **Do the DNS first, the `CNAME` file last.** Adding `site/CNAME` makes GitHub Pages
   adopt the custom domain immediately and start redirecting `<user>.github.io/<repo>`
   to it — so committing it before DNS resolves takes the page down at both addresses.
   Once the records below are live, create it with the bare domain, one line, no scheme:
   ```
   getbus.dev
   ```
2. Point the apex at GitHub's Pages servers with four `A` records (and the matching
   `AAAA` records for IPv6). **Take the current addresses from GitHub's own
   documentation** — "Managing a custom domain for your GitHub Pages site" — rather than
   from any copy of them, including this file; they have changed before.
3. Add `www` as a `CNAME` to `<user>.github.io`.
4. **Set those records to DNS-only (grey cloud) in Cloudflare.** This is not optional:
   GitHub issues the custom domain's certificate over an HTTP-01 challenge on the domain
   itself, and a Cloudflare proxy intercepts that challenge, so issuance never completes
   and "Enforce HTTPS" stays unavailable. Proxying also puts two certificate authorities
   in the path, a well-known source of redirect loops. The Worker's own hostname is the
   one record that stays proxied — it has to be, it *is* Cloudflare.
5. Enable "Enforce HTTPS" in the repository's Pages settings once the certificate is
   issued.

Both options leave the bus untouched: it is a Worker on `bus.`, deployed with
`npm run deploy`, and it never learns that a project page exists.

## After the domain is live

Search and replace the instance origin in these places:

| Where | What |
|---|---|
| `site/index.html` | the `workers.dev` URLs in the examples and the "live instance" link |
| `wrangler.toml` | `GETBUS_PROTOCOL_URL` if the spec moves to the domain |
| `README.md`, `docs/PROTOCOL.md` | `getbus.example` placeholders, if you want real URLs |

### Order of operations

Each step assumes the previous one has taken effect. Skipping ahead is what breaks
things:

1. Move the zone to Cloudflare (nameserver change at Squarespace).
2. Add the Worker route in `wrangler.toml`, uncomment it, `npm run deploy`.
3. Add the GitHub Pages `A`/`AAAA` records, grey-clouded.
4. Set the custom domain in the repository's Pages settings and commit `site/CNAME`.
5. Wait for GitHub to issue the certificate, then enable "Enforce HTTPS".
6. Only then repoint the URLs in `site/index.html` — publishing them earlier would ship
   a page full of links to a host that does not answer yet.

Then re-run the conformance check against the new origin:

```bash
./examples/console/conformance.sh https://bus.getbus.dev
```

Resolvers cache aggressively during a cutover — a negative answer from before the record
existed can linger for the zone's SOA minimum. To check an origin your own resolver has
not caught up with yet, pin the address:

```bash
GETBUS_RESOLVE=104.21.31.155 ./examples/console/conformance.sh https://bus.getbus.dev
```
