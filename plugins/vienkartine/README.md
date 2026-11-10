# vienkartine: ask for a secret without seeing it

A Claude Code plugin for the moment your assistant needs an API key, an access token or a password. Instead of pasting
the secret into the chat, the assistant creates a request link with the `vienkartine` command. You open the link in your
own browser and type the secret into the page, where it is encrypted to a key that exists only on your machine. The
assistant then saves the answer to a private file (mode 0600) and sees only the variable name and its length. It uses the
variable by name from then on.

Install it from a shell:

```bash
claude plugin marketplace add areza-digital/one-time-secret-link
claude plugin install vienkartine@areza-secret
```

What you need: Claude Code and Node.js 22 or later. The plugin adds one skill, `request-secret`
(`/vienkartine:request-secret`), and ships the `vienkartine` command in its `bin/` folder. Claude Code puts that folder on
the assistant's shell `PATH` while the plugin is enabled, but after your own `PATH` entries, so a `vienkartine` you
installed yourself would come first; the skill therefore runs the bundled copy by its full path,
`${CLAUDE_PLUGIN_ROOT}/bin/vienkartine`. The plugin has no hooks, servers or background processes. The command talks to
https://secret.areza.digital unless you set `VIENKARTINE_URL` to your own instance.

What the plugin cannot do, the rules the skill gives the assistant, and how to point it at your own server are in
[Use it from Claude Code](https://github.com/areza-digital/one-time-secret-link#use-it-from-claude-code). The command is
a bundle of the repository's `cli/vienkartine.ts`: rebuild it, and `THIRD_PARTY_NOTICES` with it, with
`bun run build:plugin`.

## Privacy

The plugin collects nothing and has no analytics. Its command sends the server only what a request needs: the label you
give it (not encrypted), a public key made on your computer, and an access token derived from the private key, of which
the server keeps only a hash. The person you ask encrypts their answer in their own browser, so the secret in plain text
is never sent to the server; it is decrypted only on your computer. The server also counts, per day, how many links are
created, answered and opened, as totals without any address or identifier. By default the command talks to
secret.areza.digital; set `VIENKARTINE_URL` to use an instance you host yourself.

The full statement is the FAQ answer "What does the Claude Code plugin send?", at
https://secret.areza.digital/en/#plugin-privacy (Lithuanian: https://secret.areza.digital/#papildinio-privatumas).

## Licences

`bin/vienkartine` bundles `age-encryption` (BSD-3-Clause) and `@noble/*` and `@scure/base` (MIT). Their notices are in
`THIRD_PARTY_NOTICES`, which `bun run build:plugin` generates from each package's licence file.
