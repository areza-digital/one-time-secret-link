// The <script> check behind `bun run verify`, kept separate so the tests can import it.

/**
 * What a page's <script> tags load, and what is wrong with them. Tag and attribute names are matched without regard to
 * case, as browsers do, and an SVG <script href> counts as a script. Allowed: same-origin files under /assets/ and
 * JSON data blocks. Anything else that could load code is a problem; inline code is only counted, because the CSP
 * blocks it.
 */
export function scanScripts(html: string): { sources: { src: string; integrity: string | null }[]; problems: string[]; inline: number } {
  const sources: { src: string; integrity: string | null }[] = [];
  const problems: string[] = [];
  let inline = 0;
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    // The first occurrence of an attribute wins, as in the browser. Values may be double-quoted, single-quoted or bare.
    const attr = (name: string) => {
      const match = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
      return match ? (match[1] ?? match[2] ?? match[3]) : null;
    };
    if (attr("href") !== null || attr("xlink:href") !== null) {
      problems.push(`script with an href: ${attrs.trim()}`);
      continue;
    }
    const src = attr("src");
    if (src !== null) {
      if (/^\/assets\/[A-Za-z0-9._-]+\.js$/.test(src)) sources.push({ src, integrity: attr("integrity") });
      else problems.push(`script from outside /assets/: ${src}`);
      continue;
    }
    const type = (attr("type") ?? "").trim().toLowerCase();
    if (type === "application/json" || type === "application/ld+json") continue;
    if (body.trim()) inline++;
  }
  return { sources, problems, inline };
}
