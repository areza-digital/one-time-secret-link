// Browser side of Vienkartinė nuoroda. Plaintext and identities never leave this file except as age ciphertext.

import { decryptText, encryptText, isIdentity, newIdentity } from "../shared/crypto";
import {
  ID_PATTERN,
  LIMITS,
  authFromIdentity,
  cleanLabel,
  labelProblem,
  linkFor,
  type Lang,
  type PublicItem,
} from "../shared/protocol";
import type { UiCopy } from "../../site/copy";

type Ui = UiCopy & { lang: Lang; homePath: string; reserved: string[] };
type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };
type Child = Node | string | null | undefined | false;

const ui: Ui = JSON.parse(document.getElementById("ui-copy")?.textContent ?? "{}");
const POLL_FIRST_MS = 10_000;
const POLL_MAX_MS = 60_000;

// ---------- small helpers ----------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false) continue;
    if (key === "class") el.className = String(value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

function when(ms: number): string {
  return new Intl.DateTimeFormat(ui.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

const maxChars = new Intl.NumberFormat(ui.locale).format(LIMITS.plaintextChars);

async function api<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, data: data as T };
    return { ok: false, status: response.status, error: (data as { error?: string }).error ?? "error" };
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
}

function errorText(result: { status: number }): string {
  if (result.status === 0) return ui.errNetwork;
  if (result.status === 429) return ui.errRate;
  return ui.errGeneric;
}

/** The theme's chevron, rendered by the build into <template id="glyph-chevron">, so this file stays theme-free. */
function chevron(): Node {
  const template = document.getElementById("glyph-chevron") as HTMLTemplateElement | null;
  return template ? template.content.cloneNode(true) : document.createTextNode("");
}

function button(label: string, variant = "default", type: "button" | "submit" = "button"): HTMLButtonElement {
  return h(
    "button",
    { class: "button", "data-variant": variant, type },
    h("span", { class: "button-label" }, label),
    h("span", { class: "button-icon" }, chevron()),
  );
}

function linkButton(label: string, href: string, variant = "default"): HTMLAnchorElement {
  return h(
    "a",
    { class: "button", "data-variant": variant, href },
    h("span", { class: "button-label" }, label),
    h("span", { class: "button-icon" }, chevron()),
  );
}

function setButtonLabel(btn: HTMLButtonElement, label: string): void {
  const span = btn.querySelector(".button-label");
  if (span) span.textContent = label;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** A read-only field with a copy button. Multi-line values get a textarea. */
function copyRow(value: string, label: string, multiline = false): HTMLDivElement {
  const output = multiline
    ? h("textarea", { class: "output", readonly: true, rows: "5", "aria-label": label, spellcheck: "false" })
    : h("input", { class: "output", readonly: true, type: "text", "aria-label": label, spellcheck: "false" });
  output.value = value;
  const copy = h("button", { class: "copy-button", type: "button" }, ui.copy);
  copy.addEventListener("click", async () => {
    const done = await copyText(value);
    if (!done) {
      output.focus();
      output.select();
      return;
    }
    copy.textContent = ui.copied;
    setTimeout(() => (copy.textContent = ui.copy), 1800);
  });
  output.addEventListener("focus", () => output.select());
  return h("div", { class: "copy-row" }, output, copy);
}

function notice(text: string, tone: "info" | "warn" | "ok" | "error" = "info"): HTMLParagraphElement {
  const cls = tone === "info" ? "notice" : `notice notice--${tone}`;
  return h("p", { class: cls, role: tone === "error" ? "alert" : false }, text);
}

/** Two clicks so a stray click can't delete anything. No browser dialogs. */
function confirmButton(label: string, confirmLabel: string, onConfirm: () => Promise<void>): HTMLButtonElement {
  const btn = button(label, "danger");
  let armed = false;
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      setButtonLabel(btn, confirmLabel);
      setTimeout(() => {
        armed = false;
        setButtonLabel(btn, label);
      }, 4000);
      return;
    }
    btn.disabled = true;
    await onConfirm();
  });
  return btn;
}

