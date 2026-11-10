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

What you need: Claude Code and Node.js 20.19 or later. The plugin adds one skill, `request-secret`
(`/vienkartine:request-secret`), and the `vienkartine` command on the assistant's shell `PATH`. It has no hooks, servers
or background processes. The command talks to https://secret.areza.digital unless you set `VIENKARTINE_URL` to your own
instance.

What the plugin cannot do, the rules the skill gives the assistant, and how to point it at your own server are in
[Use it from Claude Code](https://github.com/areza-digital/one-time-secret-link#use-it-from-claude-code). The command is
a bundle of the repository's `cli/vienkartine.ts`: rebuild it with `bun run build:plugin`.
