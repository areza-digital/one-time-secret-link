## What this changes and why

## Checks

- [ ] `bun run check` passes (type checks, unit tests, end-to-end test)
- [ ] Tests added or updated for the behavior that changed
- [ ] The JavaScript stays theme-independent: nothing in `src/web/` or `src/shared/` reads theme files, and themes only
      change HTML and CSS
- [ ] No new runtime dependency, or it was discussed in an issue first
- [ ] No third-party requests, inline scripts or styles, or HTML sinks; the CSP is not loosened
- [ ] The server stores and logs nothing new (no raw IPs, bodies or secrets), or the threat model is updated here
- [ ] Page text changes are in both languages (`site/copy.ts`) and describe only what the code does
- [ ] Documentation and `CHANGELOG.md` ("Unreleased") are updated
- [ ] This is not a vulnerability fix that should first go through `SECURITY.md`

## Security notes

If this touches the protocol, tokens, headers, rate limits, the CLI's file handling or labels, say what you checked.
