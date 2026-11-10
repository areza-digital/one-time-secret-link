---
name: request-secret
description: Get an API key, access token, password or other credential from the person (or from a client or colleague) without it ever appearing in the chat. Use whenever you need a secret to continue, when the person offers to paste or share one, or when they ask you to request one. Never ask for the value in chat and never read it: create a request link with the vienkartine CLI, hand over the link, and after they have filled it in save the value to a private file with vienkartine pull.
---

# Request a secret without seeing it

Everything a tool prints, and everything pasted in the chat, is sent to the model and written to a plaintext transcript on the person's disk. So you never receive the value. The person types it into a web page in their own browser, where it is encrypted to a key that exists only on this machine. The CLI then saves it to a 0600 file and prints only the variable name and its length.

## Steps

1. Pick the variable name the tool expects (`OPENAI_API_KEY`), and a file outside the project: `~/.config/vienkartine/secrets/<NAME>.env`.
2. Run `vienkartine request "<what you need, in plain words>" --env <NAME> --to ~/.config/vienkartine/secrets/<NAME>.env --lang en`
   - Use `--lang lt` only if the person reads Lithuanian. Add `--ttl 24h` for a shorter life (default 7d).
   - The label is shown to the sender unencrypted: no secrets in it. If the server refuses it (words like "verified", PIN, bank names), rephrase.
   - For a password, a PEM or JSON key, or anything with `$`, a quote or a line break, use `--raw ~/.config/vienkartine/secrets/<NAME>.txt` instead of `--env`/`--to`: an env file cannot hold those, and the secret would end up in a recovery file.
3. Give the person the link printed after "link for the sender" and tell them: open it in their own browser, type or paste the secret into the page and press the button, never paste it here. The link holds no secret, so it is safe to email to a client. Say which host it points to: the CLI uses https://secret.areza.digital unless `VIENKARTINE_URL` is set.
4. When they say it is sent, run `vienkartine pull <id>`. It prints only the name, the length and the time. Exit code 2 means not answered yet: tell them, do not loop.
5. Use the value by name, in the same shell command that needs it: `set -a; . ~/.config/vienkartine/secrets/OPENAI_API_KEY.env; set +a; curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models`. For a `--raw` file, hand its path to the tool that needs it (`@file`, `-i file`, `< file`).

## Never

- Ask for the secret in chat. If they paste one anyway, say so, and advise them to revoke it and issue a new one.
- Put a secret in a command line. Print, echo, log or display it: no `cat`, `echo`, `env`, `printenv`, `set -x`, `curl -v`, `head`, `grep`, and no Read or Edit on the file. If a command's own output could echo the key, do not run it that way.
- Read or search anything under `~/.config/vienkartine/` (it holds the private keys of pending requests and recovery files).
- Run `send`, `open` or `push`. They handle secrets you must not hold, and `send --print` prints a link that unlocks one. Use only `request`, `pull`, `status`, `reject` and `revoke`.
- Copy the value into the project or commit it. If the project needs a `.env`, the person copies the file themselves.

## After

- `vienkartine status` shows what is pending. `vienkartine reject <id>` discards a wrong answer, or one that someone else sent first (the same link takes a new answer). `vienkartine revoke <id>` cancels a request.
- Exit code 7 means the secret arrived but could not be saved as asked and sits in `~/.config/vienkartine/recovered/<id>.txt`. Tell the person to move it; do not open it.
- If `vienkartine` is not found, the plugin is not enabled or Node.js 20.19 or later is missing. Say so; do not fall back to another way of receiving the secret.
