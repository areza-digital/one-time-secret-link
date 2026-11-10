# The Claude Code plugin

A Claude Code plugin lets a coding assistant ask a person for an API key or a password without the secret passing
through the chat. The README has the user's side: [Use it from Claude Code](../README.md#use-it-from-claude-code). This
page is for people who maintain the plugin. It was written against the Claude Code plugin documentation of
2026-11-10 (code.claude.com/docs/en/plugins).

## Layout

```
.claude-plugin/marketplace.json          the marketplace "areza-secret": one entry, source ./plugins/vienkartine
plugins/vienkartine/
  .claude-plugin/plugin.json             name "vienkartine", version, author, license
  README.md                              what the plugin is, the install commands
  skills/request-secret/SKILL.md         the only skill: the request flow and what the assistant must never do
  bin/vienkartine                        the CLI as one bundled file (generated, committed, executable)
  bin/package.json                       {"type": "commonjs"}, see below
  THIRD_PARTY_NOTICES                    licences of the packages bundled into bin/vienkartine (generated, committed)
scripts/build-plugin.ts                  builds bin/vienkartine and THIRD_PARTY_NOTICES from cli/vienkartine.ts
test/plugin.test.ts                      manifests, skill, shipped files are current, version guard, a round trip on Node
```

A marketplace is a git repository with `.claude-plugin/marketplace.json`; once that file is in the repository the plugin
is published, with no submission form. Users run `claude plugin marketplace add areza-digital/one-time-secret-link`
and `claude plugin install vienkartine@areza-secret`. People who install get only the plugin folder
(`plugins/vienkartine`), so everything the plugin runs is inside it.

The plugin has no hooks, MCP servers or monitors, so nothing runs unless the assistant runs `vienkartine`. Files in a
plugin's `bin/` are on the `PATH` of the assistant's Bash tool while the plugin is enabled, but "plugin `bin/` directories
come after the user's own `PATH` entries" (plugins components page, 2026-11-10), so a `vienkartine` the user installed
earlier would run first. The skill therefore calls the bundled command by its full path, `"${CLAUDE_PLUGIN_ROOT}/bin/vienkartine"`.
Claude Code replaces that variable in the Markdown of a plugin skill when it loads it (skills page, table of string
substitutions: `${CLAUDE_PLUGIN_ROOT}` is "substituted only in plugin skills"), and the manifest reference adds that the
variables are not in the environment of commands run through the Bash tool, which is why the reference has to sit in the
skill text. A test fails if the skill names the command without that path.

## How the command is shipped

The CLI is TypeScript that runs on Bun and imports `age-encryption`. A user who installed only the plugin has neither the
sources nor Bun, so the plugin ships one file: `bun run build:plugin` bundles `cli/vienkartine.ts` and everything it
imports into `plugins/vienkartine/bin/vienkartine`.

- **Runtime: Node.js 22 or later.** Node is on far more machines than Bun. Node 20 is past end of life, so the plugin
  does not claim it, and nothing in the bundle needs anything newer than 22. The file has a `#!/usr/bin/env node`
  shebang. The CLI uses no Bun-only API for this reason (`Bun.sleep` and `Bun.stdin` were replaced by portable code), and
  a test fails if the bundle mentions `Bun`.
- **CommonJS, plus `bin/package.json`.** Node decides whether an extensionless file is CommonJS or ES module from the
  nearest `package.json` above it, and a user's home directory may hold one with `"type": "module"`. The bundle is
  CommonJS and `bin/package.json` pins that, so it runs wherever the plugin is installed.
- **Same protection as the Bun shebang.** The Bun shebang (`--no-env-file --config=/dev/null`) keeps a planted `.env` or
  `bunfig.toml` in the current directory from redirecting the CLI. Node reads neither, and the bundle loads only Node's
  own modules (`node:` imports; a test checks this), so nothing is loaded from the working directory.
- **Readable, reproducible.** The bundle is not minified, and the build is deterministic: it runs from the repository
  root whatever the caller's directory is, so the same sources and the same Bun give the same bytes. Use the Bun version in
  `package.json`. `test/plugin.test.ts` rebuilds the file and fails while the committed one differs.
- **The default server is unchanged.** `VIENKARTINE_URL` defaults to https://secret.areza.digital, as in the source. To
  point the plugin at your own instance, set `VIENKARTINE_URL` in your shell, or for every session in Claude Code's
  settings (`{ "env": { "VIENKARTINE_URL": "https://secret.example.com" } }`).

The file is about 295 KiB (at the time of writing), mostly `age-encryption` and the post-quantum primitives it uses.
`THIRD_PARTY_NOTICES` carries the licence text of every package that went into the bundle (`age-encryption`,
BSD-3-Clause; `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum` and `@scure/base`, MIT, two of them
twice because `@noble/post-quantum` brings its own copies). `scripts/build-plugin.ts` writes it from the build's list of
input files and each package's own `LICENSE`, and fails if a bundled package has none.

## What the CLI can print

The skill allows `request`, `pull`, `status`, `reject` and `revoke`. In those, nothing prints a secret: `request` prints a
link that holds none, `pull` prints the variable name, the length and the answer time, `status` prints states and labels.
In the rest of the CLI, one command prints something that unlocks a secret: `send --print` prints the one-time link, which
contains the key. The skill forbids `send`, `open` and `push`. The CLI also leaves two kinds of plaintext on disk, never on
stdout: the private key of each pending request (`~/.config/vienkartine/requests/<id>.json`) and a value that was
received but could not be saved as asked (`~/.config/vienkartine/recovered/<id>.txt`). The skill forbids reading
`~/.config/vienkartine/`.

