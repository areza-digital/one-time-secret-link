# Threat model

This document describes version 0.2.0. It says what the system protects, against whom, how, and where the protection
stops. Where a claim depends on code, the file is named so you can check it. If you find a mistake, see
[SECURITY.md](../SECURITY.md) for vulnerabilities, or open an issue for wording problems.

Contents: [Assets](#assets) · [Actors](#actors) · [What the server stores and sees](#what-the-server-stores-and-sees) ·
[Guarantees](#guarantees) · [Mitigations](#mitigations) · [Known limits](#known-limits) ·
[Out of scope](#out-of-scope) · [Verification](#what-bun-run-verify-checks) · [Server interface](#server-interface) ·
[Operator checklist](#operator-checklist)

## Assets

| Asset | Where it lives | Who may read or change it |
|---|---|---|
| Secret text (plaintext) | The sender's browser or CLI, then the recipient's browser or CLI | Sender and recipient only |
| age identity (private key) | In the URL fragment of the one-time link (`/s/<id>#...`) or owner link (`/o/<id>#...`); in browser memory; for CLI requests in `VIENKARTINE_HOME/requests/<id>.json` | Whoever holds the link or file |
| Ciphertext | The server, until the item is read, revoked, removed or expired | Server (cannot decrypt) |
| Auth token, derived from the identity | Browser or CLI; the server sees it on create and on open/reopen/revoke, and stores only its SHA-256 | Holder of the identity |
| Manage token (one-time links only) | Returned once at creation to the creator's browser or CLI (`VIENKARTINE_HOME/sent/<id>.json`); the server stores only its SHA-256 | Creator of the link |
| Operator token | The operator's machine; the server stores only its SHA-256 (`OPERATOR_TOKEN_SHA256`) | Operator |
| Request label and recipient (public) key | Server; returned to anyone who knows the item id | Public by design |
| Item state and times (open, filled, read, revoked, removed; created, filled, read) | Server; returned to anyone who knows the item id | Public by design |
| The JavaScript the page runs | Served by the deployment | Whoever controls the deployment (see [Known limits](#known-limits)) |
| What the page tells the user: labels, the "Verified" badge, "opened at" receipts | Rendered from server data | Must not be spoofable by an anonymous user |
| Availability | Cloudflare quotas and the rate limits | Everyone |
| The host's reputation | The domain | Operator |

## Actors

| Actor | What they can do |
|---|---|
| Sender, recipient, requester, answerer | Use the tool as intended |
| Link interceptor | Has obtained a link (mailbox, chat history, a forwarded message, a link scanner log). For one-time links the link includes the key |
| Network attacker | Can observe or alter traffic outside TLS. Cannot break TLS |
| Anonymous abuser or phisher | Creates items and request labels of their choice, without an account |
| Denial-of-service attacker | Sends many requests, possibly from many addresses |
| Deployment controller | The operator, or anyone with deploy rights on the Worker or the Cloudflare account, or anyone able to change what the edge serves. Can change the code and the stored data |
| Cloudflare as the platform | Terminates TLS, runs the Worker and stores Durable Object data |
| Zone feature injection | Cloudflare features on the operator's zone (JavaScript Detections, Rocket Loader, Email Obfuscation, Zaraz, Web Analytics auto-injection) that add scripts to pages |
| Local attacker on the CLI user's machine | Can plant files such as `.env` or `bunfig.toml` in a directory where the CLI is run, or read files the user can read |
| Supply chain | A malicious or compromised dependency or build tool |

## What the server stores and sees

Per item, in a Durable Object (`src/worker/box.ts`, one object per item):

| Field | Notes |
|---|---|
| id, kind (`send` or `request`), state | State is `open`, `filled`, `read`, `revoked` or `removed` |
| verified flag | True when the item was created with the operator token |
| label | Requests only. Stored and returned in plaintext. **Do not put secrets in a label** |
| recipient | Requests only. The public key. Returned only while the request is open |
| ciphertext | Until the item is read, revoked or removed, or expires |
| SHA-256 of the auth token | The token itself is not stored |
| SHA-256 of the manage token | One-time links only |
| createdAt, expiresAt, filledAt, readAt, retainUntil | After a read, the record (without ciphertext) is kept for 7 days, or until the original expiry if that is later |

The ciphertext length is visible. age does not pad, so the length approximates the plaintext length.

Per request, transiently: the client IP (`CF-Connecting-IP`), headers, the auth or manage token being presented, and the
`Origin` header. The code uses the IP only to compute the rate-limit key and stores none of the other headers.

Rate limiting (`src/worker/limiter.ts`, `src/worker/ip.ts`): one Durable Object per key
`SHA-256(IP_SALT | UTC date | IP)`, where IPv6 addresses are first reduced to their /64. It holds hourly counters,
removed by an alarm after their window ends. One more object, `global`, counts anonymous creates per hour. The hash is
pseudonymous, not anonymous: whoever holds `IP_SALT` can recompute it for a known address. Raw IP addresses are not
stored.

Never sent to the server: the plaintext, the identity, and the URL fragment.

Logging: Workers Logs are off in the shipped `wrangler.jsonc` (`observability.enabled` is `false`). An operator who turns
logging on will log URLs that contain item ids.

Browser storage: the page stores only the light/dark choice, in `localStorage` under `theme`. It sets no cookies.

Cloudflare, as the platform, sees the traffic it carries: IP addresses, URLs (never fragments), headers, ciphertext and
timing, and anything the operator's zone settings add.

## Guarantees

These hold **when the JavaScript your browser runs is the code in this repository** (see
[Whoever controls the deployment controls the JavaScript](#whoever-controls-the-deployment-controls-the-javascript)).

1. **The server cannot read what is shared.** Text is encrypted in the browser (or CLI) with age to a fresh
   post-quantum hybrid key (ML-KEM-768 + X25519). The server receives ciphertext. For one-time links it never learns
   the key, which stays in the fragment. For requests the private key never leaves the requester.
2. **The key is not sent anywhere by the browser.** Browsers do not send URL fragments in requests. The pages send
   `Referrer-Policy: no-referrer`, so the fragment does not leak through a Referer header either.
3. **Loading a page does not burn a link.** `GET /api/items/:id` returns metadata only. The ciphertext is released by
   `POST /api/items/:id/open`, which the page calls when the reader clicks Show.
4. **Read once.** The open operation runs inside the item's Durable Object, which handles one request at a time. It
   checks the state and, in one storage write, marks the item read and removes the ciphertext before returning it. A
   second open gets `409`. Under 40-way races in the 2026-10-13 pentest exactly one open succeeded every time.
5. **Only the right token can act.** Opening and reopening need the auth token, which only the holder of the identity
   can derive. Revoking a one-time link needs the manage token held by its creator (the link's own auth token is
   refused). Revoking a request needs the requester's auth token. Only the operator token can take down any item, and it
   cannot open anything. Token comparisons are constant-time.
6. **Expiry deletes.** An alarm deletes the item at its expiry time (1 hour to 7 days after creation). A read leaves a
   receipt without ciphertext for 7 days so that a second visitor can see when the link was opened.
7. **Anonymous users cannot pose as the operator.** The "Verified" badge and operator privileges require the operator
   token. Anonymous request labels are filtered and shown as a quoted message under a warning.
8. **Request answers are visible and reversible.** The first answer wins. The sender sees the time of an earlier
   answer, the requester sees when the answer came in, and the requester can reject it so that the same link takes a
   new one.

## Mitigations

| Threat | Mitigation | Where |
|---|---|---|
| Server or database reader learns the secret | Client-side age encryption; key in the fragment; the server stores ciphertext and token hashes | `src/shared/crypto.ts`, `src/web/app.ts`, `src/worker/box.ts` |
| Database reader opens or revokes items | Only SHA-256 of the auth and manage tokens is stored; the tokens are 256-bit | `src/worker/index.ts`, `src/worker/box.ts` |
| Timing attack on token checks | `crypto.subtle.timingSafeEqual` | `src/worker/box.ts`, `src/worker/index.ts` |
| Two readers get the secret | One Durable Object per item, atomic open | `src/worker/box.ts` |
| Link scanners or previews burn the link | Opening needs an explicit click and a token derived from the fragment, which scanners do not send | `src/web/app.ts` |
| Cross-site request forgery | No cookies or ambient credentials; `fetch` uses `credentials: "omit"`; POSTs need `Content-Type: application/json`; a mismatching `Origin` is refused with 403 | `src/worker/index.ts` |
| Cross-site scripting | The app code builds the page from text nodes and has no HTML sinks; CSP `script-src 'self'` with no inline scripts; `require-trusted-types-for 'script'` and `trusted-types 'none'`; labels are rendered as text | `src/web/app.ts`, `src/worker/csp.ts` |
| Tampered script or stylesheet files | Subresource Integrity (sha384) on every script and the stylesheet; content-hashed file names; no third-party scripts, fonts or analytics | `site/build.ts` |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | `src/worker/csp.ts`, `src/worker/index.ts` |
| Secret kept in cache or history | API and app pages are `Cache-Control: no-store`; revealed text is cleared on `pagehide`; the key is removed from the address bar and from the language link after a reveal | `src/worker/index.ts`, `src/web/app.ts` |
| Secret fields leak to autofill or spellcheck | `autocomplete="off"` and `spellcheck="false"` on secret fields | `site/build.ts`, `src/web/app.ts` |
| Downgrade to a classic key on requests | Only post-quantum recipients (`age1pq1...`) are accepted | `src/shared/protocol.ts` |
| Phishing through request labels | Invisible and format characters stripped (categories Cf, Cc, Co, Cs, plus joiners, fillers and variation selectors); symbols and emoji refused; words mixing Latin with Cyrillic, Greek, Armenian or Cherokee letters refused; reserved words matched after folding case, accents and lookalike letters; anonymous labels shown as a quote under a warning | `src/shared/protocol.ts`, `src/web/app.ts` |
| Someone else answers a request first | The 409 page shows when it was answered; the requester sees the answer time and can reject it; the CLI prints the answer time | `src/worker/box.ts`, `src/web/app.ts`, `cli/vienkartine.ts` |
| Abuse and flooding | Workers Rate Limiting bindings per minute (create 6, fill 10, open 20, read 60 per IP key) run before any Durable Object is touched; then hourly Durable Object counters per IP hash (create 30, fill 30, open/revoke/reopen 60); a global cap of 500 anonymous creates per hour; the limiter stops writing once a limit is exceeded; static files skip the Worker | `src/worker/index.ts`, `src/worker/limiter.ts`, `wrangler.jsonc` |
| Oversized or malformed requests | Body read as a stream with a 64 KiB cap; ciphertext at most 48 KiB; text at most 10,000 characters; strict id, token, TTL and armor checks | `src/worker/index.ts`, `src/shared/protocol.ts` |
| Abuse of the operator's reputation | Operator takedown (`revoke --admin`) puts an item in the `removed` state with its own message | `src/worker/box.ts`, `src/web/app.ts` |
| Missing salt weakens IP hashes | The API fails closed: anonymous requests get 500 until `IP_SALT` is set | `src/worker/index.ts` |
| CLI: planted `.env` or `bunfig.toml` | The shebang starts Bun with `--no-env-file --config=/dev/null`; the operator token is sent only to the URL it is pinned to | `cli/vienkartine.ts` |
| CLI: token or key sent to the wrong host | `https` only (or localhost); redirects refused; links on other hosts refused; operator token pinned to its URL | `cli/vienkartine.ts` |
| CLI: secret burned but lost | Target checked before the open call; a failed save keeps the value in a 0600 recovery file | `cli/vienkartine.ts` |
| CLI: secrets written unsafely | Atomic 0600 writes with random temp names; env values with `'`, `$`, line breaks or control characters refused; the previous file kept as `.vienkartine.bak`; secrets never printed | `cli/vienkartine.ts` |
| Supply chain | One runtime dependency, `age-encryption` 0.3.1 (pinned), with its `@noble/*` and `@scure/base` dependencies; `bun.lock` committed; CI installs with `--frozen-lockfile`; Dependabot is configured | `package.json`, `.github/` |

## Known limits

These are the places where the protection stops. Some are fundamental to the design, some are accepted trade-offs.

### Whoever controls the deployment controls the JavaScript

The browser runs whatever JavaScript the server sends. An operator, a person with deploy rights on the Worker or the
Cloudflare account, or anyone who can change what the edge serves can ship code that sends the plaintext or the
fragment elsewhere. Nothing in the browser can prevent that.

What reduces it: the code is open source; every page names its commit (`vk-commit`); `bun run verify` rebuilds the
JavaScript and compares it with the served files; Subresource Integrity and the CSP keep the page from loading
anything else. What remains: verification is something a person has to do, it is a point-in-time check from one
vantage point, and nothing alerts users when the code changes. There is no browser extension or pinning mechanism.
Trust the operator accordingly, or run your own instance.

### Request links depend on the server returning the right public key

For a request, the sender's browser encrypts to the recipient key that the server returns. A malicious server could
return its own key. This has the same root cause as the previous limit: such a server could equally ship bad
JavaScript. There is no fingerprint pinning on request links. **One-time links are not affected by this attack,**
because the server never learns their key.

### Whoever gets a one-time link first can open it

The link is the secret. Send it only to the recipient. If someone else opens it first, the real recipient sees that it
was already opened (while the 7-day receipt exists) and can tell the sender. The sender sees when it was opened on the
page they created it from, if that page is still open, and with `vienkartine status` for links made from the CLI. If the sender revokes a link that was already read, the page says so, and the credential must be rotated.

### Anyone with a request link can answer it first

The `/r/<id>` link holds no secret, so it is safe to email, but anyone who sees it can answer before the intended
person. The requester should confirm the answer time with the sender over another channel, and reject the answer if it
is not theirs. A person who watches the link can answer again after every reject. When the CLI replaces a value in an
env file it keeps the previous file as `<file>.vienkartine.bak`.

### Anyone can create a request

Anonymous requests carry a label chosen by the creator. The label filter is a heuristic, not a guarantee. It reduces
spoofing of the operator and of well-known brands, but it cannot recognize every phishing text. The page puts a
warning above the label and shows it as a quote. Operators should add their own brand and local bank names to
`RESERVED_LABEL_WORDS`. The defaults are Lithuanian-market oriented.

### The owner link stays in the browser

The owner link (`/o/<id>#<identity>`) must keep working until the answer is read, so the page does not remove the key
from the address bar before then. Browser history, sync and extensions with history access may see it. Keep it in a
password manager.

### Cloudflare zone features can inject scripts

Features such as JavaScript Detections, Rocket Loader, Email Obfuscation, Zaraz and Web Analytics auto-injection add
scripts to pages. The CSP blocks inline scripts, so an injected inline bootstrap does not run. But `script-src 'self'`
also allows same-origin scripts under `/cdn-cgi/`, which some of these features use. Turn them off for the hostname
(see the [operator checklist](#operator-checklist)). `bun run verify` fails if the home page references any script
outside `/assets/`.

### Deleted data can be restored for 30 days

Durable Objects with SQLite storage keep 30 days of point-in-time recovery. Someone with the right access on the
Cloudflare account could restore an item to its state before it was read. The restored ciphertext is useless without
the key, but if the one-time link itself is still in a mailbox or chat history, it contains the key. Treat the link as
the secret, do not leave it lying in a conversation, and rotate a credential that matters if you do not trust everyone
with access to the account.

### Quota exhaustion on the free plan

The rate limits keep one address from using much, but a distributed attacker can use up the Workers and Durable
Objects daily quotas of the free plan. The service then stops until the quota resets. Anonymous creation can also be
kept down by staying under the per-address limits across many addresses, because the global cap of 500 creates per
hour is shared. Public instances should use Workers Paid, where this becomes a cost instead of an outage.

### Other limits

- **A lost response loses the secret.** The ciphertext is removed when it is released. If the network drops after the
  server has done so, the secret is gone and the sender must send it again. A retry shows the item as already opened.
- **Receipts last 7 days.** After that, a read leaves no trace.
- **A malicious server can delete, burn or hide items.** It cannot read them, but it sees the auth token when an item
  is created and could use it.
- **Metadata is visible** to the server and to Cloudflare: times, sizes, IP addresses in transit, and the existence of
  items.
- **The CLI keeps private keys on disk.** Pending requests are stored as plaintext JSON (mode 0600) in
  `VIENKARTINE_HOME/requests/`, manage tokens in `sent/`, and values that could not be saved in `recovered/`. By
  default the CLI puts a one-time link on the clipboard (macOS `pbcopy`), where clipboard managers may keep it.
- **The operator token is a bearer secret.** Anyone who has it can create "Verified" requests, skip the per-IP limits
  and take down items. It cannot open or decrypt anything. Rotate it by changing `OPERATOR_TOKEN_SHA256`.
- **The cryptography is age's.** The project uses age through the `age-encryption` (typage) package and did not audit
  it. The post-quantum hybrid recipient type is newer than classic age keys.
- **Trusted Types enforcement depends on the browser.** The directive is in the CSP, and the app code uses none of
  the sinks it restricts, so the page does not depend on enforcement.
- **Text only.** There are no file uploads and no accounts. Text is limited to 10,000 characters.

## Out of scope

- A compromised device: malware, hostile browser extensions with access to the page, screen capture, shoulder
  surfing. Once the secret is on the recipient's screen, the tool cannot protect it.
- Physical access to a user's machine.
- The security of Cloudflare's platform itself.
- Content moderation of encrypted text, which the server cannot see.
- Legal or compliance claims. The project makes none. Note only that IP hashes are pseudonymous, not anonymous.

## What `bun run verify` checks

`scripts/verify.ts` fetches the home page of an instance and reads `vk-commit`. After you check out that commit, it:

1. checks that the CSP `script-src` is exactly `'self'`, and warns if `require-trusted-types-for 'script'` is missing;
2. fails if the page references a script from outside `/assets/`, and warns about inline scripts that are not JSON data;
3. checks that your checkout matches the commit (and warns about a `-dirty` site, a dirty checkout, or a different Bun
   version);
4. rebuilds the JavaScript into a temporary directory and, for every script the page references, checks that the
   `integrity` attribute matches the served file, that a file with the same content-hashed name was produced by your
   build, and that its bytes are identical.

It does **not** check: the HTML or the CSS (a theme controls these, so a hostile theme could restyle the page
misleadingly); the page copy shipped as JSON in the HTML; pages other than the home page; what other visitors, or you
at another time, are served; the Worker code behind the API. A match proves that the scripts served to this request
are the scripts of that commit. The JavaScript does not depend on the theme, so the check works for any instance.

## Server interface

All paths are under `/api/items`. POST bodies must be JSON (`Content-Type: application/json`) of at most 64 KiB, and a
present `Origin` header must match the request origin.

| Request | Body | Needs | Result |
|---|---|---|---|
| `GET /api/items/:id` | none | read rate limit | Public metadata: id, kind, state, verified, verifiedName, label, recipient (only while a request is open), createdAt, expiresAt, filledAt, readAt. Never ciphertext or hashes |
| `POST /api/items` with `kind: "send"` | `ciphertext`, `ttl`, `auth` | create limits | `201` with `id`, `expiresAt`, `manageToken` |
| `POST /api/items` with `kind: "request"` | `recipient`, `label`, `ttl`, `auth` | create limits; label rules unless operator | `201` with `id`, `expiresAt` |
| `POST /api/items/:id/fill` | `ciphertext` | fill limits | `200` with `filledAt`; `409` if the request is not open |
| `POST /api/items/:id/open` | `auth` | open limits; the auth token | `200` with `ciphertext`, once; `403` wrong token; `409` already used |
| `POST /api/items/:id/reopen` | `auth` | open limits; the requester's auth token | `200` with state `open`; discards the answer |
| `POST /api/items/:id/revoke` | `manageToken` (one-time link), `auth` (request), or `admin: true` | the matching token, or the operator token for `admin` | `200` with the new state (`revoked`, `removed`, or `read` if it was already read) |

`ttl` is an integer number of seconds from 3600 to 604800. Ids are 22 URL-safe characters; tokens are 43. Unknown or
expired items return `404`; rate limiting returns `429`.

## Operator checklist

Before you run a public instance. The [self-hosting guide](self-hosting.md) has the commands.

**Worker**

- [ ] `IP_SALT` is set as a secret, from `openssl rand -base64 32`, and never committed.
- [ ] Use Workers Paid if the instance is public.
- [ ] `VERIFIED_NAME`, `INDEXABLE` and `RESERVED_LABEL_WORDS` are set in `wrangler.jsonc` (not only in the dashboard),
      so that the pages and the Worker agree. `RESERVED_LABEL_WORDS` replaces the defaults when it is not empty: include
      your brand and local banks.
- [ ] Workers Logs stay off (`observability.enabled: false`), or you accept that URLs with item ids and request headers
      are logged.
- [ ] You know whether you want the `workers.dev` address to stay reachable (`workers_dev` in `wrangler.jsonc`).

**Cloudflare zone**

- [ ] Minimum TLS version is 1.2.
- [ ] JavaScript Detections, Rocket Loader, Email Obfuscation, Zaraz and Web Analytics auto-injection are off for the
      hostname (a Configuration Rule can scope them to the hostname).
- [ ] No unrelated Workers, Page Rules or Transform Rules modify responses of this hostname.

**Account**

- [ ] Two-factor authentication is on, API tokens are scoped, and the list of people who can deploy or edit Durable
      Object data is short. They can change the code and the data.
- [ ] Deploys come from a clean checkout of a commit you can name, so that `vk-commit` has no `-dirty` suffix.

**Operations**

- [ ] The contact address (`VK_CONTACT`) is monitored. Abuse reports arrive there; take items down with
      `vienkartine revoke <id> --admin`.
- [ ] The operator token is generated, only its SHA-256 is stored on the server, and the token itself is kept in a
      password manager or a 0600 file.
- [ ] After every deploy, run `bun run verify https://your.host` from a checkout of the commit shown in the footer.
- [ ] Update regularly: read the [changelog](../CHANGELOG.md), `git pull`, `bun install`, deploy, verify.
- [ ] Your page copy (if you override it in a theme) still describes what your deployment does, for example if you
      turn logging on.

## Reviews

The code was reviewed internally and penetration-tested before the 0.2.0 release. The status of every finding is in
[security-reviews.md](security-reviews.md). Report new findings as described in [SECURITY.md](../SECURITY.md).
