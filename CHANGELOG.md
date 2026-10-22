# Changelog

All notable changes to this project are listed here. The project follows [semantic versioning](https://semver.org).

## 0.3.0 (unreleased)

The security check of 2026-10-22 and the English name. Details of every finding are in
[docs/security-reviews.md](docs/security-reviews.md#security-check-2026-10-22).

### Naming

- In English the project is called **Areza Secret** again; the Lithuanian name stays **Vienkartinė nuoroda**. The
  repository, the CLI (`vienkartine`) and its `VIENKARTINE_*` variables keep their names.
- `SiteConfig.product` takes one name per language (`{ lt, en }`) as well as a single string.

### Security fixes

- The CLI's default instance is https://secret.areza.digital. The default and the documentation named a domain that
  does not serve this project (High).
- The CLI checks the item id, expiry and manage token in the server's answer before the id becomes a file name. A
  hostile instance could make it write a private key to any `*.json` path the user can write (Medium).
- `bun run verify` checks every `<script>` tag without regard to case (including SVG `<script href>`) on both landing
  pages and all six app pages; before, a tampered site could pass it (Medium).
- The CLI no longer prints control characters that a server sends in error codes or states (Low).
- CI actions are pinned to commit SHAs; Dependabot waits 7 days before proposing a release (Low).

### Added

- `PREVIEW_BOTS`: link-preview bots (for example `LinkedInBot`) may read the landing pages and the social image of an
  instance that is not indexable, so shared links get a preview card. The app pages and the API stay disallowed, and
  the pages keep their `noindex` tags.

### Documentation

- SECURITY.md records the 2026-10-22 check: tools, versions, findings and accepted risks. The README has a Security
  section.
- The threat model says what `verify` cannot prove: a hostile stylesheet can read secrets, and a link scanner that runs
  the page and clicks Show uses up a one-time link.
- Corrected statuses: `readEnvValue` (pentest 13c, review 8) was fixed in 0.2.0, not open.

## 0.2.0 (2026-10-13)

First public release. The code is open source under the MIT license, and the project is renamed from the internal
"Areza Secret" to "Vienkartinė nuoroda" ("one-time link").

### What the release contains

- **One-time links.** The browser generates an age post-quantum hybrid identity (ML-KEM-768 + X25519), encrypts the
  text and uploads only the armored ciphertext. The link is `/s/<id>#<identity>`; the fragment never reaches the
  server. Viewing the page does not burn the link: the reader clicks Show, which calls `POST /api/items/:id/open` and
  deletes the ciphertext atomically (one Durable Object per item).
- **Request links.** The requester's browser or CLI keeps the identity; the server stores the recipient key and label.
  `/r/<id>` is safe to email, the sender's browser encrypts to the recipient, and the requester reads the answer at
  `/o/<id>#<identity>` or with the CLI. Only post-quantum recipients (`age1pq1...`) are accepted.
- **Reject and reopen.** A requester can reject an answer (for example when someone else answered first) and the same
  link takes a new one. The sender sees when an earlier answer arrived.
- **Read receipts kept for 7 days.** After a read the "opened at" record stays for 7 days, without the ciphertext, so a
  later visitor can see the link was already opened.
- **Operator requests.** Requests carrying `Authorization: Bearer <operator token>` (the server stores only
  `OPERATOR_TOKEN_SHA256`) show "Verified:" followed by `VERIFIED_NAME`, skip the per-IP limits, and can take down any
  item. A taken-down item gets its own `removed` state with its own message.
- **Label hardening for anonymous requests.** Invisible and format characters are stripped by Unicode category;
  symbols and emoji are refused; words that mix Latin with Cyrillic, Greek, Armenian or Cherokee letters are refused;
  reserved words (`RESERVED_LABEL_WORDS`, with Lithuanian defaults) are matched after folding case, accents and
  lookalike letters. Anonymous labels are shown as a quoted message under a warning, never as the page headline.
- **Rate limiting in layers.** Workers Rate Limiting bindings per minute (create 6, fill 10, open 20, read 60 per IP
  key) run before any Durable Object. Then hourly Durable Object counters per daily-salted IP hash, with IPv6 grouped
  per /64: create 30, fill 30, open/revoke/reopen 60. A global cap allows 500 anonymous creates per hour. The limiter
  stops writing once a limit is exceeded. Raw IP addresses are never stored, Workers Logs are off, and the API fails
  closed when `IP_SALT` is missing.
- **Browser hardening.** CSP with `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`,
  `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, `require-trusted-types-for 'script'` and
  `trusted-types 'none'`. Subresource Integrity (sha384) on every script and the stylesheet. `Referrer-Policy:
  no-referrer`, HSTS, COOP, CORP, `nosniff` and `X-Frame-Options: DENY`. No third-party scripts, fonts, analytics or
  cookies. Secret fields have spellcheck and autocomplete off. Revealed text is cleared on `pagehide`, and the key is
  removed from the address bar after use.
- **Verifiability.** Every page carries `<meta name="vk-version">` and `<meta name="vk-commit">`, shown in the footer.
  `bun run verify <url>` rebuilds the JavaScript from the named commit and compares it byte for byte with the site,
  and checks the Subresource Integrity values and the CSP. Themes never change the JavaScript, so this works for any
  instance.
- **Themes.** `VK_THEME=<dir>` selects a theme (`theme.ts` default-exporting a `Theme`, see `site/theme.ts`). The
  default theme uses system fonts and Lucide icons and is configured with `VK_ORIGIN`, `VK_PRODUCT`, `VK_REPO` and
  `VK_CONTACT`. The hosted instance uses a private theme that is not part of this repository.
- **The `vienkartine` CLI.** `request`, `pull`, `reject`, `send`, `open`, `status`, `revoke` and `push`. Secrets are
  never printed; files are written atomically with mode 0600; the save target is checked before a secret is burned,
  and a value that cannot be saved goes to a 0600 recovery file; `pull` keeps the previous env file as
  `<file>.vienkartine.bak` when it replaces a value; env values containing `'`, `$`, line breaks or control
  characters are refused (use `--raw`); the shebang runs Bun with `--no-env-file --config=/dev/null`; the operator
  token is pinned to its URL; the CLI uses `https` only, refuses redirects and refuses links on other hosts.
- **Self-hosting on Cloudflare Workers.** A Deploy to Cloudflare button, and a guide in `docs/self-hosting.md`.
- **Documentation and project files.** Threat model, theming guide, security reviews and their status, security
  policy, contributing guide, continuous integration, Dependabot and issue and pull request templates.

### Changed since the 0.1.0 pilot

- Renamed: the product is "Vienkartinė nuoroda", the CLI `azsecret` is now `vienkartine`, its environment variables
  `AREZA_SECRET_*` are now `VIENKARTINE_*`, and the owner token is now the operator token
  (`OPERATOR_TOKEN_SHA256`).
- The domain-separation label in the auth token derivation changed from `areza-secret/v1/auth` to
  `vienkartine/v1/auth`, so links and requests created by the 0.1.0 pilot do not work with 0.2.0.
- A read item keeps its "opened at" receipt for 7 days. In the pilot it was deleted at the original expiry.

### Security fixes since the 0.1.0 pilot

From the hands-on penetration test of 2026-10-13. Details and status of every finding are in
[docs/security-reviews.md](docs/security-reviews.md).

- The CLI could be taken over by a `.env` or `bunfig.toml` in the working directory. Fixed with the shebang flags and
  by pinning the operator token to its URL.
- Anonymous labels could spoof the operator's badge with look-alike letters and invisible characters. Fixed as
  described above.
- Reduced the free-plan quota risk with the rate-limiting layer and by not writing counters over the limit.
- The language switch put the key back into the link after a reveal. Fixed.
- `/en/_app/*` shells were served. Now they return 404 like `/_app/*`.
- `pull` could overwrite an env value without a backup. It now keeps `<file>.vienkartine.bak`.
- Control characters could be written into env files. Now refused.
- The request body was read in full before the size check. It is now read as a stream with a 64 KiB cap.
- A malformed fragment left the page on "loading". Now shows the missing-key message.
- Requests with a classic (non post-quantum) recipient key are refused.
- The read receipt no longer disappears at expiry, and taken-down items show a distinct message.

## 0.1.0 (2026-10-12)

Internal pilot, run by Areza Digital at https://secret.areza.digital under the name "Areza Secret". Not a public
release.

- One-time links and request links with browser-side age encryption, read-once deletion, and a per-IP rate limit with
  a daily-salted IP hash.
- A "Verified" badge for items created with an operator token, and a phishing warning on anonymous requests.
- The `azsecret` CLI.
- Hardened before the pilot went live after the code review of 2026-10-12 (see
  [docs/security-reviews.md](docs/security-reviews.md)): the CLI sends the operator token only to the configured
  `https` host and refuses redirects and foreign links; the save target is checked before a secret is burned; env
  values are single-quoted; requesters can reject a wrong answer and reopen the link; only a one-time link's creator
  can revoke it; the operator token can take down any item; IPv6 limits per /64; an hourly global cap; the limiter
  stops writing over the limit; static files skip the Worker; Workers Logs off; polling backs off to once a minute;
  revealed secrets are cleared on page hide.
