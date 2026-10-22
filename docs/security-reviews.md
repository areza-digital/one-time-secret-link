# Security reviews

Before the 0.2.0 release the code was reviewed internally and penetration-tested, and on 2026-10-22, when the
repository became public, it was checked again. This page lists every finding and what became of it. The two written
reports are in [reviews/](reviews/); the 2026-10-22 check is summarized in [SECURITY.md](../SECURITY.md#latest-check-2026-10-22).

| Report | Date | Kind |
|---|---|---|
| [security-2026-10-12.md](reviews/security-2026-10-12.md) | 2026-10-12 | Code review of the Worker, the shared code, the browser code, the page copy and the CLI, with local experiments |
| [security-2026-10-13-pentest.md](reviews/security-2026-10-13-pentest.md) | 2026-10-13 | Hands-on penetration test against a local Worker, the CLI and, read-only, the pilot deployment |
| [Below](#security-check-2026-10-22) and in [SECURITY.md](../SECURITY.md#latest-check-2026-10-22) | 2026-10-22 | Dependency audit, static analysis, secret scan of the history, manual review and probes against a local Worker, after the repository became public |

What this is and is not:

- Both were done by the project's own team. They are not an audit by an independent third party.
- The cryptography is age's, used through the `age-encryption` (typage) package. It was reviewed for correct use, not
  audited.
- The reports were written against the pre-release code, when the project was called Areza Secret and the CLI
  `azsecret`. File names and line numbers in them refer to that version; they are published as written, with local file
  paths and an audience remark removed.
- The statuses below were checked against the 0.2.0 source. A finding marked fixed has not necessarily been re-tested
  by the original reviewer. Where tests exist, they are in `test/unit.test.ts` and `scripts/e2e.ts`.
- 0.1.0 is the internal pilot; 0.2.0 is the first public release. See the [changelog](../CHANGELOG.md).

Status values:

| Status | Meaning |
|---|---|
| Fixed in 0.1.0 | Fixed in the pilot, after the first review |
| Fixed in 0.2.0 | Fixed in the public release, after the penetration test |
| Fixed in 0.3.0 | Fixed after the check of 2026-10-22 |
| Partly fixed | The main problem is fixed; a smaller part is still open and described |
| Mitigated | Made harder or less harmful; a residual risk is described |
| Accepted limit | Not changed. It is a design limit or a trade-off, documented in the [threat model](threat-model.md) |
| Operator setting | Depends on how the instance is deployed. In the [operator checklist](threat-model.md#operator-checklist) |

## Code review, 2026-10-12

Numbers and letters are the report's own. Findings 1 to 14 were confirmed in code or by experiment; A to F are
platform or deployment behavior the code alone could not prove.

| # | Finding | Severity | Status | How |
|---|---|---|---|---|
| 1 | The CLI sent the operator token (then called the owner token) to whatever host a pasted link named | High | Fixed in 0.1.0 | The token goes only to the configured instance over `https`; `open` refuses links on other hosts; redirects are refused. A follow-up, planted `.env` files, is pentest 1 |
| 2 | Anyone who sees a request link can answer it first, and the requester could not tell or recover | Medium | Mitigated | First answer wins by design. The conflict page shows when the earlier answer arrived; the requester can reject the answer and reopen the link in the browser and the CLI; `pull` prints the answer time. The env file backup was added in 0.2.0 (pentest 6) |
| 3 | No takedown path although the FAQ promised one; anonymous labels could be used for phishing and spoofing | Medium | Fixed in 0.1.0, completed in 0.2.0 | Operator takedown (`revoke --admin`) and a warning above anonymous labels in 0.1.0. The label filter was still bypassable; fixed in 0.2.0 (pentest 2), together with a distinct `removed` state and message (pentest 13) |
| 4 | Every request wrote to Durable Object storage, so one client or plain polling could use up the free-tier quota | Medium | Mitigated | The limiter stops writing over the limit; static files skip the Worker; polling backs off from 10 s to one check a minute; in 0.2.0 Rate Limiting bindings run before any Durable Object. Remaining: see pentest 3; also, a 429 during polling is not shown to the user, the page keeps retrying quietly |
| 5 | The per-IP limit was bypassed with IPv6, and the global cap was cheap to exhaust | Medium | Fixed in 0.1.0 | IPv6 addresses are keyed by /64; the global cap is hourly (500 anonymous creates), so exhaustion heals within an hour. A distributed attacker can still use the cap: pentest 3 |
| 6 | "Delete now" showed "deleted" when the link had already been read | Medium | Fixed in 0.1.0 | When the server answers `read`, the page fetches the item again and shows the read time |
| 7 | The CLI burned the secret before checking that it could save it | Medium | Fixed in 0.1.0 | The save target is validated before the open call; a value that cannot be saved goes to a 0600 recovery file and the exit code is 7 |
| 8 | Env-file quoting did not round-trip outside `sh`; leading and trailing spaces were trimmed; the first duplicate was used; inline comments were kept | Low | Partly fixed | Values are single-quoted; values with `'`, `$` or a line break are refused (control characters too, in 0.2.0); only one trailing newline is stripped; a test reads values back through `sh` and Bun's dotenv parser. `readEnvValue` (used by `send --from-env` and `push`) reads like `sh`: the last definition wins and an unquoted value ends at a ` #` comment (fixed in 0.2.0, see 13c) |
| 9 | `push` left old and new secrets readable and reported success on odd targets | Low | Partly fixed | Directory targets are refused; `--` precedes the host and the host pattern cannot start with `-`; the backup is mode 0600. Still open: an existing file keeps its mode on purpose (so the application can read it), the backup is kept, `cp` follows a symlink planted at the backup path, and the rewrite is not atomic |
| 10 | `writePrivate` used a predictable temp name and followed symlinks | Low | Fixed in 0.1.0 | Random temp name created exclusively with mode 0600, then renamed over the target |
| 11 | The CLI followed redirects and re-sent the auth body | Low | Fixed in 0.1.0 | `redirect: "error"` |
| 12 | `send` printed the link by default and `open` took it as an argument | Low | Fixed in 0.1.0 | `send` copies the link to the clipboard (macOS `pbcopy`); `--print` and `--out` are explicit; `open` reads stdin and the help recommends it. A link given as an argument is still accepted and ends up in shell history |
| 13 | The "intercepted" signal disappeared at expiry, and the holder of a link could make it look sender-deleted | Low | Fixed in 0.1.0 (revoke) and 0.2.0 (receipt) | A one-time link's own auth token can no longer revoke it; only the manage token can. A read item keeps its "opened at" record for 7 days (the report suggested 30) |
| 14 | `IP_SALT` fell back to a constant from the source | Low | Fixed in 0.1.0 | Anonymous API calls fail with a 500 until the secret is set |
| A | Workers Logs probably stored IPs next to item ids, contradicting the copy | Medium | Fixed in 0.1.0 | `observability.enabled` is `false` in `wrangler.jsonc`. An operator who turns logging on will log URLs with item ids |
| B | "Deleted" is not deleted at the storage layer: Durable Objects keep 30 days of point-in-time recovery | Medium | Accepted limit | Documented in the threat model and the FAQ. The ciphertext is useless without the key, and the link is the key, so links should not be left in mailboxes. The report's idea of a wrapping key outside the Durable Object was not adopted |
| C | Zone features of the host domain may inject code or cookies | Medium | Operator setting | The CSP blocks inline injected scripts and no cookie was set on the pilot. The operator checklist turns the features off, and `bun run verify` fails on scripts outside `/assets/`. See also pentest 9 |
| D | The code the server serves is the trust anchor | Low | Accepted limit | Mitigated by open source, `vk-commit`, `bun run verify` and Subresource Integrity (0.2.0). The report's fingerprint on request links was not adopted. See the threat model |
| E | The owner link sits in browser history for up to 7 days | Low | Accepted limit | By design: the link must keep working until the answer is read. Keep it in a password manager |
| F | Revealed plaintext stays in the DOM and can come back through the back/forward cache | Low | Fixed in 0.1.0 | Revealed text is cleared on `pagehide` |

## Penetration test, 2026-10-13

Numbers are the report's own. Item 13 in the report bundles several carry-overs, listed here as 13a to 13e.

| # | Finding | Severity | Status | How |
|---|---|---|---|---|
| 1 | A `.env` or `bunfig.toml` in the working directory takes over the CLI: it receives the operator token and the CLI prints an attacker's "safe to email" link | High (conditional) | Fixed in 0.2.0 | The CLI's shebang starts Bun with `--no-env-file --config=/dev/null`, and the operator token is pinned to its URL (`VIENKARTINE_OPERATOR_URL`) and sent only there. If you start the CLI without the shebang, pass the same flags yourself (see the README) |
| 2 | The anonymous-label filter is bypassable, so a request could show a fake "Verified" line as its headline | Medium | Fixed in 0.2.0 | Category-based stripping of invisible and format characters, lookalike folding, refusal of words that mix scripts, a symbol allowlist, whole-word phishing terms (PIN, Smart-ID, bank names), and anonymous labels shown as a quote under the warning. Unit tests reproduce the report's cases |
| 3 | Availability: a few IPs can take the public tool down for an hour, or the whole service until 00:00 UTC | Medium | Mitigated | Rate Limiting bindings run before any Durable Object; reads skip the Durable Object limiter when `RL_READ` is bound; the limiter stops writing over the limit. Remaining: on the free plan a distributed attacker can exhaust the daily quotas, and the global cap of 500 anonymous creates per hour can be kept used up. Public instances should use Workers Paid |
| 4 | The language switch put the key back after a reveal and raised a false "intercepted" alarm | Low | Fixed in 0.2.0 | The fragment is also removed from the language switch link |
| 5 | `/en/_app/*` page shells were served | Low | Fixed in 0.2.0 | The route check covers `/en/_app/` like `/_app/` |
| 6 | `pull` overwrote an env value without a backup, so rejecting an attacker's answer could not restore the earlier value | Low | Fixed in 0.2.0 | When `pull` or `open` replaces a value, the previous file is kept as `<file>.vienkartine.bak` (mode 0600). Residual: someone who watches the request link can answer again after each reject (see the threat model) |
| 7 | Control characters passed into env files | Low | Fixed in 0.2.0 | Values with control characters are refused; use `--raw FILE` |
| 8 | Production still accepted TLS 1.0 and 1.1 | Low | Operator setting | Set the zone's minimum TLS version to 1.2. In the operator checklist |
| 9 | `script-src 'self'` also allows same-origin `/cdn-cgi/` scripts, so zone injection was blocked only because the injected bootstrap was inline | Low | Mitigated, accepted limit | Subresource Integrity and Trusted Types cover our own scripts and the DOM sinks, but they do not stop an extra same-origin script. The mitigation is the operator checklist (turn the zone features off) and `bun run verify`, which fails on scripts outside `/assets/`. The CSP stays `script-src 'self'`; the report's path-scoping was not adopted |
| 10 | The request body was read in full before the size check | Low | Fixed in 0.2.0 | The body is read as a stream and refused above 64 KiB |
| 11 | A malformed URL fragment left the page on "loading" | Low | Fixed in 0.2.0 | The decode is wrapped in try/catch and the page shows the missing-key message |
| 12 | The fill page trusts the recipient key the API serves (the fingerprint gap), and non post-quantum recipients were accepted | Info | Fixed (post-quantum only), accepted limit (fingerprint) | The server accepts only `age1pq1...` recipients. Fingerprint pinning is not implemented: it would not help against a server that can also change the JavaScript, which is the same root cause as in the threat model |
| 13a | No receipt at expiry, so an interceptor's read disappeared with the item | Info | Fixed in 0.2.0 | A read item keeps its "opened at" record, without ciphertext, for 7 days |
| 13b | An admin takedown showed visitors "The requester cancelled this request" | Info | Fixed in 0.2.0 | A separate `removed` state with its own message |
| 13c | `readEnvValue` takes the first duplicate, trims the value and keeps an inline comment | Info | Fixed in 0.2.0 | The last definition wins, quotes are honoured and an unquoted value stops at a ` #` comment, as in `sh`. Tested in `test/unit.test.ts` ("reading env files like sh does"). This table said "Open" until 2026-10-22 |
| 13d | `push` keeps a 0644 file at 0644, keeps its backup, follows a symlink at the backup path and is not atomic | Info | Partly fixed | See review 9 |
| 13e | If the network drops after the server released the secret, the secret is gone | Info | Accepted limit | Inherent to read-once. The sender sends it again |

### What held up

The penetration test also recorded what it could not break:

- The server never received plaintext or an identity.
- Read-once, first-answer-wins, revoke and reopen stayed atomic under 40-way races.
- Nobody without the right token could open, revoke or reopen an item. The operator token can take down anything but
  cannot open anything.
- Input handling, CSRF and CORS checks, and the headers behaved as intended, and nothing was reflected into the pages.
- The browser code has no HTML sinks, no `eval` and no `postMessage`.

### The report's conditions for promoting the service

The penetration test said the service was safe to share publicly for what it promises, and named four conditions before
promoting it widely:

| Condition | Status |
|---|---|
| Fix label spoofing | Fixed in 0.2.0 (pentest 2) |
| Fix the CLI environment takeover | Fixed in 0.2.0 (pentest 1) |
| Decide on availability | Mitigated (pentest 3); use Workers Paid for public instances |
| Minimum TLS 1.2 and JavaScript Detections off, then path-scope `script-src` | Operator settings (pentest 8, 9); path-scoping not adopted |

## Security check, 2026-10-22

Tools, versions and the scope of the manual review are in [SECURITY.md](../SECURITY.md#latest-check-2026-10-22).
Numbers are this page's own.

| # | Finding | Severity | Status | How |
|---|---|---|---|---|
| 1 | The CLI's default instance (`VIENKARTINE_URL`), the README and SECURITY.md named a domain that does not serve this project. Whoever controls the default domain receives every request and one-time link made with the default settings, and serves the page that reads the key from the fragment | High | Fixed in 0.3.0 | The default and the documentation point at https://secret.areza.digital. The default may change only to a domain that serves this code |
| 2 | `request` and `send` used the item id from the server's answer as a state file name. A hostile instance answering `"id": "../../../x"` made the CLI write the request's private key (or a manage token) to any `*.json` path the user can write, replacing that file | Medium | Fixed in 0.3.0 | The id, the expiry and the manage token must match the protocol patterns before anything is written. A test runs the CLI against a fake instance |
| 3 | `bun run verify` could be passed by a tampered site: the script scan was case-sensitive and understood only double-quoted `src`, so `<SCRIPT src=…>`, `src='…'`, a bare value or an SVG `<script href>` went unseen; and only the home page was checked, not the app pages that decrypt secrets | Medium | Fixed in 0.3.0 | `scripts/scan-scripts.ts` matches tags and attributes without regard to case and refuses an href on a script. verify checks commit, CSP and scripts on `/`, `/en` and all six app pages, with a fresh id each run. A local server that injects a script passed the old version and fails the new one; unit tests cover each bypass |
| 4 | The CLI printed error codes and item states from the server unchanged, so a hostile instance could send terminal escape sequences (clear the screen, rewrite lines, or set the clipboard through OSC 52 where the terminal allows it) | Low | Fixed in 0.3.0 | Printed only when they are plain words, `?` otherwise. Tested against a fake instance |
| 5 | CI used movable action tags (`@v4`); Dependabot proposed new releases at once (Semgrep) | Low | Fixed in 0.3.0 | Actions pinned to commit SHAs; a 7-day Dependabot cooldown |
| 6 | Semgrep: non-literal `RegExp` from a variable name (3), an incomplete `replace` before HTML escaping, a constant `X-Frame-Options` | Info | False positive | The name is checked against `^[A-Za-z_][A-Za-z0-9_]*$` first; the text is escaped after the replace; the header value is a constant `DENY` |
| 7 | A hostile stylesheet can read secrets: CSS can match attribute values (an owner link or a language link carries the key after `#`) and probe rendered text. `verify` checks the JavaScript only | Low | Accepted limit | Same root cause as review D: whoever controls the deployment controls the page. Documented in the threat model. The hosted instance's theme is private, so its stylesheet cannot be reviewed from outside |
| 8 | The threat model said link scanners cannot burn a link because they do not send the fragment. A scanner that runs the page and clicks buttons would use it up | Info | Accepted limit, documentation fixed | The recipient sees that the link was already opened. Threat model corrected |
| 9 | The status of pentest 13c and review 8 still said `readEnvValue` was open, although 0.2.0 fixed and tested it | Info | Fixed in 0.3.0 (documentation) | Statuses above corrected |

What held up, checked again: one success out of 25 parallel opens and 25 parallel answers (three rounds each);
reopen racing an open left a consistent state; no CORS headers, preflights refused; bodies over 64 KiB refused;
errors carry only a short code; the browser code still has no HTML sinks; no dependency advisories; no secrets in the
history.

## Reporting new findings

See [SECURITY.md](../SECURITY.md).