## Changing the plugin

- After any change to `cli/`, `src/shared/` or the version of a bundled dependency: `bun run build:plugin`, then commit
  `plugins/vienkartine/bin/vienkartine` and `plugins/vienkartine/THIRD_PARTY_NOTICES`. `bun test` fails until you do. The
  byte-for-byte check needs the Bun version pinned in `package.json` (1.4.2); another Bun can write different bytes.
- `version` in `plugin.json` pins users to that version until it changes (loading page: a manifest that pins `version`
  keeps every user on the cached copy until the string changes, however many commits are pushed). Raise it
  whenever `bin/vienkartine` or the skill changes, or `claude plugin update` tells users they are up to date. It is
  separate from the repository's version. `test/plugin.test.ts` enforces this: it hashes the two files and compares the
  hash with the `RELEASED` pair in the test, and when they differ it fails and prints the pair to paste in after you have
  raised the version. We kept the field rather than omitting it (which would make Claude Code use the commit SHA)
  because the directory's checklist warns on a missing `version` and asks for it to be raised with every release.
- Never rename the plugin: users install by `vienkartine@areza-secret`, and a renamed plugin is a different plugin.
- Validate before you push (from a shell; `claude plugin validate` only reads files):

  ```bash
  claude plugin validate .                              # the marketplace
  claude plugin validate ./plugins/vienkartine --strict # the plugin (--strict also fails on a missing "version")
  claude plugin validate ./plugins/vienkartine/skills   # the skill's front matter
  ```

### Trying an install without touching your own setup

Point Claude Code at a throwaway configuration directory, install from your checkout, look, and delete it:

```bash
export CLAUDE_CONFIG_DIR=$(mktemp -d)
claude plugin marketplace add "$PWD"
claude plugin install vienkartine@areza-secret
claude plugin details vienkartine        # one skill, no agents, hooks or servers
claude plugin marketplace remove areza-secret
rm -rf "$CLAUDE_CONFIG_DIR"; unset CLAUDE_CONFIG_DIR
```

Whether Claude Code reads a marketplace added from a local directory in place or copies the plugin into its cache depends
on the version (2.1.274 copied it, executable bit included); if an edit does not show, reinstall. An install from GitHub
clones the repository, so what counts is what is committed: `git ls-files -s plugins/vienkartine/bin/vienkartine` must show
mode `100755`.

## Later: submitting to Anthropic's directory

Not done, and not needed for the install commands above. The notes below come from the directory documentation of
2026-11-10 (claude.com/docs/directory/publish and claude.com/docs/plugins/pre-submission-checklist; the connector page
claude.com/docs/connectors/building/submission covers MCP servers, which this plugin does not have).

- **Who and where.** Someone on a paid claude.ai plan (Pro, Max, Ultra; on Team and Enterprise an Owner) submits a
  "Plugin bundle" at claude.ai/directory/manage. The repository must be public before the listing goes live. The first
  organization to submit a repository folder holds the listing, so submit from the one that should own it. Submit
  `plugins/vienkartine` on its own.
- **Review.** Every version gets automated validation and a security scan, and a person reviews a new listing before it goes
  live. A first submission that fails the scan is rejected. The listing is subject to Anthropic's Software Directory Terms
  and Policy.
- **The privacy policy URL.** The directory reads `privacyPolicyUrl` (and `documentationUrl`, `supportUrl`,
  `termsOfServiceUrl`, `icon`) from `plugin.json`, each an `https://` URL, the icon a file in the plugin. The plugin's
  statement is the FAQ answer "What does the Claude Code plugin send?" in `site/copy.ts`, in both languages, next to the
  answer "What do you store about me?". Its paragraph has a fixed id, so it has a stable address on the hosted instance:
  **https://secret.areza.digital/en/#plugin-privacy** (Lithuanian: https://secret.areza.digital/#papildinio-privatumas).
  The browser opens the collapsed answer when it follows the link. The plugin pages only say that the directory reads
  those fields; the connector submission page, for local connectors, asks for a policy that covers data collection, usage
  and storage, third-party sharing, retention and contact information, and rejects a missing or incomplete one
  immediately. The answer covers each of them: the plugin collects nothing; what the command sends and never sends; what
  the server keeps, how long, and the daily totals; Cloudflare as the host and no one else; the contact address; the
  default server and your own. Not done: the address is live only once a release that contains the answer is deployed to
  secret.areza.digital, so `privacyPolicyUrl` is not in `plugin.json` yet. Add it at submission time, check that the link
  opens the answer, and keep the answer true when the CLI or the server changes what is sent or stored.
- **Held for a reviewer, by the checklist.** The directory holds a version for a person when a non-image file is over
  256 KiB (`bin/vienkartine` is about 295 KiB) and asks for readable source rather than compiled, packed or minified code.
  The bundle is unminified, generated from this repository by a documented, tested command, but it is still generated, so
  expect a hold and say in the submission where the source is.
- **claude.ai does not install this plugin.** claude.ai and Cowork do not install a plugin that has a top-level `bin/`
  directory, so a directory listing would reach people only through Claude Code (account sync). If claude.ai matters, the
  alternative is a plugin without `bin/`: the skill would tell the user to install the CLI themselves. That is a product
  decision, not made here.
- **Already fine:** a README of at least 40 words in the plugin folder, `license` set to `MIT`, `name` and `author` that do
  not imitate Anthropic or another brand, a kebab-case name, `description` and `version` set, a skill with valid front
  matter, no hooks, servers or package launchers, and the notices of the bundled packages in `THIRD_PARTY_NOTICES`. Run the portal's Validate before submitting; it checks more than
  `claude plugin validate` does.