function attachCounter(textarea: HTMLTextAreaElement, counter: HTMLElement): void {
  const update = () => (counter.textContent = fmt(ui.counter, { n: [...textarea.value].length, max: maxChars }));
  textarea.addEventListener("input", update);
  update();
}

function validSecret(value: string): string | null {
  if (!value.trim()) return ui.errEmpty;
  if ([...value].length > LIMITS.plaintextChars) return fmt(ui.errTooLong, { max: maxChars });
  return null;
}

function cryptoSupported(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined" && typeof TextEncoder !== "undefined";
}

/** Removes the key from the address bar, history and the language link once it is no longer needed. */
function forgetFragment(): void {
  history.replaceState(null, "", location.pathname + location.search);
  const switcher = document.querySelector<HTMLAnchorElement>("[data-lang-switch]");
  if (switcher) switcher.href = switcher.href.split("#")[0];
}

function itemIdFromPath(): string | null {
  const id = location.pathname.split("/").filter(Boolean).pop() ?? "";
  return ID_PATTERN.test(id) ? id : null;
}

function identityFromHash(): string | null {
  try {
    const value = decodeURIComponent(location.hash.slice(1)).trim();
    return isIdentity(value) ? value : null;
  } catch {
    return null; // a mangled % sequence: treat it like a missing key
  }
}

/**
 * Calls onItem with the item, or null once it is gone; skips network errors and hidden tabs.
 * Starts at 10 s and slows to one check a minute. Stops when onItem returns true or the returned stop is called.
 */
function poll(id: string, onItem: (item: PublicItem | null) => boolean): () => void {
  let delay = POLL_FIRST_MS;
  let stopped = false;
  let timer = 0;
  const tick = async () => {
    if (stopped) return;
    if (!document.hidden) {
      const result = await api<PublicItem>(`/api/items/${id}`);
      if (stopped) return;
      if ((result.ok || result.status === 404) && onItem(result.ok ? result.data : null)) return;
    }
    delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.4));
    timer = window.setTimeout(tick, delay);
  };
  timer = window.setTimeout(tick, delay);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** After a revoke the server may say the link was already read: then the secret was seen and must be rotated. */
async function revokedText(id: string, state: string): Promise<string> {
  if (state === "removed") return ui.statusRemoved;
  if (state !== "read") return ui.statusRevoked;
  const item = await api<PublicItem>(`/api/items/${id}`);
  return item.ok && item.data.readAt ? fmt(ui.statusRead, { date: when(item.data.readAt) }) : ui.statusRevoked;
}

// ---------- chrome: theme, language, scenes ----------

function setupChrome(): void {
  document.querySelector<HTMLButtonElement>("[data-theme-toggle]")?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Private mode: the toggle still works for this page view.
    }
  });

  const page = document.body.dataset.page;
  const switcher = document.querySelector<HTMLAnchorElement>("[data-lang-switch]");
  if (switcher && (page === "open" || page === "fill" || page === "owner")) {
    const other = switcher.dataset.langSwitch;
    const path = location.pathname.replace(/^\/en(?=\/)/, "");
    switcher.href = `${other === "en" ? "/en" : ""}${path}${location.hash}`;
    window.addEventListener("hashchange", () => (switcher.href = `${other === "en" ? "/en" : ""}${path}${location.hash}`));
  }

  const scenes = document.querySelectorAll<HTMLElement>("[data-scene]");
  if (scenes.length && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.visible = "";
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.3 },
    );
    scenes.forEach((scene) => observer.observe(scene));
  } else {
    scenes.forEach((scene) => (scene.dataset.visible = ""));
  }
}

// ---------- home: the tool ----------

