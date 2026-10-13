// Tiny HTML helpers. Everything visual (icons, logo, glyphs) comes from the theme.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** A button or link. `chevron` is the theme's chevron glyph; pass "" for none. */
export function button(
  label: string,
  chevron: string,
  options: { href?: string; variant?: string; id?: string; type?: string; attrs?: string; className?: string } = {},
): string {
  const { href, variant = "default", id, type = "button", attrs = "", className = "" } = options;
  const cls = `button${className ? ` ${className}` : ""}`;
  const inner = `<span class="button-label">${esc(label)}</span>${chevron ? `<span class="button-icon">${chevron}</span>` : ""}`;
  const idAttr = id ? ` id="${id}"` : "";
  if (href) return `<a class="${cls}" data-variant="${variant}" href="${esc(href)}"${idAttr} ${attrs}>${inner}</a>`;
  return `<button class="${cls}" data-variant="${variant}" type="${type}"${idAttr} ${attrs}>${inner}</button>`;
}
