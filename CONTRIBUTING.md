# Contributing

Thanks for looking. This is a security tool, so the bar for changes is on the strict side. Small, focused pull requests
that explain why are easiest to review.

## Security issues

Do not open an issue or a pull request for a vulnerability. Follow [SECURITY.md](SECURITY.md) instead.

## Setup

You need [Bun](https://bun.sh) 1.4.2, the version pinned in `package.json`. The build output and `bun run verify`
depend on it, so use that version rather than the latest one.

```bash
git clone https://github.com/areza-digital/one-time-secret-link
cd one-time-secret-link
bun install
cp .dev.vars.example .dev.vars    # set IP_SALT, for example from: openssl rand -base64 32
bun run dev                       # build + wrangler dev on http://127.0.0.1:8787
```

Use Bun only for installing and running. Do not add `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`; `bun.lock`
is the lockfile.

Where things are:

| Path | What |
|---|---|
| `src/worker/` | Cloudflare Worker: API, routing, headers, Durable Objects |
| `src/shared/` | Wire protocol, label rules and the age wrapper, used by Worker, browser and CLI |
| `src/web/` | Browser code |
| `site/` | Site generator: `copy.ts` has all page text in Lithuanian and English; `build.ts`; `base.css`; `theme.ts` |
| `themes/default/` | The default theme |
| `cli/` | The CLI |
| `plugins/vienkartine/` | The Claude Code plugin: skill and the CLI bundled into `bin/vienkartine` |
| `scripts/` | End-to-end test, `verify`, screenshots, `build-plugin.ts` |
| `test/` | Unit tests |
| `docs/` | Documentation |

## Before you open a pull request

```bash
bun run check
```

This runs the type checks for both TypeScript projects, the unit tests and the end-to-end test (which starts its own
`wrangler dev` with throwaway storage and secrets). CI runs the same checks. All of them must pass.

Also:

- Add or update tests for the behavior you change: unit tests in `test/` for protocol and CLI logic, `scripts/e2e.ts`
  for API behavior.
- If you change anything the page shows, check it at a phone width and in light and dark mode.
  `bun run scripts/shoot.ts <url> <dir>` takes screenshots and reports horizontal overflow.
- Update the documentation and add a line to `CHANGELOG.md` under an "Unreleased" heading.
- Describe what changed and why in the pull request. If you touched anything security-relevant, say so and say how you
  checked it.

By contributing, you agree that your contribution is licensed under the [MIT license](LICENSE) of this project.

## Rules for the code

These come from what the project promises its users.

- **The JavaScript must stay theme-independent.** The two scripts built from `src/web/` are the same for every theme,
  which is what lets `bun run verify` check any instance against this repository. A theme (`themes/`, `site/theme.ts`)
  can change HTML and CSS, never scripts. Changes to `src/web/` or `src/shared/` change the built files; that is
  expected, but they must not read anything from a theme.
- **No third-party runtime dependencies without discussion.** The only one today is `age-encryption`. Open an issue and
  explain the need before adding one. Dev dependencies are easier, but still need a reason.
- **No third-party requests from the page.** No external scripts, fonts, analytics or tracking, and no cookies. The CSP
  (`src/worker/csp.ts`) is `default-src 'none'` plus a short list of `'self'` sources, and Subresource Integrity covers
  the scripts and stylesheet. Changes that loosen the CSP need a strong argument.
- **No inline styles or scripts, and no HTML sinks.** Build page content from text nodes, as `src/web/app.ts` does. Do
  not use `innerHTML`, `eval` or similar. The CSP requires Trusted Types.
- **Do not store or log more than the code stores today.** No raw IP addresses, no request bodies, no secrets in logs or
  error messages.
- **Cryptography is age's.** Do not write cryptographic primitives. Changes to the wire protocol, the token derivation
  or the key types need an issue first, and the threat model updated in the same pull request.
- **After any change to `cli/` or `src/shared/`, run `bun run build:plugin` and commit `plugins/vienkartine/bin/vienkartine`.**
  The plugin ships the CLI as one bundled file, and a test fails while it differs from the source. The CLI must also keep
  running on Node 20.19 or later: no Bun-only APIs (`Bun.*`) in `cli/` or `src/shared/`.
- **CLI changes must never print a secret value.** Files holding secrets are written with mode 0600; the save target is
  checked before a secret is burned; the operator token goes only to the URL it is pinned to. Keep the `bun` flags in
  the shebang (`--no-env-file --config=/dev/null`).
- **Page text lives in `site/copy.ts`, in both languages.** Lithuanian is the primary language; where you can, have a
  Lithuanian speaker review changes to it. The text must not claim anything the code does not do.
- Keep changes in the style of the surrounding code. TypeScript is strict; there is no formatter configured, so match
  what is there.

## Larger changes

Open an issue first for anything that changes behavior users or operators see, adds a feature, or touches the
protocol. Out of scope for now: file uploads, accounts, and anything that makes the server hold readable data. The
personal inbox in [docs/design/personal-inbox.md](docs/design/personal-inbox.md) is a design draft; discuss it before
building any part of it.

## Themes

Themes for your own instance do not need to be contributed here. If you think the default theme should change, open an
issue with a screenshot. See [docs/theming.md](docs/theming.md).