function setupHome(): void {
  const tool = document.querySelector<HTMLElement>("[data-tool]");
  if (!tool) return;
  const tabs = [...tool.querySelectorAll<HTMLButtonElement>("[data-tab]")];

  const select = (name: string, focus = false) => {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !active;
      if (active && focus) tab.focus();
    }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab.dataset.tab ?? "send"));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      select(next.dataset.tab ?? "send", true);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-open-tab]").forEach((link) =>
    link.addEventListener("click", () => select(link.dataset.openTab ?? "send")),
  );

  const sendForm = tool.querySelector<HTMLFormElement>('[data-form="send"]');
  const requestForm = tool.querySelector<HTMLFormElement>('[data-form="request"]');
  const textarea = sendForm?.querySelector("textarea");
  const counter = document.getElementById("send-counter");
  if (textarea && counter) attachCounter(textarea, counter);
  if (sendForm) setupSendForm(sendForm);
  if (requestForm) setupRequestForm(requestForm);
}

function formError(form: HTMLFormElement, message: string | null): void {
  const box = form.querySelector<HTMLElement>(".form-error");
  if (!box) return;
  box.hidden = !message;
  box.textContent = message ?? "";
}

async function busy<T>(btn: HTMLButtonElement | null, label: string, work: () => Promise<T>): Promise<T> {
  const original = btn?.querySelector(".button-label")?.textContent ?? "";
  if (btn) {
    btn.disabled = true;
    setButtonLabel(btn, label);
  }
  try {
    return await work();
  } finally {
    if (btn) {
      btn.disabled = false;
      setButtonLabel(btn, original);
    }
  }
}

function setupSendForm(form: HTMLFormElement): void {
  const result = document.querySelector<HTMLElement>('[data-result="send"]');
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!cryptoSupported()) return formError(form, ui.errCrypto);
    const field = form.querySelector("textarea");
    const secret = field?.value ?? "";
    const invalid = validSecret(secret);
    if (invalid) return formError(form, invalid);
    formError(form, null);
    const ttl = Number(form.querySelector("select")?.value);

    await busy(form.querySelector("button[type=submit]"), ui.working, async () => {
      let ciphertext: string;
      let identity: string;
      try {
        const keys = await newIdentity();
        identity = keys.identity;
        ciphertext = await encryptText(secret, keys.recipient);
      } catch {
        return formError(form, ui.errCrypto);
      }
      const auth = await authFromIdentity(identity);
      const created = await api<{ id: string; expiresAt: number; manageToken: string }>("/api/items", {
        kind: "send",
        ciphertext,
        ttl,
        auth,
      });
      if (!created.ok) return formError(form, errorText(created));
      if (field) field.value = "";
      form.hidden = true;
      if (result) renderSendResult(result, form, created.data, linkFor(location.origin, ui.lang, "s", created.data.id, identity));
    });
  });
}

function renderSendResult(
  container: HTMLElement,
  form: HTMLFormElement,
  created: { id: string; expiresAt: number; manageToken: string },
  link: string,
): void {
  const status = h("strong", {}, ui.statusOpen);
  const statusLine = h("p", { class: "status-line" }, h("span", {}, ui.statusLabel), status);
  let stop = () => {};

  const finish = (text: string) => {
    status.textContent = text;
    revoke.remove();
    stop();
  };
  const revoke = confirmButton(ui.revoke, ui.revokeConfirm, async () => {
    const outcome = await api<{ state: string }>(`/api/items/${created.id}/revoke`, { manageToken: created.manageToken });
    if (outcome.ok) finish(await revokedText(created.id, outcome.data.state));
  });
  const again = button(ui.newOne, "outline");
  again.addEventListener("click", () => {
    stop();
    container.replaceChildren();
    container.hidden = true;
    form.hidden = false;
    form.querySelector("textarea")?.dispatchEvent(new Event("input"));
    form.querySelector("textarea")?.focus();
  });

  container.replaceChildren(
    h("h3", { class: "result-title" }, ui.sendResultTitle),
    h(
      "div",
      { class: "result-block" },
      copyRow(link, ui.linkLabel),
      h("p", {}, fmt(ui.sendResultText, { date: when(created.expiresAt) })),
    ),
    statusLine,
    h("div", { class: "result-actions" }, again, revoke),
  );
  container.hidden = false;
  container.querySelector<HTMLInputElement>(".output")?.focus();

  stop = poll(created.id, (item) => {
    if (item === null) finish(ui.statusGone);
    else if (item.state === "read" && item.readAt) finish(fmt(ui.statusRead, { date: when(item.readAt) }));
    else if (item.state === "revoked") finish(ui.statusRevoked);
    else if (item.state === "removed") finish(ui.statusRemoved);
    else return false;
    return true;
  });
}

