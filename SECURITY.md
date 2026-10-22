# Security policy

Vienkartinė nuoroda exists to move secrets safely, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report privately. Do not open a public issue or pull request for a vulnerability.

1. **GitHub private vulnerability reporting.** On the repository page, open the Security tab and choose "Report a
   vulnerability". This is the preferred route: it keeps the report, the discussion and any fix together.
2. **Email** [hello@areza.digital](mailto:hello@areza.digital) with the subject "vienkartine security". We do not
   publish an encryption key. Keep the first email short (what and where, no exploit details) if you prefer, and we
   will agree a safe way to exchange the rest.

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

## Background

- [Threat model](docs/threat-model.md): assets, actors, guarantees, mitigations and known limits.
- [Security reviews](docs/security-reviews.md): the internal code review and penetration test run before the 0.2.0
  release, and the status of each finding. The original reports are in `docs/reviews/`.
