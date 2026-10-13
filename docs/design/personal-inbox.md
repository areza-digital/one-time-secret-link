# Personal inbox: design (draft for decision)

Status: proposal, 2026-10-13. Not built yet.

## The problem it solves

A one-time link can be opened by **whoever gets it first**. A request link fixes that for one exchange, but someone has
to create it first. A personal inbox is a **permanent address** that only its owner can read:
`vienkartine.lt/@ona`. Anyone can drop a secret there; it is encrypted in their browser to the owner's keys, and
the owner pulls it straight into an env file from the command line (or Claude Code), or reads it in the browser.

## Principles

1. **The server never holds anything readable.** Not the secret, not the sender's note, not a private key.
2. **No passwords.** Keys live on the owner's devices; browsers protect theirs with a passkey.
3. **A server that lies must be caught.** A malicious or hacked server could hand senders its own key. Links can pin
   the key, the CLI pins keys like SSH does, and every key change is announced to the owner and shown to senders.
4. **Identity is something the sender can check.** An inbox shows a verified email address or domain, not just a
   name anyone could claim.
5. **Losing a laptop or an email account must not quietly expose future secrets.**

## How it works

### Creating an inbox

1. The owner starts on the command line (`vienkartine inbox create ona@example.com`) or on the web (sign up with a
   passkey).
2. The device makes its own post-quantum hybrid age key pair. Only the public half (the recipient) is uploaded.
3. The server emails a confirmation link to that address. The email also shows the key's short fingerprint, which the
   CLI or browser shows too, so the owner sees the same key on both sides.
4. Once confirmed, the inbox is active. The owner can claim a short alias (`@ona`); the page always shows the verified
   address behind it, with the local part masked (`o••@example.com ✓`).

### Devices instead of one shared key

Each device has its **own** key; the inbox's public key set is the list of all active devices. Senders encrypt to all
of them (age supports several recipients per file), and any one device can decrypt. Nothing secret is ever copied
between devices.

| Device | Where the private key lives |
|---|---|
| Command line / Claude Code | `~/.config/vienkartine/inboxes/<inbox>/device.key`, mode 0600, like an SSH key (optionally passphrase-protected with age's scrypt) |
| Browser | Generated in the browser, then **wrapped with a passkey** (age's FIDO2-PRF support). The wrapped blob is stored on the server, which cannot unwrap it without the passkey. A passkey synced through iCloud Keychain or Google Password Manager makes the inbox readable on the owner's phone and laptop with Face ID / Touch ID, and nothing else |

Passkeys can't be encrypted *to* (the PRF secret needs the authenticator), so they only protect device keys; senders
always encrypt to the age recipients.

**Adding a device** needs approval from an existing device: a short pairing code shown on both screens.
**Recovery** (all devices lost) goes through email but is deliberately slow: the new key only becomes active after
72 hours, every old device and the email address are told, and senders see "this inbox's keys changed recently".
A thief with only the owner's mailbox therefore can't silently redirect secrets.

### Sending

- **Browser:** open `vienkartine.lt/@ona`, or type the address in a "To" field on the home page. The page shows the
  verified address or domain, when the keys last changed, and a warning if that was recent. Secret **and note** are
  encrypted together; the server stores only ciphertext, its size and the time.
- **Pinned links:** the owner shares `vienkartine.lt/@ona#k=7Q3F-K2MA` (the key-set fingerprint, in the fragment, so
  the server never sees it). If the server serves different keys, the sender's browser refuses to send.
- **Command line:** `vienkartine send --to ona@example.com --file x`. The CLI remembers each inbox's fingerprint
  (like SSH `known_hosts`) and stops on an unexpected change.
- The sender gets a receipt link: delivered, then read.

### Receiving

- **Email notification** to the owner: "You have 2 new items in your Vienkartinė inbox". It never contains the
  content, the note, or anything the sender wrote, so notifications can't carry phishing text. Throttled to one
  email per 10 minutes.
- **CLI / Claude Code:** `vienkartine inbox` lists items (notes are decrypted locally); `vienkartine inbox pull <id>
  --env NAME --to FILE` decrypts into the env file, prints only name and length, then deletes the item on the server.
  The fetch and the delete are two steps, so a failed write never loses a secret.
- **Browser:** sign in with the passkey, read, copy, delete.

## Threats

| Threat | Defence |
|---|---|
| Someone makes an inbox that looks like ours (`@ona-example`) | Email verification; the page shows the verified address or domain; reserved words; report and takedown |
| Hacked or malicious server swaps in its own key | Pinned links, CLI key pinning, key-change banner, owner told about every change; later an append-only key log the CLI checks. Remaining risk: a hacked server could also ship bad JavaScript. Open source, reproducible builds and `verify` make that detectable, not impossible |
| Owner's email account is taken over | Adding devices needs an existing device; email recovery waits 72 h and alerts every device |
| Laptop stolen | Remove the device from another device; pending items expire in 7 days; optional passphrase on the CLI key |
| Inbox flooded with spam | Per-IP and per-inbox limits, 50 pending items at most, 10 KB each, owner can pause the inbox, notifications batched |
| Phishing through notes | Notes are encrypted and shown only to the owner, never in emails |
| Finding out who has an inbox | Lookup needs the exact address and is rate-limited; alias pages mask the local part |
| Server stores more than it should | Stored: address, alias, public keys, wrapped browser keys, item sizes and times, a daily IP hash. Never: contents, notes, private keys |

## What it needs

- **Outgoing email** to any address (confirmations, notifications). Options: Cloudflare Email Sending (public beta,
  needs the Workers Paid plan, $5/month; confirm it can mail arbitrary recipients), or Resend (free tier 3,000
  emails/month). Either needs SPF/DKIM records on vienkartine.lt.
- Passkey support: current Safari, Chrome and Edge, plus password managers with PRF support. Where PRF is missing,
  the owner uses the CLI.

## Phases

1. **Inbox v1:** email-verified inboxes and aliases; CLI and passkey devices; web and CLI sending; pinned links and CLI
   pinning; email notifications; `inbox pull` into env files; abuse limits. Its own security review before launch.
2. **Later:** append-only key log checked by the CLI; organisation verification through a DNS TXT record
   (`verified: example.com`); a browser extension that pins the page's own code.