function setupRequestForm(form: HTMLFormElement): void {
  const result = document.querySelector<HTMLElement>('[data-result="request"]');
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!cryptoSupported()) return formError(form, ui.errCrypto);
    const input = form.querySelector("input");
    const label = cleanLabel(input?.value ?? "");
    if (!label) return formError(form, fmt(ui.errLabel, { max: LIMITS.labelChars }));
    const problem = labelProblem(label, ui.reserved);
    if (problem) return formError(form, problem === "reserved" ? ui.errLabelReserved : ui.errLabelSuspicious);
    formError(form, null);
    const ttl = Number(form.querySelector("select")?.value);

    await busy(form.querySelector("button[type=submit]"), ui.working, async () => {
      let keys: { identity: string; recipient: string };
      try {
        keys = await newIdentity();
      } catch {
        return formError(form, ui.errCrypto);
      }
      const created = await api<{ id: string; expiresAt: number }>("/api/items", {
        kind: "request",
        recipient: keys.recipient,
        label,
        ttl,
        auth: await authFromIdentity(keys.identity),
      });
      if (!created.ok) {
        const message =
          created.error === "label_reserved" ? ui.errLabelReserved : created.error === "label_suspicious" ? ui.errLabelSuspicious : errorText(created);
        return formError(form, message);
      }
      if (input) input.value = "";
      form.hidden = true;
      const share = linkFor(location.origin, ui.lang, "r", created.data.id);
      const owner = linkFor(location.origin, ui.lang, "o", created.data.id, keys.identity);
      if (result) renderRequestResult(result, form, share, owner);
    });
  });
}

function renderRequestResult(container: HTMLElement, form: HTMLFormElement, share: string, owner: string): void {
  const again = button(ui.newOne, "outline");
  again.addEventListener("click", () => {
    container.replaceChildren();
    container.hidden = true;
    form.hidden = false;
    form.querySelector("input")?.focus();
  });
  const open = linkButton(ui.openOwner, owner);
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  container.replaceChildren(
    h("h3", { class: "result-title" }, ui.requestResultTitle),
    h("div", { class: "result-block" }, h("h3", {}, ui.shareTitle), copyRow(share, ui.shareTitle), h("p", {}, ui.shareText)),
    h("div", { class: "result-block" }, h("h3", {}, ui.ownerTitle), copyRow(owner, ui.ownerTitle), notice(ui.ownerText, "warn")),
    h("div", { class: "result-actions" }, open, again),
  );
  container.hidden = false;
}

// ---------- app pages ----------

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-app]");
}

function keepIcon(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(".app-icon");
}

function show(root: HTMLElement, ...children: Child[]): void {
  const iconRow = keepIcon(root);
  root.replaceChildren(...([iconRow, ...children].filter(Boolean) as Node[]));
}

function verifiedBadge(item: PublicItem): HTMLElement | null {
  if (!item.verified || !item.verifiedName) return null;
  return h("span", { class: "badge badge--verified" }, fmt(ui.verified, { name: item.verifiedName }));
}

