// A theme gives an instance its look and its words: config, stylesheet, icons, logo, optional CTA and copy overrides.
// The JavaScript is the same for every theme, so `bun run verify` can compare any instance with this repo.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Lang } from "../src/shared/protocol";
import type { Copy } from "./copy";

export type IconName =
  | "key"
  | "server"
  | "eye"
  | "inbox"
  | "shield"
  | "calendar"
  | "flag"
  | "stamp"
  | "bank"
  | "database"
  | "clipboard"
  | "plug"
  | "lifebuoy"
  | "code";

/** Small interface glyphs (checks, chevrons). Rendered into <template> tags so the shared JS can reuse them. */
export type GlyphName = "check" | "cross" | "plus" | "theme" | "chevron";

export interface SiteConfig {
  /** Canonical origin without a trailing slash, e.g. https://secret.example.com */
  origin: string;
  /** Product name shown in the header, titles and social previews: one name, or one per language. */
  product: string | Record<Lang, string>;
  /** Public source repository, linked from the footer and the FAQ. */
  repoUrl: string;
  /** false: the pages neither link to repoUrl nor say the code is open source (e.g. while the repository is private). */
  publicSource?: boolean;
  /** Where abuse reports and questions go. */
  contactEmail: string;
  /** Who runs this instance, shown in the footer ("Sukūrė …" / "Made by …"). Optional for self-hosters. */
  operator?: { name: string; url: Record<Lang, string> };
  /** The header button. Defaults to the source code link. */
  headerLink?: { label: Record<Lang, string>; href: Record<Lang, string> };
}

export interface Theme {
  id: string;
  config: SiteConfig;
  /** Absolute path of the theme stylesheet, loaded after site/base.css. */
  stylesheet: string;
  /** Extra files copied into dist: published path → absolute source path (fonts, favicon, social images). */
  files?: Record<string, string>;
  /** Extra <head> tags, e.g. font preloads. */
  head?: string;
  /** Social preview image per language, as a published path (e.g. /og-lt.png). */
  ogImage?: Record<Lang, string>;
  /** Browser UI colour (meta theme-color). */
  themeColor?: string;
  icon(name: IconName, size: number): string;
  glyph(name: GlyphName): string;
  /** The brand mark next to the product name. */
  logo(): string;
  /** Decorative divider between sections; "" for none. */
  divider(): string;
  /** Promotional section above the footer, if the operator wants one. */
  cta?: Record<Lang, { h2: string; text: string; button: string; href: string }>;
  /** Change any copy after the core copy is built. */
  copy?: (lang: Lang, copy: Copy) => Copy;
}

export function productName(config: SiteConfig, lang: Lang): string {
  return typeof config.product === "string" ? config.product : config.product[lang];
}

/** VK_THEME=/path/to/theme-dir picks a theme (its theme.ts default-exports a Theme); default is themes/default. */
export async function loadTheme(): Promise<Theme> {
  const dir = process.env.VK_THEME ? resolve(process.env.VK_THEME) : join(import.meta.dir, "../themes/default");
  const entry = join(dir, "theme.ts");
  if (!existsSync(entry)) throw new Error(`theme not found: ${entry}`);
  const theme = (await import(entry)).default as Theme;
  if (!theme?.config?.origin || !theme.stylesheet) throw new Error(`${entry} does not export a complete Theme`);
  return theme;
}
