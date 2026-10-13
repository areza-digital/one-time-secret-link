# Changelog

## 0.1.0 (2026-10-12)

First release, live at https://secret.areza.digital.

- One-time links: text encrypted in the browser with age post-quantum hybrid keys, key kept in the URL fragment,
  ciphertext deleted on first read. Viewing the page never burns it; the reader has to click Show.
- Request links: ask someone for a secret with a link that is safe to email; only the requester can decrypt.
  The sender gets a delivery and read receipt.
- Verified badge for items created with the Areza Digital owner token; a phishing warning on anonymous requests.
- One Durable Object per secret (atomic read-once), alarms delete everything at expiry (1 hour to 7 days).
- Per-IP hourly limits with a daily-salted IP hash, plus a global hourly cap.
- Strict CSP, no third-party scripts, cookies or analytics. LT and EN pages in the areza.digital style.
- `azsecret` CLI: request, pull (straight into a 0600 env file), send, open, status, revoke, push (over ssh).
- `areza-secret` Claude skill.
- Hardened before launch after a security review (docs/reviews/security-2026-10-12.md): the CLI sends the owner
  token only to the configured https host and refuses redirects and foreign links; the save target is checked
  before a secret is burned and unsavable values go to a 0600 recovery file; env values are single-quoted (and
  `'`, `$`, line breaks refused); requesters can reject a wrong answer and reopen the link; only a one-time
  link's creator can revoke it; the owner token can take down anything; anonymous labels can't use our name or
  invisible characters; the anonymous-request warning sits above the label; IPv6 limits per /64; hourly
  global cap; the limiter stops writing over the limit; static files skip the Worker; Workers Logs off;
  polling backs off to once a minute; revealed secrets are cleared on page hide.
- Lithuanian copy reviewed by a native-language pass (docs/reviews/lt-copy-2026-10-12.md); two overstated
  claims fixed in both languages (hybrid keys, "may have been intercepted").
