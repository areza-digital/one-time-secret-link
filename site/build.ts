// Builds dist/: hashed JS and CSS, theme files, and the LT + EN pages. Run with `bun run build`.
// VK_THEME picks the theme directory (default themes/default), VK_WRANGLER_CONFIG the config whose vars the pages
// must agree with (default wrangler.jsonc), VK_OUT the output directory (default dist).

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_RESERVED_WORDS, LIMITS, TTL_CHOICES, type Lang } from "../src/shared/protocol";
import { CSP } from "../src/worker/csp";
import { coreCopy, type Copy } from "./copy";
import { button, esc } from "./html";
import { loadTheme, type GlyphName, type IconName, type Theme } from "./theme";

const ROOT = join(import.meta.dir, "..");
const LANGS: Lang[] = ["lt", "en"];
const ANCHORS: Record<Lang, { how: string; request: string; security: string; faq: string; tool: string }> = {
  lt: { how: "kaip-veikia", request: "uzklausos", security: "saugumas", faq: "duk", tool: "irankis" },
  en: { how: "how-it-works", request: "requests", security: "security", faq: "faq", tool: "tool" },
};
const GLYPHS: GlyphName[] = ["check", "cross", "plus", "theme", "chevron"];

type PageKind = "home" | "open" | "fill" | "owner" | "404";

interface Assets {
  css: string;
  app: string;
  theme: string;
  /** Subresource Integrity values per published path. */
  sri: Record<string, string>;
}

interface Version {
  version: string;
  commit: string;
  short: string;
}

/** Everything a page needs, resolved once per build. */
interface Ctx {
  theme: Theme;
  copy: Record<Lang, Copy>;
  assets: Assets;
  version: Version;
  indexable: boolean;
  reserved: string[];
  out: string;
}

const home = (lang: Lang) => (lang === "en" ? "/en" : "/");
const fmt = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));

/** The vars block of the Worker config, so pages and Worker agree on indexing and reserved words. */
function workerVars(): Record<string, string> {
  const path = resolve(process.env.VK_WRANGLER_CONFIG ?? join(ROOT, "wrangler.jsonc"));
  const text = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return (JSON.parse(text).vars ?? {}) as Record<string, string>;
}

function version(): Version {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (dirty) commit += "-dirty";
  } catch {
    // Not a git checkout (e.g. a downloaded archive): the page then says "unknown".
  }
  return { version: pkg.version, commit, short: commit.slice(0, 7) + (commit.endsWith("-dirty") ? "-dirty" : "") };
}

