// One Content-Security-Policy for the Worker responses and for dist/_headers (static files), so they never drift.
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  // Chromium refuses any string passed to an HTML/script sink (innerHTML, eval, …); our code uses none.
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");