function homeButton(): HTMLAnchorElement {
  return linkButton(ui.home, ui.homePath, "outline");
}

function addBadge(root: HTMLElement, item: PublicItem): void {
  const badge = verifiedBadge(item);
  const iconRow = keepIcon(root);
  if (badge && iconRow) iconRow.append(badge);
}

async function loadItem(root: HTMLElement, id: string | null): Promise<PublicItem | null> {
  if (!id) {
    show(root, notice(ui.gone, "warn"), h("div", { class: "app-actions" }, homeButton()));
    return null;
  }
  const result = await api<PublicItem>(`/api/items/${id}`);
  if (result.ok) return result.data;
  show(
    root,
    notice(result.status === 404 ? ui.gone : errorText(result), result.status === 404 ? "warn" : "error"),
    h("div", { class: "app-actions" }, homeButton()),
  );
  return null;
}

function revealed(root: HTMLElement, plaintext: string, title: string, after: string): void {
  show(
    root,
    h("h1", { class: "app-title" }, title),
    copyRow(plaintext, ui.secretOut, true),
    notice(after, "ok"),
    h("div", { class: "app-actions" }, homeButton()),
  );
  root.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

/** Back/forward cache must not bring a revealed secret back. */
window.addEventListener("pagehide", () => {
  document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("[data-app] .output").forEach((el) => (el.value = ""));
});

async function setupOpen(root: HTMLElement): Promise<void> {
  const identity = identityFromHash();
  if (!identity) return show(root, h("h1", { class: "app-title" }, ui.openTitle), notice(ui.missingKey, "warn"));
  const id = itemIdFromPath();
  const item = await loadItem(root, id);
  if (!item || !id) return;
  if (item.kind !== "send") return show(root, notice(ui.gone, "warn"), h("div", { class: "app-actions" }, homeButton()));
  addBadge(root, item);

  if (item.state === "read" && item.readAt) {
    return show(root, h("h1", { class: "app-title" }, ui.openTitle), notice(fmt(ui.alreadyRead, { date: when(item.readAt) }), "warn"));
  }
  if (item.state === "revoked") return show(root, h("h1", { class: "app-title" }, ui.openTitle), notice(ui.revokedSend, "warn"));
  if (item.state === "removed") return show(root, h("h1", { class: "app-title" }, ui.openTitle), notice(ui.removedNotice, "warn"));

  const error = h("p", { class: "notice notice--error", role: "alert", hidden: true });
  const reveal = button(ui.reveal);
  reveal.addEventListener("click", async () => {
    if (!cryptoSupported()) {
      error.hidden = false;
      error.textContent = ui.errCrypto;
      return;
    }
    reveal.disabled = true;
    const opened = await api<{ ciphertext: string }>(`/api/items/${id}/open`, { auth: await authFromIdentity(identity) });
    if (!opened.ok) {
      reveal.disabled = false;
      if (opened.status === 403) {
        error.hidden = false;
        error.textContent = ui.wrongKey;
        return;
      }
      if (opened.status === 409 || opened.status === 404) return setupOpen(root);
      error.hidden = false;
      error.textContent = errorText(opened);
      return;
    }
    try {
      const plaintext = await decryptText(opened.data.ciphertext, identity);
      forgetFragment();
      revealed(root, plaintext, ui.openTitle, ui.revealed);
    } catch {
      error.hidden = false;
      error.textContent = ui.wrongKey;
    }
  });

  show(
    root,
    h("h1", { class: "app-title" }, ui.openTitle),
    h("p", {}, ui.openIntro),
    h("p", {}, fmt(ui.validUntil, { date: when(item.expiresAt) })),
    error,
    h("div", { class: "app-actions" }, reveal),
  );
}

async function setupFill(root: HTMLElement): Promise<void> {
  const id = itemIdFromPath();
  const item = await loadItem(root, id);
  if (!item || !id) return;
  if (item.kind !== "request") return show(root, notice(ui.gone, "warn"), h("div", { class: "app-actions" }, homeButton()));
  addBadge(root, item);

  // Verified requests may use their label as the headline. Anonymous ones get a neutral headline and the label as a
  // quoted message under the warning, so a label can never pose as the page's own words.
  const heading: Node[] =
    item.verified && item.verifiedName
      ? [h("p", { class: "app-kicker kicker" }, fmt(ui.fillTitleVerified, { name: item.verifiedName })), h("h1", { class: "app-title" }, item.label ?? "")]
      : [
          h("h1", { class: "app-title" }, ui.fillTitleAnonHeadline),
          h("figure", { class: "label-quote" }, h("figcaption", {}, ui.fillTitleAnon), h("blockquote", {}, item.label ?? "")),
        ];

  if (!item.verified) heading.splice(1, 0, notice(ui.warnAnon, "warn"));

  if (item.state === "filled" && item.filledAt) return show(root, ...heading, notice(fmt(ui.fillFilled, { date: when(item.filledAt) }), "ok"));
  if (item.state === "read" && item.filledAt && item.readAt) {
    return show(root, ...heading, notice(fmt(ui.fillRead, { filled: when(item.filledAt), read: when(item.readAt) }), "ok"));
  }
  if (item.state === "revoked") return show(root, ...heading, notice(ui.fillRevoked, "warn"));
  if (item.state === "removed") return show(root, ...heading, notice(ui.removedNotice, "warn"));
  if (!item.recipient) return show(root, ...heading, notice(ui.gone, "warn"));
  const recipient = item.recipient;

  const textarea = h("textarea", {
    id: "fill-secret",
    rows: "6",
    maxlength: String(LIMITS.plaintextChars),
    placeholder: ui.fillPlaceholder,
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    "data-gramm": "false",
  });
  const counter = h("span", { class: "field-meta" });
  attachCounter(textarea, counter);
  const submit = button(ui.fillButton, "default", "submit");
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "tool-form", novalidate: true },
    h("label", { class: "field", for: "fill-secret" }, h("span", { class: "field-label" }, ui.fillLabel), textarea, counter),
    error,
    h("div", { class: "app-actions" }, submit),
    h("p", { class: "form-note" }, ui.fillNote),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fail = (message: string) => {
      error.hidden = false;
      error.textContent = message;
    };
    if (!cryptoSupported()) return fail(ui.errCrypto);
    const invalid = validSecret(textarea.value);
    if (invalid) return fail(invalid);
    error.hidden = true;
    await busy(submit, ui.working, async () => {
      let ciphertext: string;
      try {
        ciphertext = await encryptText(textarea.value, recipient);
      } catch {
        return fail(ui.errCrypto);
      }
      const filled = await api<{ filledAt: number }>(`/api/items/${id}/fill`, { ciphertext });
      if (!filled.ok && filled.status === 409) {
        const latest = await api<PublicItem>(`/api/items/${id}`);
        const at = latest.ok && latest.data.filledAt ? when(latest.data.filledAt) : "";
        return fail(fmt(ui.fillConflict, { date: at }));
      }
      if (!filled.ok) return fail(errorText(filled));
      textarea.value = "";
      show(
        root,
        ...heading,
        notice(fmt(ui.fillSent, { date: when(filled.data.filledAt) }), "ok"),
        h("p", {}, ui.fillSentHint),
      );
    });
  });

  show(root, ...heading, form);
  textarea.focus();
}

