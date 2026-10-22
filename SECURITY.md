# Security policy

Areza Secret (in Lithuanian, Vienkartinė nuoroda) exists to move secrets safely, so security reports are welcome and
taken seriously.

Contents: [Reporting a vulnerability](#reporting-a-vulnerability) · [What to expect](#what-to-expect) ·
[Scope](#scope) · [Safe harbor](#safe-harbor) · [Latest check: 2026-10-22](#latest-check-2026-10-22) ·
[Background](#background)

## Reporting a vulnerability

Please report privately. Do not open a public issue or pull request for a vulnerability.

1. **GitHub private vulnerability reporting.** On the repository page, open the Security tab and choose "Report a
   vulnerability". This is the preferred route: it keeps the report, the discussion and any fix together.
2. **Email** [hello@areza.digital](mailto:hello@areza.digital) with the subject "vienkartine security". We do not
   publish an encryption key. Keep the first email short (what and where, no exploit details) if you prefer, and we
   will agree a safe way to exchange the rest.

Until GitHub reporting is switched on for this repository, email is the way to reach us: hello@areza.digital.

If you are not sure whether something is a vulnerability, report it anyway.

### What to include

- What is affected: the code in this repository (file, function or endpoint), the CLI, or the hosted instance.
- The version and commit. Every page shows both in the footer and in `<meta name="vk-version">` and
  `<meta name="vk-commit">`.
- What an attacker needs (access, a link, a position on the network) and what they gain.
- Steps to reproduce, or a proof of concept. A short script or a request/response pair is ideal.
- The browser, operating system and Bun version if the issue is client-side.
- Any ideas for a fix, and whether you would like to be credited.

Please do not include real secrets or other people's data in a report.

## What to expect

- We acknowledge your report within 3 working days.
- After that we assess it, tell you whether we consider it a vulnerability, and keep you informed while we work on a
  fix. We aim to agree a disclosure date with you; please do not publish details before then.
- Fixes land in the repository and in the [changelog](CHANGELOG.md). We credit reporters who want credit.

## Scope

In scope:

- The code in this repository: the Worker (`src/worker/`), the browser code (`src/web/`), the shared protocol and
  cryptography wrapper (`src/shared/`), the site generator (`site/`), the default theme, the CLI (`cli/`) and the
  scripts.
- The deployment of the hosted instance at https://secret.areza.digital: its configuration, response headers and
  behavior of the code it runs.
- Documentation that misstates a security property.

Out of scope:

- Vulnerabilities in the Cloudflare platform itself. Report those to Cloudflare.
- Social engineering or phishing of maintainers or users, and physical attacks.
- Volumetric denial of service and load testing against the hosted instance. (A request that exhausts a resource with
  a small number of requests, for example through a flaw in the rate limiter, is in scope.)
- Instances run by other people. Report problems in their deployment to their operators. A flaw in this code that
  affects them is in scope here.
- The limits that the [threat model](docs/threat-model.md) documents as design limits, for example that whoever controls
  a deployment controls the JavaScript it serves, or that whoever gets a one-time link first can open it. We welcome
  corrections to that analysis, and ways to narrow those limits.
- Findings that need a compromised device or browser, and automated scanner output without a demonstrated impact.

## Safe harbor

We consider good-faith security research that follows this policy to be authorized, and we will not take legal action
against you or ask others to. To stay within it:

- Test on your own local instance (`bun run dev`) where you can. On the hosted instance, use only items you created
  yourself and stay well inside the rate limits.
- Do not read, change or delete other people's items, and do not try to guess ids or tokens at scale.
- If you come across a real secret or personal data, stop, do not keep or share it, and tell us.
- Do not degrade the service for others: no flooding, no resource exhaustion.
- Give us a reasonable time to fix the problem before you disclose it.

This policy does not authorize attacks on Cloudflare or other third parties, and we cannot speak for them.

## Latest check: 2026-10-22

On 2026-10-22, the day the repository became public, the project's own team checked the 0.2.0 code (commit
`7e0baa9`) again with the tools below and a manual review. It is not an independent audit. Every finding and its
status is also listed in [docs/security-reviews.md](docs/security-reviews.md#security-check-2026-10-22).

| Tool | Version | What it covered | Result |
|---|---|---|---|
| `bun audit` | Bun 1.4.2 | All 124 locked packages, 6 of them shipped at runtime | No known vulnerabilities |
| GitHub Advisory Database | queried on the day | `age-encryption`, `@noble/*`, `@scure/base`, `wrangler`, `miniflare`, `undici`, `esbuild` | No advisory affects the locked versions |
| Semgrep | 1.182.1 | Rulesets `p/default`, `p/javascript`, `p/typescript`, `p/security-audit` and `p/secrets`: 253 rules on 47 tracked files | 9 results: 4 fixed (CI), 5 false positives |
| gitleaks | 8.30.1 | Full git history of all branches, and the working tree | No leaks |
| TruffleHog | 3.95.2 | Full git history, verified and unverified results | None |

The manual review covered the cryptography (key generation, age encryption, the key in the URL fragment), the
read-once guarantee (races, deletion after a read, expiry), request links, the fill flow and the operator token, rate
limits, the CSP and other headers, cross-site scripting, CORS, error messages, `bun run verify`, and the CLI's
handling of files and server answers. Probes against a local Worker confirmed that 25 parallel opens of one link, and
25 parallel answers to one request, succeed exactly once (three rounds each); that the API sends no CORS headers and
refuses preflights; that bodies over 64 KiB are refused; and that errors carry only a short code.

### Fixed in 0.3.0

| Finding | Severity | Fix |
|---|---|---|
| The CLI's default instance, and the README and this policy, named a domain that does not serve this project. Whoever controls the default domain receives every request and one-time link made with the default settings, and serves the page that reads the key | High | The default and the documentation point at https://secret.areza.digital |
| The CLI used the item id that the server returned as a file name. A hostile instance could make it write a request's private key to any `*.json` path the user can write | Medium | The id, the expiry and the manage token are checked before anything is written |
| `bun run verify` did not see `<SCRIPT>` in capitals, a single-quoted or bare `src`, or an SVG `<script href>`, and it checked only the home page, not the pages that decrypt secrets | Medium | Every script tag is checked without regard to case, on both landing pages and all six app pages |
| The CLI printed error codes and states from the server unchanged, so a hostile instance could send terminal escape sequences (for example to rewrite the clipboard) | Low | They are printed only if they are plain words |
| CI used movable action tags, and Dependabot proposed releases on the day they came out | Low | Actions pinned to commit SHAs; a 7-day cooldown |

### Accepted risks

New or restated on 2026-10-22. The full list of known limits is in the
[threat model](docs/threat-model.md#known-limits).

- **A hostile stylesheet can read secrets.** `bun run verify` proves the JavaScript, not the HTML or the CSS, which
  the theme controls. CSS can match attribute values, such as a link that carries its key after the `#`, and can probe
  rendered text. The root cause is the one already documented: whoever controls the deployment controls what the page
  does. The hosted instance uses a private theme, so its stylesheet cannot be reviewed from outside.
- **A link scanner that runs the page and clicks Show uses up a one-time link.** Scanners that only fetch the URL never
  send the fragment and cannot open anything. If one does click, the recipient sees that the link was already opened.

## Background

- [Threat model](docs/threat-model.md): assets, actors, guarantees, mitigations and known limits.
- [Security reviews](docs/security-reviews.md): the internal code review and penetration test run before the 0.2.0
  release, and the status of each finding. The original reports are in `docs/reviews/`.