async function bundle(theme: Theme, out: string): Promise<Assets> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "assets"), { recursive: true });

  // The JS bundles never depend on the theme, so their hashes are comparable across instances (`bun run verify`).
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/web/app.ts"), join(ROOT, "src/web/theme.ts")],
    outdir: join(out, "assets"),
    naming: "[name]-[hash].[ext]",
    target: "browser",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("JS bundle failed");
  }
  const name = (entry: string) => {
    const output = result.outputs.find((item) => item.kind === "entry-point" && item.path.includes(`/${entry}-`));
    if (!output) throw new Error(`missing bundle ${entry}`);
    return `/assets/${output.path.split("/").pop()}`;
  };

  for (const [published, source] of Object.entries(theme.files ?? {})) {
    const target = join(out, published.replace(/^\//, ""));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  const css = `${readFileSync(join(import.meta.dir, "base.css"), "utf8")}\n/* theme: ${theme.id} */\n${readFileSync(theme.stylesheet, "utf8")}`;
  const cssName = `styles-${createHash("sha256").update(css).digest("hex").slice(0, 10)}.css`;
  writeFileSync(join(out, "assets", cssName), css);
  const assets = { css: `/assets/${cssName}`, app: name("app"), theme: name("theme") };
  const sri: Record<string, string> = {};
  for (const path of Object.values(assets)) {
    sri[path] = `sha384-${createHash("sha384").update(readFileSync(join(out, path))).digest("base64")}`;
  }
  return { ...assets, sri };
}

function head(ctx: Ctx, lang: Lang, kind: PageKind, title: string, description: string): string {
  const { theme, assets, version: v } = ctx;
  const c = ctx.copy[lang];
  const origin = theme.config.origin;
  const indexable = kind === "home" && ctx.indexable;
  const canonical = `${origin}${home(lang)}`;
  const alternates = indexable
    ? [
        `<link rel="canonical" href="${canonical}">`,
        `<link rel="alternate" hreflang="lt" href="${origin}/">`,
        `<link rel="alternate" hreflang="en" href="${origin}/en">`,
        `<link rel="alternate" hreflang="x-default" href="${origin}/">`,
      ].join("")
    : kind === "home"
      ? `<link rel="canonical" href="${canonical}"><meta name="robots" content="noindex, nofollow">`
      : `<meta name="robots" content="noindex, nofollow">`;
  const image = theme.ogImage?.[lang];
  const og =
    kind === "home"
      ? [
          `<meta property="og:type" content="website">`,
          `<meta property="og:site_name" content="${esc(theme.config.product)}">`,
          `<meta property="og:locale" content="${c.ogLocale}">`,
          `<meta property="og:title" content="${esc(title)}">`,
          `<meta property="og:description" content="${esc(description)}">`,
          `<meta property="og:url" content="${canonical}">`,
          ...(image
            ? [
                `<meta property="og:image" content="${origin}${image}">`,
                `<meta property="og:image:width" content="1200">`,
                `<meta property="og:image:height" content="630">`,
                `<meta property="og:image:alt" content="${esc(c.hero.h1.replace("\n", " "))}">`,
                `<meta name="twitter:card" content="summary_large_image">`,
              ]
            : [`<meta name="twitter:card" content="summary">`]),
        ].join("")
      : "";
  const jsonLd = kind === "home" ? `<script type="application/ld+json">${structuredData(ctx, lang)}</script>` : "";
  const ui = JSON.stringify({ lang, homePath: home(lang), reserved: ctx.reserved, ...c.ui }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${c.htmlLang}" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${esc(theme.themeColor ?? "#111827")}">
<meta name="vk-version" content="${esc(v.version)}">
<meta name="vk-commit" content="${esc(v.commit)}">
${alternates}${og}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${theme.head ?? ""}
<link rel="stylesheet" href="${assets.css}" integrity="${assets.sri[assets.css]}">
<script src="${assets.theme}" integrity="${assets.sri[assets.theme]}"></script>
<script type="module" src="${assets.app}" integrity="${assets.sri[assets.app]}"></script>
${jsonLd}<script type="application/json" id="ui-copy">${ui}</script>
</head>`;
}

/** Glyphs the shared JS clones (chevrons in buttons it creates), so the JS itself stays theme-free. */
function glyphTemplates(theme: Theme): string {
  return GLYPHS.map((name) => `<template id="glyph-${name}">${theme.glyph(name)}</template>`).join("");
}

function header(ctx: Ctx, lang: Lang, kind: PageKind): string {
  const { theme } = ctx;
  const c = ctx.copy[lang];
  const a = ANCHORS[lang];
  const nav =
    kind === "home"
      ? `<nav class="header-nav" aria-label="${esc(theme.config.product)}">
  <a href="#${a.how}">${c.nav.how}</a>
  <a href="#${a.request}">${c.nav.request}</a>
  <a href="#${a.security}">${c.nav.security}</a>
  <a href="#${a.faq}">${c.nav.faq}</a>
</nav>`
      : "";
  const other: Lang = lang === "lt" ? "en" : "lt";
  // On app pages the switch keeps the same item; app.ts adds the fragment, so the key is never lost.
  const switchHref = kind === "home" || kind === "404" ? home(other) : "#";
  const link = theme.config.headerLink ?? {
    label: { lt: c.footer.source, en: c.footer.source },
    href: { lt: theme.config.repoUrl, en: theme.config.repoUrl },
  };
  const divider = theme.divider();
  return `<a class="skip-link" href="#main">${c.nav.skip}</a>
<header class="site-header">
  <div class="site-container header-inner">
    <a class="brand" href="${home(lang)}" aria-label="${esc(c.nav.home)}">${theme.logo()}<span class="brand-name">${esc(theme.config.product)}</span></a>
    ${nav}
    <div class="header-actions">
      <a class="lang-switch" href="${switchHref}" hreflang="${other}" lang="${other}" data-lang-switch="${other}" aria-label="${c.nav.language}: ${other.toUpperCase()}"><span class="lang-current">${lang.toUpperCase()}</span><span class="lang-sep">/</span><span>${other.toUpperCase()}</span></a>
      <button class="theme-toggle" type="button" data-theme-toggle aria-label="${esc(c.nav.theme)}">${theme.glyph("theme")}</button>
      ${button(link.label[lang], theme.glyph("chevron"), { href: link.href[lang], className: "header-cta" })}
    </div>
  </div>
  ${divider ? `<div class="site-container">${divider}</div>` : ""}
</header>`;
}

function footer(ctx: Ctx, lang: Lang): string {
  const { theme, version: v } = ctx;
  const c = ctx.copy[lang];
  const { operator, repoUrl, contactEmail } = theme.config;
  const report = `mailto:${contactEmail}?subject=${encodeURIComponent(c.footer.reportSubject)}`;
  const commitHref = v.commit === "unknown" ? repoUrl : `${repoUrl}/tree/${v.commit.replace(/-dirty$/, "")}`;
  const brand = operator
    ? `<a class="footer-brand" href="${esc(operator.url[lang])}">${theme.logo()}<span>${c.footer.made} ${esc(operator.name)}</span></a>`
    : `<span class="footer-brand">${theme.logo()}<span>${c.footer.openSource}</span></span>`;
  const divider = theme.divider();
  return `<footer class="site-footer">
  <div class="site-container footer-inner">
    ${brand}
    <nav class="footer-links" aria-label="${c.footer.source}">
      <a href="${esc(repoUrl)}">${c.footer.source}</a>
      <a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a>
      <a href="${esc(report)}">${c.footer.report}</a>
    </nav>
    <p class="footer-copy"><a href="${esc(commitHref)}" data-version>${c.footer.version} ${esc(v.version)} · ${esc(v.short)}</a></p>
  </div>
  ${divider ? `<div class="site-container">${divider}</div>` : ""}
</footer>`;
}

function ttlSelect(ctx: Ctx, lang: Lang, id: string, defaultKey: string): string {
  const ui = ctx.copy[lang].ui;
  const options = TTL_CHOICES.map(
    (choice) =>
      `<option value="${choice.seconds}"${choice.key === defaultKey ? " selected" : ""}>${ui.ttl[choice.key]}</option>`,
  ).join("");
  return `<label class="field field--inline" for="${id}"><span class="field-label">${ui.ttlLabel}</span><select id="${id}" name="ttl">${options}</select></label>`;
}

function tool(ctx: Ctx, lang: Lang): string {
  const { theme } = ctx;
  const ui = ctx.copy[lang].ui;
  const max = new Intl.NumberFormat(ui.locale).format(LIMITS.plaintextChars);
  const chevron = theme.glyph("chevron");
  const check = theme.glyph("check");
  return `<div class="tool light-scope" id="${ANCHORS[lang].tool}" data-tool>
  <div class="tool-tabs" role="tablist">
    <button class="tool-tab" type="button" role="tab" id="tab-send" aria-controls="panel-send" aria-selected="true" data-tab="send">${theme.icon("key", 24)}<span>${ui.tabSend}</span></button>
    <button class="tool-tab" type="button" role="tab" id="tab-request" aria-controls="panel-request" aria-selected="false" tabindex="-1" data-tab="request">${theme.icon("inbox", 24)}<span>${ui.tabRequest}</span></button>
  </div>
  <section class="tool-panel" id="panel-send" role="tabpanel" aria-labelledby="tab-send">
    <form class="tool-form" data-form="send" novalidate>
      <label class="field" for="send-secret">
        <span class="field-label">${ui.secretLabel}</span>
        <textarea id="send-secret" name="secret" rows="5" maxlength="${LIMITS.plaintextChars}" placeholder="${esc(ui.secretPlaceholder)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-gramm="false" data-counter="send-counter" required></textarea>
        <span class="field-meta" id="send-counter">${fmt(ui.counter, { n: 0, max })}</span>
      </label>
      <div class="form-row">
        ${ttlSelect(ctx, lang, "send-ttl", "24h")}
        ${button(ui.sendButton, chevron, { type: "submit", id: "send-submit" })}
      </div>
      <p class="form-note">${check}<span>${ui.sendNote}</span></p>
      <p class="form-error" role="alert" hidden></p>
    </form>
    <div class="tool-result" data-result="send" hidden></div>
  </section>
  <section class="tool-panel" id="panel-request" role="tabpanel" aria-labelledby="tab-request" hidden>
    <form class="tool-form" data-form="request" novalidate>
      <label class="field" for="request-label">
        <span class="field-label">${ui.requestLabel}</span>
        <input id="request-label" name="label" type="text" maxlength="${LIMITS.labelChars}" placeholder="${esc(ui.requestPlaceholder)}" autocomplete="off" spellcheck="false" required>
        <span class="field-meta">${ui.requestHint}</span>
      </label>
      <div class="form-row">
        ${ttlSelect(ctx, lang, "request-ttl", "7d")}
        ${button(ui.requestButton, chevron, { type: "submit", id: "request-submit" })}
      </div>
      <p class="form-note">${check}<span>${ui.requestNote}</span></p>
      <p class="form-error" role="alert" hidden></p>
    </form>
    <div class="tool-result" data-result="request" hidden></div>
  </section>
</div>`;
}

function homeMain(ctx: Ctx, lang: Lang): string {
  const { theme } = ctx;
  const c = ctx.copy[lang];
  const a = ANCHORS[lang];
  const icon = (name: string, size: number) => theme.icon(name as IconName, size);
  const check = theme.glyph("check");
  const chevron = theme.glyph("chevron");
  const divider = theme.divider();
  const host = new URL(theme.config.origin).host;
  const h1 = c.hero.h1
    .split("\n")
    .map((line) => esc(line))
    .join("<br>");
  const steps = c.how.steps
    .map(
      (step, index) =>
        `<li><span class="step-icon">${icon(step.icon, 48)}<span class="step-number">${index + 1}</span></span><div><h3>${step.title}</h3><p>${step.text}</p></div></li>`,
    )
    .join("");
  const s = c.how.scene;
  const urlScene = `<figure class="scene scene--tint light-scope" data-scene>
  <figcaption class="kicker">${s.caption}</figcaption>
  <div class="url-card">
    <p class="url-line"><span class="url-part url-part--server">${esc(host)}/s/k7Q2xY9pLm3vT8wB4nR1sA</span><span class="url-part url-part--key">#AGE-SECRET-KEY-PQ-1QF3X7…</span></p>
    <div class="url-legend">
      <div class="legend legend--server"><span class="legend-bar" data-draw></span><strong>${s.server}</strong><span>${s.serverNote}</span></div>
      <div class="legend legend--key"><span class="legend-bar" data-draw></span><strong>${s.browser}</strong><span>${s.browserNote}</span></div>
    </div>
  </div>
  <div class="sees">
    <div class="sees-card"><h3>${s.sees}</h3><ul>${s.seesItems.map((item) => `<li>${check}<span>${item}</span></li>`).join("")}</ul></div>
    <div class="sees-card sees-card--dark"><h3>${s.blind}</h3><ul>${s.blindItems.map((item) => `<li>${theme.glyph("cross")}<span>${item}</span></li>`).join("")}</ul></div>
  </div>
</figure>`;

  const r = c.request.scene;
  const requestScene = `<figure class="scene scene--alt light-scope" data-scene>
  <figcaption class="kicker">${r.caption}</figcaption>
  <div class="mock-card">
    <div class="mock-top">${icon("inbox", 40)}<span class="badge badge--verified">${check}${esc(r.badge)}</span></div>
    <p class="mock-asks">${esc(r.asks)}</p>
    <p class="mock-label">${r.label}</p>
    <div class="mock-field"><span>••••••••••••••••••••••••••••</span></div>
    <span class="mock-button">${r.button}${chevron}</span>
  </div>
  <div class="mock-receipt">
    <div><span>${r.delivered}</span><strong>14:02</strong></div>
    <div><span>${r.read}</span><strong>14:05</strong></div>
    <span class="mock-progress" data-draw></span>
  </div>
</figure>`;

  const cards = c.uses.cards.map((card) => `<article class="card">${icon(card.icon, 48)}<h3>${card.title}</h3><p>${card.text}</p></article>`).join("");
  const security = c.security.items.map((item) => `<li>${icon(item.icon, 44)}<div><h3>${item.title}</h3><p>${item.text}</p></div></li>`).join("");
  const faq = c.faq.items
    .map((item) => `<details class="faq-item"><summary><span>${item.q}</span>${theme.glyph("plus")}</summary><p>${esc(item.a)}</p></details>`)
    .join("");
  const cta = theme.cta?.[lang];
  const email = theme.config.contactEmail;

  return `<main id="main" class="site-container page">
  <section class="hero">
    <div class="hero-copy">
      <p class="hero-label">${icon("shield", 44)}<span>${c.hero.label}</span></p>
      <h1>${h1}</h1>
      <p class="hero-lead">${c.hero.lead}</p>
      <ul class="hero-points">${c.hero.points.map((point) => `<li>${check}<span>${point}</span></li>`).join("")}</ul>
    </div>
    <div class="hero-art light-scope">${tool(ctx, lang)}</div>
  </section>

  <section class="section split" id="${a.how}">
    <div>
      <p class="kicker">${c.how.kicker}</p>
      <h2>${c.how.h2}</h2>
      <p class="section-lead">${c.how.lead}</p>
      <ol class="steps">${steps}</ol>
    </div>
    ${urlScene}
  </section>

  ${divider}
  <section class="section split section--dark" id="${a.request}">
    <div>
      <p class="kicker">${c.request.kicker}</p>
      <h2>${c.request.h2}</h2>
      ${c.request.paragraphs.map((text) => `<p class="section-lead">${text}</p>`).join("")}
      <div class="section-actions">${button(c.ui.tabRequest, chevron, { href: `#${a.tool}`, variant: "paper", attrs: 'data-open-tab="request"' })}</div>
    </div>
    ${requestScene}
  </section>

  <section class="section">
    <p class="kicker">${c.uses.kicker}</p>
    <div class="section-head"><h2>${c.uses.h2}</h2><p class="section-lead">${c.uses.lead}</p></div>
    <div class="cards">${cards}</div>
  </section>

  <section class="section" id="${a.security}">
    <p class="kicker">${c.security.kicker}</p>
    <h2>${c.security.h2}</h2>
    <ul class="feature-list">${security}</ul>
  </section>

  ${divider}
  <section class="section split faq" id="${a.faq}">
    <div>
      ${icon("lifebuoy", 48)}
      <h2>${c.faq.h2}</h2>
      <p class="section-lead">${c.faq.ask}</p>
      ${button(email, chevron, { href: `mailto:${email}`, variant: "soft" })}
    </div>
    <div class="faq-list">${faq}</div>
  </section>
${
  cta
    ? `
  <section class="cta">
    <div>
      <h2>${esc(cta.h2)}</h2>
      <p>${esc(cta.text)}</p>
    </div>
    ${button(cta.button, chevron, { href: cta.href, variant: "paper" })}
  </section>`
    : ""
}
</main>`;
}

function appMain(ctx: Ctx, lang: Lang, kind: "open" | "fill" | "owner"): string {
  const c = ctx.copy[lang];
  const art: Record<typeof kind, IconName> = { open: "key", fill: "inbox", owner: "eye" };
  return `<main id="main" class="site-container page app-page">
  <section class="app-stage light-scope">
    <div class="app-card light-scope" data-app="${kind}" aria-live="polite">
      <div class="app-icon">${ctx.theme.icon(art[kind], 56)}</div>
      <p class="app-loading">${c.ui.loading}</p>
    </div>
    <p class="app-footnote">${ctx.theme.glyph("check")}<span>${c.hero.points[0]} · ${c.hero.points[1]}</span></p>
  </section>
</main>`;
}

function notFoundMain(ctx: Ctx, lang: Lang): string {
  const c = ctx.copy[lang].notFound;
  return `<main id="main" class="site-container page app-page">
  <section class="app-stage light-scope">
    <div class="app-card light-scope">
      <div class="app-icon">${ctx.theme.icon("flag", 56)}</div>
      <h1 class="app-title">${c.title}</h1>
      <p>${c.text}</p>
      <div class="app-actions">${button(c.home, ctx.theme.glyph("chevron"), { href: home(lang) })}</div>
    </div>
  </section>
</main>`;
}

function structuredData(ctx: Ctx, lang: Lang): string {
  const { config } = ctx.theme;
  const c = ctx.copy[lang];
  const url = `${config.origin}${home(lang)}`;
  const orgId = config.operator ? `${config.operator.url.en.replace(/\/?$/, "/")}#organization` : null;
  const graph: Record<string, unknown>[] = [
    {
      "@type": "WebApplication",
      "@id": `${url}#app`,
      name: config.product,
      url,
      description: c.meta.description,
      applicationCategory: "SecurityApplication",
      operatingSystem: "Any",
      browserRequirements: "Requires JavaScript and a current browser",
      inLanguage: c.htmlLang,
      isAccessibleForFree: true,
      license: "https://opensource.org/licenses/MIT",
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      ...(orgId ? { publisher: { "@id": orgId } } : {}),
    },
    {
      "@type": "FAQPage",
      "@id": `${url}#faq`,
      name: c.faq.kicker,
      inLanguage: c.htmlLang,
      mainEntity: c.faq.items.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  ];
  if (config.operator && orgId) {
    graph.push({ "@type": "Organization", "@id": orgId, name: config.operator.name, url: config.operator.url.en, email: config.contactEmail });
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

/** Rule 2 from REFLECT.md: parse every JSON-LD block at build time. */
function validateJsonLd(html: string, page: string): void {
  for (const [, raw] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const data = JSON.parse(raw);
    const graph: Record<string, unknown>[] = data["@graph"] ?? [data];
    const types = graph.map((node) => node["@type"]);
    if (new Set(types).size !== types.length) throw new Error(`${page}: duplicate top-level @type`);
    const ids = new Set(graph.map((node) => node["@id"]).filter(Boolean));
    for (const [, ref] of raw.matchAll(/\{"@id":"([^"]+)"\}/g)) if (!ids.has(ref)) throw new Error(`${page}: dangling @id ${ref}`);
    for (const node of graph) if (!node["@type"] || !node.name) throw new Error(`${page}: node missing @type or name`);
  }
}

function page(ctx: Ctx, lang: Lang, kind: PageKind): string {
  const c = ctx.copy[lang];
  const product = ctx.theme.config.product;
  const title = kind === "home" ? c.meta.title : kind === "404" ? `${c.notFound.title} | ${product}` : `${c.appMeta[kind]} | ${product}`;
  const main = kind === "home" ? homeMain(ctx, lang) : kind === "404" ? notFoundMain(ctx, lang) : appMain(ctx, lang, kind);
  return `${head(ctx, lang, kind, title, c.meta.description)}
<body data-page="${kind}">
<!--email_off-->
${header(ctx, lang, kind)}
${main}
${footer(ctx, lang)}
<!--email_on-->
${glyphTemplates(ctx.theme)}
</body>
</html>
`;
}

/** Security headers for everything the Worker does not serve itself (see run_worker_first in wrangler.jsonc). */
function headersFile(indexable: boolean): string {
  const common = [
    `Content-Security-Policy: ${CSP}`,
    "Referrer-Policy: no-referrer",
    "X-Content-Type-Options: nosniff",
    "X-Frame-Options: DENY",
    "Strict-Transport-Security: max-age=31536000; includeSubDomains",
    "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    "Cross-Origin-Opener-Policy: same-origin",
    ...(indexable ? [] : ["X-Robots-Tag: noindex, nofollow"]),
  ];
  return [
    "/*",
    ...common.map((line) => `  ${line}`),
    "  Cross-Origin-Resource-Policy: same-origin",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/og-*",
    "  ! Cross-Origin-Resource-Policy",
    "  Cross-Origin-Resource-Policy: cross-origin",
    "",
  ].join("\n");
}

export async function build(): Promise<{ out: string; assets: Assets; version: Version }> {
  const theme = await loadTheme();
  const vars = workerVars();
  const out = resolve(process.env.VK_OUT ?? join(ROOT, "dist"));
  const base = coreCopy(theme.config);
  const copy = { lt: theme.copy ? theme.copy("lt", base.lt) : base.lt, en: theme.copy ? theme.copy("en", base.en) : base.en };
  const reserved = (vars.RESERVED_LABEL_WORDS ?? DEFAULT_RESERVED_WORDS.join(",")).split(",").map((w) => w.trim()).filter(Boolean);
  const ctx: Ctx = {
    theme,
    copy,
    assets: await bundle(theme, out),
    version: version(),
    indexable: vars.INDEXABLE === "true",
    reserved,
    out,
  };
  const write = (path: string, content: string) => {
    const full = join(out, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  for (const lang of LANGS) {
    const prefix = lang === "en" ? "en/" : "";
    const homeHtml = page(ctx, lang, "home");
    validateJsonLd(homeHtml, `${lang} home`);
    write(`${prefix}index.html`, homeHtml);
    write(`${prefix}404.html`, page(ctx, lang, "404"));
    for (const kind of ["open", "fill", "owner"] as const) write(`${prefix}_app/${kind}.html`, page(ctx, lang, kind));
  }
  write("_headers", headersFile(ctx.indexable));
  const origin = theme.config.origin;
  const today = new Date().toISOString().slice(0, 10);
  write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${["/", "/en"]
  .map(
    (path) =>
      `  <url><loc>${origin}${path}</loc><lastmod>${today}</lastmod><xhtml:link rel="alternate" hreflang="lt" href="${origin}/"/><xhtml:link rel="alternate" hreflang="en" href="${origin}/en"/></url>`,
  )
  .join("\n")}
</urlset>
`,
  );
  write(
    "llms.txt",
    `# ${theme.config.product}

> Free, open-source tool for sharing passwords and API keys with one-time links and request links. Text is encrypted in the browser with age (post-quantum hybrid keys, ML-KEM-768 + X25519); the server stores only ciphertext and deletes it on first read or at expiry (1 hour to 7 days).

- [Lithuanian page](${origin}/): send a one-time secret or ask someone for one
- [English page](${origin}/en): the same in English
- [Source code](${theme.config.repoUrl}): MIT license
`,
  );
  console.log(`built ${out} with theme ${theme.id} (${ctx.assets.app}, ${ctx.assets.css}, ${ctx.version.short})`);
  return { out, assets: ctx.assets, version: ctx.version };
}

if (import.meta.main) await build();
