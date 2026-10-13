// The neutral default theme: system fonts, an indigo/slate palette and Lucide icons (ISC, see ICONS-LICENSE).
// Self-hosters can set VK_ORIGIN, VK_PRODUCT, VK_REPO and VK_CONTACT, or copy this folder and point VK_THEME at it.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { GlyphName, IconName, Theme } from "../../site/theme";

const require = createRequire(import.meta.url);
const LUCIDE = join(dirname(require.resolve("lucide-static/package.json")), "icons");

const ICONS: Record<IconName, string> = {
  key: "key-round",
  server: "server",
  eye: "eye",
  inbox: "inbox",
  shield: "shield-check",
  calendar: "calendar-clock",
  flag: "flag",
  stamp: "badge-check",
  bank: "landmark",
  database: "database",
  clipboard: "file-lock-2",
  plug: "plug",
  lifebuoy: "life-buoy",
  code: "code",
};

const GLYPHS: Record<GlyphName, string> = {
  check: "check",
  cross: "x",
  plus: "plus",
  theme: "sun-moon",
  chevron: "chevron-right",
};

/** A Lucide icon as inline SVG with our classes; the license comment and fixed size are stripped. */
function lucide(name: string, className: string, size?: number): string {
  const svg = readFileSync(join(LUCIDE, `${name}.svg`), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*class="[^"]*"/, "")
    .replace(/\s*width="24"\s*height="24"/, size ? ` width="${size}" height="${size}"` : "")
    .replace("<svg", `<svg class="${className}" aria-hidden="true" focusable="false"`)
    .replace(/\n\s*/g, " ")
    .trim();
  return svg;
}

const env = process.env;

const theme: Theme = {
  id: "default",
  config: {
    origin: (env.VK_ORIGIN ?? "https://example.com").replace(/\/$/, ""),
    product: env.VK_PRODUCT ?? "Vienkartinė nuoroda",
    repoUrl: env.VK_REPO ?? "https://github.com/areza-digital/vienkartine",
    contactEmail: env.VK_CONTACT ?? "abuse@example.com",
  },
  stylesheet: join(import.meta.dir, "theme.css"),
  files: { "/favicon.svg": join(import.meta.dir, "favicon.svg") },
  themeColor: "#4f46e5",
  // No inline styles anywhere: the CSP forbids them, so sizes are classes (icon--24 … icon--56).
  icon: (name, size) => `<span class="icon icon-badge icon--${size}">${lucide(ICONS[name], "icon-svg", Math.round(size / 2))}</span>`,
  glyph: (name) => lucide(GLYPHS[name], `glyph glyph-${name}`),
  logo: () => `<span class="logo-mark">${lucide("lock-keyhole", "logo-svg")}</span>`,
  divider: () => "",
};

export default theme;
