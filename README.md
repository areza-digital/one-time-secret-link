# Areza Secret

Free one-time secret sharing at **https://secret.areza.digital** (Lithuanian) and `/en`. The text is encrypted in
the browser with [age](https://age-encryption.org) using post-quantum hybrid keys (ML-KEM-768 + X25519); the server
only ever holds ciphertext and deletes it on first read or at expiry (1 hour to 7 days).

Two flows:

- **One-time link** (`/s/<id>#<key>`): paste a secret, get a link that opens once. The key lives in the URL
  fragment, which browsers never send to the server.
- **Request link** (`/r/<id>`): ask someone for a secret. The link holds only our public key, so it is safe to
  email. Their browser encrypts to it; only the requester can read the answer (`/o/<id>#<key>` or `azsecret pull`).

Spec and decisions: [docs/specs/secret-drop.md](docs/specs/secret-drop.md). Operations: [INFRA.md](INFRA.md).

## Layout

| Path | What |
|---|---|
| `src/worker/` | Cloudflare Worker: API, page routing, security headers; `SecretBox` (one Durable Object per secret) and `RateLimiter` |
| `src/shared/` | Wire protocol and the age wrapper, shared by Worker, browser and CLI |
| `src/web/` | Browser code (tool, open, fill and owner pages) |
| `site/` | Static site generator: `copy.ts` (all LT/EN text), `build.ts`, `styles.css`, pixel artwork from areza-v8 |
| `cli/azsecret.ts` | The `azsecret` CLI (`request`, `pull`, `send`, `open`, `status`, `revoke`, `push`) |
| `test/`, `scripts/e2e.ts` | Unit tests; end-to-end run against a throwaway local Worker |
| `scripts/shoot.ts` | Phone and desktop screenshots in both themes, with a horizontal-overflow check |

## Develop

```bash
bun install
bun run dev          # build + wrangler dev on http://127.0.0.1:8787 (needs .dev.vars, see INFRA.md)
bun run check        # typecheck + unit tests + e2e (starts its own wrangler dev with empty storage)
bun run scripts/shoot.ts http://127.0.0.1:8787 shots / /en
```

## CLI

```bash
azsecret request "Anthropic API raktas" --env ANTHROPIC_API_KEY --to ~/.config/client/x.env
azsecret pull <id> [--wait]            # prints name, length and when it was answered
azsecret reject <id>                   # wrong answer: discard it, the same link takes a new one
azsecret send --from-env FILE:NAME     # link goes to the clipboard (--print / --out FILE otherwise)
pbpaste | azsecret open --env NAME --to FILE
azsecret push --from FILE --env NAME --ssh HOST --remote /path/.env
azsecret status | revoke <id> [--admin]
```

`~/.local/bin/azsecret` is a shim that runs `cli/azsecret.ts` with bun. Values are written to files with mode 0600
and never printed. Claude uses it through the `areza-secret` skill.

## Deploy

```bash
bun run deploy       # build + unit tests + wrangler deploy
```

See INFRA.md for secrets, DNS and the indexing switch.