async function setupOwner(root: HTMLElement): Promise<void> {
  const identity = identityFromHash();
  if (!identity) return show(root, h("h1", { class: "app-title" }, ui.ownerTitle2), notice(ui.missingKey, "warn"));
  const id = itemIdFromPath();
  const item = await loadItem(root, id);
  if (!item || !id) return;
  if (item.kind !== "request") return show(root, notice(ui.gone, "warn"), h("div", { class: "app-actions" }, homeButton()));
  addBadge(root, item);
  const heading = () => [h("p", { class: "app-kicker kicker" }, ui.ownerTitle2), h("h1", { class: "app-title" }, item.label ?? "")];
  const auth = await authFromIdentity(identity);
  let stop = () => {};
  let lastState: string | null = null;

  /** Wrong value, or somebody else answered first: discard the answer and wait for a new one on the same link. */
  const rejectButton = () => {
    const reject = confirmButton(ui.ownerReject, ui.revokeConfirm, async () => {
      const outcome = await api<{ state: string }>(`/api/items/${id}/reopen`, { auth });
      if (!outcome.ok) return;
      const fresh = await api<PublicItem>(`/api/items/${id}`);
      if (fresh.ok) {
        render(fresh.data, ui.ownerRejected);
        watch();
      }
    });
    return reject;
  };

  const render = (current: PublicItem | null, note?: string): boolean => {
    lastState = current?.state ?? "gone";
    if (!current) {
      show(root, ...heading(), notice(ui.gone, "warn"));
      return true;
    }
    if (current.state === "read" && current.readAt) {
      show(
        root,
        ...heading(),
        notice(fmt(ui.ownerRead, { date: when(current.readAt) }), "warn"),
        h("div", { class: "app-actions" }, rejectButton()),
      );
      return true;
    }
    if (current.state === "revoked" || current.state === "removed") {
      show(root, ...heading(), notice(current.state === "removed" ? ui.removedNotice : ui.ownerRevoked, "warn"));
      return true;
    }
    if (current.state === "filled" && current.filledAt) {
      const error = h("p", { class: "notice notice--error", role: "alert", hidden: true });
      const reveal = button(ui.ownerReveal);
      reveal.addEventListener("click", async () => {
        reveal.disabled = true;
        const opened = await api<{ ciphertext: string }>(`/api/items/${id}/open`, { auth });
        if (!opened.ok) {
          reveal.disabled = false;
          error.hidden = false;
          error.textContent = opened.status === 403 ? ui.wrongKey : errorText(opened);
          return;
        }
        try {
          const plaintext = await decryptText(opened.data.ciphertext, identity);
          revealed(root, plaintext, item.label ?? ui.ownerTitle2, ui.ownerRevealed);
          root.querySelector(".app-actions")?.prepend(rejectButton());
        } catch {
          error.hidden = false;
          error.textContent = ui.wrongKey;
        }
      });
      show(
        root,
        ...heading(),
        notice(fmt(ui.ownerReceived, { date: when(current.filledAt) }), "ok"),
        error,
        h("div", { class: "app-actions" }, reveal),
      );
      return true;
    }
    const revoke = confirmButton(ui.ownerRevoke, ui.revokeConfirm, async () => {
      const outcome = await api<{ state: string }>(`/api/items/${id}/revoke`, { auth });
      if (outcome.ok) {
        stop();
        render({ ...current, state: "revoked" });
      }
    });
    show(
      root,
      ...heading(),
      note ? notice(note, "ok") : null,
      notice(ui.ownerWaiting),
      h("div", { class: "result-block" }, h("h3", {}, ui.ownerShare), copyRow(linkFor(location.origin, ui.lang, "r", id), ui.ownerShare)),
      h("p", {}, fmt(ui.validUntil, { date: when(current.expiresAt) })),
      h("div", { class: "app-actions" }, revoke),
    );
    return false;
  };

  const watch = () => {
    stop();
    stop = poll(id, (next) => (next && next.state === lastState ? false : render(next)));
  };
  if (!render(item)) watch();
}

// ---------- boot ----------

setupChrome();
const page = document.body.dataset.page;
if (page === "home") setupHome();
const root = card();
if (root && page === "open") void setupOpen(root);
if (root && page === "fill") void setupFill(root);
if (root && page === "owner") void setupOwner(root);
