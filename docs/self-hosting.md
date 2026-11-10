# Self-hosting

Areza Secret runs as one Cloudflare Worker with two Durable Object classes. There is no database to set up, no
server to patch and nothing to back up: every item lives in a Durable Object and deletes itself at expiry. The free
Workers plan is enough to run it (the Durable Objects use the SQLite backend). A public instance should use Workers
Paid; see [Plans and limits](#plans-and-limits).

You need:

- a Cloudflare account, and a domain on Cloudflare if you want your own hostname (recommended);
- [Bun](https://bun.sh) 1.4.2 (the version pinned in `package.json`; the build and `verify` depend on it);
- `git`, and `openssl` for generating secrets.

Wrangler is a dev dependency of this repo, so `bunx wrangler` uses the pinned version after `bun install`.

Read [threat-model.md](threat-model.md) first, in particular the [operator checklist](threat-model.md#operator-checklist).
Whoever runs an instance controls the JavaScript its users run, and that comes with responsibilities.

## Configuration reference

### Build variables (read by `bun run build`)

These are read at build time, not by the running Worker. For the manual route, put them in front of `bun run deploy`.
For the Deploy button route, set them as build variables.

| Variable | Default | Meaning |
|---|---|---|
| `VK_THEME` | `themes/default` | Directory of a theme whose `theme.ts` default-exports a `Theme`. See [theming.md](theming.md) |
| `VK_ORIGIN` | `https://example.com` | Canonical origin of the instance, no trailing slash. Used in canonical and hreflang links, Open Graph tags, the sitemap, `llms.txt` and the JSON-LD |
| `VK_PRODUCT` | `Vienkartinė nuoroda` | Product name in the header, titles and footer |
| `VK_REPO` | `https://github.com/areza-digital/one-time-secret-link` | Public source repository, linked from the footer together with the commit. Set it to your fork if you deploy your own commits |
| `VK_CONTACT` | `abuse@example.com` | Contact address shown in the footer and FAQ. Abuse reports go here |
| `VK_WRANGLER_CONFIG` | `wrangler.jsonc` | Worker config whose `vars` (`INDEXABLE`, `RESERVED_LABEL_WORDS`) the pages follow |
| `VK_OUT` | `dist` | Output directory. `wrangler.jsonc` serves `dist`, so change both or neither |

`VK_ORIGIN`, `VK_PRODUCT`, `VK_REPO` and `VK_CONTACT` are read by the default theme. A custom theme sets its own
`config` and may ignore them. If you leave `VK_ORIGIN` and `VK_CONTACT` unset, the pages say `example.com`.

### Worker secrets

Set these with `bunx wrangler secret put NAME`, or in the Deploy to Cloudflare prompt. The names are listed in
`.dev.vars.example`.

| Secret | Required | Meaning |
|---|---|---|
| `IP_SALT` | Yes | Random salt for the daily IP hash used by rate limiting. Generate with `openssl rand -base64 32`. Without it, anonymous API calls fail with a 500 instead of hashing with a known salt |
| `OPERATOR_TOKEN_SHA256` | No | SHA-256 (hex) of your operator token. See [Operator token](#operator-token) |

### Worker variables (`vars` in `wrangler.jsonc`)

Set these in `wrangler.jsonc` rather than only in the dashboard: the build reads them from the file so that the pages
and the Worker agree.

| Variable | Default | Meaning |
|---|---|---|
| `VERIFIED_NAME` | `Operator` | The name shown after "Verified:" on items created with the operator token |
| `INDEXABLE` | `"false"` | `"true"` lets search engines index the two landing pages (and publishes `robots.txt` with a sitemap). App pages and the API are always `noindex`. With `"false"`, everything is `noindex` and `robots.txt` disallows all |
| `PREVIEW_BOTS` | `""` | Comma-separated user agents of link-preview bots, for example `LinkedInBot` or `LinkedInBot,facebookexternalhit,Twitterbot`. While `INDEXABLE` is `"false"`, `robots.txt` lets these bots read the landing pages and the social image, so a shared link gets a preview card, and still disallows the app pages and the API. Every other crawler stays disallowed, and the pages keep their `noindex` tags |
| `RESERVED_LABEL_WORDS` | `""` | Comma-separated words that anonymous request labels may not contain. Empty means the built-in defaults. **A non-empty value replaces the defaults.** A plain entry matches anywhere in the label, ignoring case, accents and lookalike letters (`patvirtin` catches `patvirtinta`). An entry starting with `=` matches whole words only (`=pin` blocks `PIN` but not `pinigai`) |

The built-in defaults are `verif`, `patvirtin`, `official`, `oficial`, and the whole words `pin`, `pin1`, `pin2`, `puk`,
`smart-id`, `smartid`, `mobile-id`, `swedbank`, `seb`, `luminor`, `citadele`, `revolut`, `paysera`, `siauliu`. They suit
the Lithuanian market. Write your own list for your brand and your local banks. The Worker enforces the list; the pages
embed the same list at build time for a pre-check (when the variable is empty the pre-check is skipped and the Worker's
answer is shown instead).

### Bindings

Defined in `wrangler.jsonc`:

- `ASSETS`: static files from `dist/`. The Worker runs first only for `/api/*`, the app pages `/s/*`, `/r/*`, `/o/*`
  (also under `/en/`), `/_app/*` and `/robots.txt`. Everything else is served by Workers static assets with the
  security headers from the generated `dist/_headers`.
- `BOXES` (class `SecretBox`) and `LIMITS` (class `RateLimiter`): the Durable Objects. The migration `v1` creates both
  as SQLite-backed classes. Do not edit existing migration entries. `LIMITS` also holds the [daily totals](#daily-totals)
  in one object named `stats`, so they need no extra binding and no migration.
- `ratelimits`: four Workers Rate Limiting bindings, `RL_CREATE` (6 per minute), `RL_FILL` (10), `RL_OPEN` (20) and
  `RL_READ` (60), counted per IP key in memory and checked before any Durable Object is called. Their `namespace_id`
  values (`"7101"` to `"7104"`) must be unique within your Cloudflare account; two bindings with the same id, even in
  different Workers, share counters. Change them if another Worker of yours uses the same ids. If you remove the block,
  the Worker still works with the Durable Object limits alone, at the cost of more Durable Object requests.

## Route A: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/areza-digital/one-time-secret-link)

1. Follow the flow. It creates a copy of the repository in your Git account and a Worker connected to it, and prompts
   for the secrets listed in `.dev.vars.example`. Enter an `IP_SALT` from `openssl rand -base64 32`. Leave
   `OPERATOR_TOKEN_SHA256` empty unless you already have one.
2. The Worker serves `dist/`, which `bun run build` creates. In the Worker's settings under Builds, check that the
   build command runs `bun run build` before the deploy command runs. If the first deploy fails or the site is empty,
   this is the first thing to check.
3. Add `VK_ORIGIN`, `VK_PRODUCT`, `VK_CONTACT` (and `VK_REPO` if you will change code) as build variables of that
   Worker, then trigger a new build. Build variables are available only during the build, which is where these are
   read.
4. Edit `vars` in `wrangler.jsonc` in your copy of the repository, commit, and let the build run again.
5. Continue with [Custom domain](#custom-domain) and [Cloudflare zone settings](#cloudflare-zone-settings).

## Route B: manual

```bash
git clone https://github.com/areza-digital/one-time-secret-link
cd one-time-secret-link
git checkout <release commit>      # optional: deploy a commit you have looked at
bun install
```

1. Edit `wrangler.jsonc`: the Worker `name`, the `vars` above, `workers_dev` (see below) and, if you wish, the
   `ratelimits` ids.
2. Log in and deploy. `bun run deploy` runs the build, the unit tests and `wrangler deploy`:

   ```bash
   bunx wrangler login
   VK_ORIGIN=https://secret.example.com \
   VK_PRODUCT="Our secrets" \
   VK_CONTACT=abuse@example.com \
   bun run deploy
   ```

3. Set the secret:

   ```bash
   openssl rand -base64 32 | bunx wrangler secret put IP_SALT
   ```

   Until it is set, anonymous requests get a 500.

4. Open the `workers.dev` address that wrangler printed, create a one-time link, open it in a private window, click
   Show, and reload: the second view must say the link was already opened.

`workers_dev` is `true` in the shipped config, so the instance is also reachable at its `workers.dev` hostname. Set it to
`false` once your own domain works if you do not want a second address.

## Custom domain

The domain must be a zone on your Cloudflare account. Either use the dashboard (Workers & Pages, your Worker,
Settings, Domains & Routes, Add, Custom domain), or add this to `wrangler.jsonc` and deploy:

```jsonc
"routes": [{ "pattern": "secret.example.com", "custom_domain": true }]
```

Make sure `VK_ORIGIN` is that same origin, and redeploy so that canonical links and the sitemap match.

## Cloudflare zone settings

Do these on the zone that serves the hostname, before you announce the instance. The names are as Cloudflare calls them
at the time of writing; the dashboard moves things around.

- **Minimum TLS version: 1.2** (SSL/TLS, Edge Certificates). The pentest found TLS 1.0 and 1.1 still accepted on the
  hosted instance's zone until this was set.
- **Turn off JavaScript Detections, Rocket Loader, Email Obfuscation, Zaraz and Web Analytics auto-injection** for this
  hostname. They add scripts to pages. Inline ones are blocked by the CSP, but the CSP allows same-origin scripts, which
  includes anything served from `/cdn-cgi/`. A Configuration Rule can switch these off for just the hostname.
- Optionally add a rate limiting rule for `/api/*` in the zone as an extra layer. The CLI waits and retries once when
  it gets an HTML 429, which is what a zone rule returns.
- Leave HSTS to the Worker: it already sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

After the changes, run `bun run verify https://secret.example.com` (below). It fails if the home page references a script
outside `/assets/`.

## Operator token

An optional token that makes you the "verified" operator. Requests carrying it:

- create items marked "Verified: " followed by `VERIFIED_NAME`, without the warning shown on anonymous requests, and with labels
  that skip the anonymous label filter;
- skip the per-IP limits and the global cap;
- can take down any item (`vienkartine revoke <id> --admin`), which then shows visitors a "removed after an abuse
  report" message;
- can read the [daily totals](#daily-totals) (`vienkartine stats`).

The token cannot open or decrypt anything. The browser pages never send it; you use it with the CLI or any HTTP client
(`Authorization: Bearer <token>`).

Create it, and store only its SHA-256 on the server:

```bash
token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
printf %s "$token" | shasum -a 256 | cut -d' ' -f1 | bunx wrangler secret put OPERATOR_TOKEN_SHA256

mkdir -p ~/.config/vienkartine && chmod 700 ~/.config/vienkartine
(umask 077; printf 'VIENKARTINE_OPERATOR_TOKEN=%s\nVIENKARTINE_OPERATOR_URL=%s\n' "$token" "https://secret.example.com" \
  > ~/.config/vienkartine/operator.env)
unset token
```

(On Linux use `sha256sum` instead of `shasum -a 256`.) The token is 43 URL-safe characters. The CLI sends it only to
the URL stored next to it. Keep a copy in a password manager. To rotate, repeat the steps; the old token stops working
when the new hash is set.

## Daily totals

The Worker keeps one number per UTC day and kind, so you can see whether anyone uses the instance:

| Kind | Counted when |
|---|---|
| `send` | a one-time link was created |
| `request` | a request link was created |
| `fill` | a request was answered: each accepted answer, so after `vienkartine reject` the next answer counts again |
| `open` | a secret was handed out: a one-time link opened, or an answer to a request read (once per answer) |

- A counter is a day, a kind and a number. There is no IP address or hash of one, no item id, no label, no user agent
  or referrer, and no row per request. Refused actions (wrong key, already used, rate limited) are not counted.
- They live in the `RateLimiter` Durable Object class, in the one object named `stats`. The objects that hold hashed
  addresses are not touched, and nothing is added to `wrangler.jsonc`.
- 400 days are kept, today included. When a kind gets its first count of a day, counters older than that are deleted.
- Nothing waits for the count: the response does not, and if the write fails the request still succeeds and that day's
  number is one short. Each successful create, answer and read adds one Durable Object request for it.
- Read them with the operator token: `vienkartine stats [--days 30]` prints a table, and `GET /api/stats?days=30` with
  `Authorization: Bearer <token>` returns JSON, newest day first, with zeros for quiet days (1 to 400 days):

  ```json
  { "retentionDays": 400, "days": [{ "day": "2026-11-10", "send": 3, "request": 1, "fill": 1, "open": 2 }] }
  ```

  Without the token the route answers `404 {"error":"not_found"}`, like any path that does not exist. There is no public
  statistics page. Someone with access to your Cloudflare account can read the same numbers in the Durable Object data.
- The home page's answer to "What do you store about me?" says that the service counts how many links are created,
  answered and opened each day, as totals without any address or identifier. If a theme overrides that answer, keep
  that sentence: it is true of every instance that runs this code.

## Theming your instance

The default theme is neutral. To give your instance its own look and wording, write a theme and point `VK_THEME` at it:

```bash
VK_THEME=/path/to/my-theme VK_ORIGIN=https://secret.example.com bun run deploy
```

See [theming.md](theming.md). Themes never change the JavaScript, so `bun run verify` keeps working.

## Updating

```bash
git pull                  # or check out a newer release commit
bun install
# read CHANGELOG.md; note any new variables or migrations
VK_ORIGIN=... VK_CONTACT=... bun run deploy
bun run verify https://secret.example.com
```

Commit your local changes before you deploy. A deploy from a dirty checkout publishes a `-dirty` commit name, which
nobody can check out. If a release adds a Durable Object migration, wrangler applies it during the deploy.

## Verifying your deployment

From a clean checkout of the commit shown in the footer:

```bash
git checkout <commit>
bun install
bun run verify https://secret.example.com
```

See [threat-model.md](threat-model.md#what-bun-run-verify-checks) for what this does and does not prove. Run it after
every deploy and after every change to the zone settings.

## Plans and limits

The free Workers plan works for a private or low-traffic instance. The shipped rate limits keep any one address in
check, but a distributed attacker can exhaust the daily quotas of the free plan, and the instance then stops until the
quota resets. If the instance is public, use Workers Paid.

Limits built into the code: text up to 10,000 characters, ciphertext up to 48 KiB, labels up to 140 characters,
lifetimes of 1 hour to 7 days, 500 anonymous creates per hour for the whole instance.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The site is empty or shows a 404 for every page | `dist/` was not built before the deploy. Run `bun run build`, or fix the build command |
| Creating a link fails with a server error | `IP_SALT` is not set |
| Pages mention `example.com` or `abuse@example.com` | `VK_ORIGIN` or `VK_CONTACT` was not set at build time |
| Search engines index too much or too little | Check `INDEXABLE` in `wrangler.jsonc`, then rebuild so the pages follow it |
| `429` while testing | The per-minute limits (create 6, fill 10, open 20, read 60); wait a minute, or use the operator token |
| `verify` reports a script outside `/assets/` or a CSP that is not `'self'` | A zone feature or rule is modifying the pages; see the zone settings |
| Errors about quotas | You are on the free plan and have used the daily allowance |
