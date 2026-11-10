// Routes: /api/* (JSON), the app pages /s|r|o/:id (+ /en/), and static assets with security headers.
// /api/stats (operator token only) returns the daily totals that count() adds up after each successful action.

import {
  AUTH_PATTERN,
  ID_PATTERN,
  LIMITS,
  TOKEN_PATTERN,
  cleanLabel,
  isArmoredAge,
  labelProblem,
  reservedWords,
  isRecipient,
  isTtl,
  randomToken,
  sha256Hex,
  type PublicItem,
} from "../shared/protocol";
import { STATS_DAYS, type StatKind } from "../shared/stats";
import type { SecretBox, StoredItem } from "./box";
import { CSP } from "./csp";
import { ipBucket } from "./ip";
import type { RateLimiter } from "./limiter";
import { STATS_OBJECT } from "./stats";

export { SecretBox } from "./box";
export { RateLimiter } from "./limiter";

export interface Env {
  ASSETS: Fetcher;
  BOXES: DurableObjectNamespace<SecretBox>;
  LIMITS: DurableObjectNamespace<RateLimiter>;
  VERIFIED_NAME: string;
  INDEXABLE: string;
  /** Comma-separated link-preview bots (e.g. LinkedInBot) that may read the landing pages while INDEXABLE is "false". */
  PREVIEW_BOTS?: string;
  /** Comma-separated words anonymous request labels may not contain (defaults: verif, patvirtin, official, oficial). */
  RESERVED_LABEL_WORDS?: string;
  /** SHA-256 hex of the operator token: requests carrying it are "verified" and skip IP limits. */
  OPERATOR_TOKEN_SHA256?: string;
  IP_SALT?: string;
  /** Optional Workers Rate Limiting bindings: per-location, in-memory, checked before any Durable Object is touched. */
  RL_CREATE?: RateLimit;
  RL_FILL?: RateLimit;
  RL_OPEN?: RateLimit;
  RL_READ?: RateLimit;
}

const HOUR = 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;

/** Per hashed IP (IPv6 per /64), per hour. Operator-token calls skip these. */
const IP_LIMITS = { create: 30, fill: 30, open: 60, read: 600 } as const;
/** Anonymous creates for everyone together, per hour: a flood blocks new links for an hour, not a day. */
const GLOBAL_HOURLY_CREATES = 500;

const APP_PAGE = /^\/(?:(en)\/)?([sro])\/([^/]+)\/?$/;
const SHELLS = { s: "open", r: "fill", o: "owner" } as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return withHeaders(await api(request, env, ctx, url), "api");
      if (url.pathname === "/robots.txt") return withHeaders(robots(env, url), "static");
      if (/^\/(?:en\/)?_app\//.test(url.pathname)) return notFound(env, request, url.pathname.startsWith("/en/"));

      const page = APP_PAGE.exec(url.pathname);
      if (page) {
        const [, lang, kind, id] = page;
        if (!ID_PATTERN.test(id)) return notFound(env, request, lang === "en");
        const shell = `${lang === "en" ? "/en" : ""}/_app/${SHELLS[kind as keyof typeof SHELLS]}`;
        const response = await env.ASSETS.fetch(new Request(new URL(shell, url), { method: "GET" }));
        return withHeaders(response, "app");
      }

      const response = await env.ASSETS.fetch(request);
      const kind = url.pathname.startsWith("/assets/") ? "immutable" : "static";
      return withHeaders(response, kind, env.INDEXABLE !== "true");
    } catch (error) {
      console.error("unhandled", error instanceof Error ? error.message : "unknown");
      return withHeaders(json({ error: "server_error" }, 500), "api");
    }
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "items", id?, action?]
  // Operator only. Everyone else gets the 404 of any unknown path, so the route can't even be found.
  if (parts[1] === "stats" && parts.length === 2 && request.method === "GET" && (await isOperator(request, env))) {
    return stats(env, url);
  }
  if (parts[1] !== "items" || parts.length > 4) return json({ error: "not_found" }, 404);
  const id = parts[2];
  const action = parts[3];
  if (id !== undefined && !ID_PATTERN.test(id)) return json({ error: "not_found" }, 404);

  const operator = await isOperator(request, env);
  const now = Date.now();

  if (request.method === "GET" && id && !action) {
    if (!operator && !(await allowed(env, request, "read"))) return json({ error: "rate_limited" }, 429);
    const item = await box(env, id).describe(now);
    if (!item) return json({ error: "not_found" }, 404);
    const body: PublicItem = { ...item, verifiedName: item.verified ? env.VERIFIED_NAME : null };
    return json(body);
  }

  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: "bad_request" }, 400);

  if (!id) return create(env, ctx, request, body, operator, now);

  if (action === "fill") {
    if (!operator && !(await allowed(env, request, "fill"))) return json({ error: "rate_limited" }, 429);
    if (!validCiphertext(body.ciphertext)) return json({ error: "bad_request" }, 400);
    const outcome = await box(env, id).fill(body.ciphertext, now);
    if (outcome.ok) count(env, ctx, "fill");
    return result(outcome, (filledAt) => ({ filledAt }));
  }

  if (action === "reopen") {
    if (!operator && !(await allowed(env, request, "open"))) return json({ error: "rate_limited" }, 429);
    if (typeof body.auth !== "string" || !AUTH_PATTERN.test(body.auth)) return json({ error: "bad_request" }, 400);
    return result(await box(env, id).reopen(await sha256Hex(body.auth), now), (state) => ({ state }));
  }

  if (action === "open") {
    if (!operator && !(await allowed(env, request, "open"))) return json({ error: "rate_limited" }, 429);
    if (typeof body.auth !== "string" || !AUTH_PATTERN.test(body.auth)) return json({ error: "bad_request" }, 400);
    const outcome = await box(env, id).open(await sha256Hex(body.auth), now);
    if (outcome.ok) count(env, ctx, "open");
    return result(outcome, (ciphertext) => ({ ciphertext }));
  }

  if (action === "revoke") {
    // The operator token can take down anything (abuse reports); everyone else needs the item's own token.
    if (operator && body.admin === true) return result(await box(env, id).revoke(null, now), (state) => ({ state }));
    if (!operator && !(await allowed(env, request, "open"))) return json({ error: "rate_limited" }, 429);
    const token = typeof body.auth === "string" ? body.auth : body.manageToken;
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return json({ error: "bad_request" }, 400);
    return result(await box(env, id).revoke(await sha256Hex(token), now), (state) => ({ state }));
  }

  return json({ error: "not_found" }, 404);
}

async function create(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  body: Record<string, unknown>,
  operator: boolean,
  now: number,
): Promise<Response> {
  const { kind, ttl, auth } = body;
  if (kind !== "send" && kind !== "request") return json({ error: "bad_request" }, 400);
  if (!isTtl(ttl) || typeof auth !== "string" || !AUTH_PATTERN.test(auth)) return json({ error: "bad_request" }, 400);

  let label: string | null = null;
  let recipient: string | null = null;
  let ciphertext: string | null = null;
  if (kind === "send") {
    if (!validCiphertext(body.ciphertext)) return json({ error: "bad_request" }, 400);
    ciphertext = body.ciphertext;
  } else {
    label = cleanLabel(body.label);
    if (!label || !isRecipient(body.recipient)) return json({ error: "bad_request" }, 400);
    const problem = operator ? null : labelProblem(label, reservedWords(env.RESERVED_LABEL_WORDS));
    if (problem) return json({ error: `label_${problem}` }, 400);
    recipient = body.recipient;
  }

  if (!operator) {
    if (!(await allowed(env, request, "create"))) return json({ error: "rate_limited" }, 429);
    const global = env.LIMITS.get(env.LIMITS.idFromName("global"));
    if (!(await global.hit("create", GLOBAL_HOURLY_CREATES, HOUR))) return json({ error: "rate_limited" }, 429);
  }

  const id = randomToken(16);
  const manageToken = kind === "send" ? randomToken() : null;
  const item: StoredItem = {
    id,
    kind,
    state: "open",
    verified: operator,
    label,
    recipient,
    ciphertext,
    authHash: await sha256Hex(auth),
    manageHash: manageToken ? await sha256Hex(manageToken) : null,
    createdAt: now,
    expiresAt: now + ttl * 1000,
    filledAt: null,
    readAt: null,
  };
  if (!(await box(env, id).create(item))) return json({ error: "server_error" }, 500);
  count(env, ctx, kind);
  return json({ id, expiresAt: item.expiresAt, ...(manageToken ? { manageToken } : {}) }, 201);
}

/**
 * Adds one to today's total for a kind of action. Nothing waits for it (waitUntil) and its errors stop here: the
 * visitor is never slowed down by it and never sees it fail. Only the kind is passed on, nothing about who.
 */
function count(env: Env, ctx: ExecutionContext, kind: StatKind): void {
  ctx.waitUntil(
    (async () => {
      try {
        await env.LIMITS.get(env.LIMITS.idFromName(STATS_OBJECT)).tally(kind);
      } catch (error) {
        console.error("stats", error instanceof Error ? error.message : "unknown");
      }
    })(),
  );
}

async function stats(env: Env, url: URL): Promise<Response> {
  const days = Number(url.searchParams.get("days") ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > STATS_DAYS) return json({ error: "bad_request" }, 400);
  const rows = await env.LIMITS.get(env.LIMITS.idFromName(STATS_OBJECT)).totals(days);
  return json({ retentionDays: STATS_DAYS, days: rows });
}

function box(env: Env, id: string) {
  return env.BOXES.get(env.BOXES.idFromName(id));
}

function validCiphertext(value: unknown): value is string {
  return isArmoredAge(value) && new TextEncoder().encode(value).length <= LIMITS.ciphertextBytes;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return null;
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES || !request.body) return null;
  // Read at most MAX_BODY_BYTES, even when Content-Length is missing or lies.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function isOperator(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match || !env.OPERATOR_TOKEN_SHA256) return false;
  const given = new TextEncoder().encode(await sha256Hex(match[1]));
  const expected = new TextEncoder().encode(env.OPERATOR_TOKEN_SHA256.trim().toLowerCase());
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

/**
 * Two layers. First the Workers Rate Limiting binding (per minute, in memory, free of Durable Object requests), so a
 * flood is turned away before it costs quota. Then, for writes, the hourly Durable Object counter, which is exact.
 * Reads rely on the first layer only when it is configured.
 */
async function allowed(env: Env, request: Request, bucket: keyof typeof IP_LIMITS): Promise<boolean> {
  if (!env.IP_SALT) throw new Error("IP_SALT is not set"); // fail closed rather than hash with a public salt
  const ip = ipBucket(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const day = new Date().toISOString().slice(0, 10);
  const key = await sha256Hex(`${env.IP_SALT}|${day}|${ip}`);
  const fast = { create: env.RL_CREATE, fill: env.RL_FILL, open: env.RL_OPEN, read: env.RL_READ }[bucket];
  if (fast && !(await fast.limit({ key })).success) return false;
  if (bucket === "read" && fast) return true;
  return env.LIMITS.get(env.LIMITS.idFromName(`ip:${key}`)).hit(bucket, IP_LIMITS[bucket], HOUR);
}

function result<T>(
  outcome: { ok: true; value: T } | { ok: false; error: "not_found" | "forbidden" | "conflict" },
  shape: (value: T) => Record<string, unknown>,
): Response {
  if (outcome.ok) return json(shape(outcome.value));
  const status = { not_found: 404, forbidden: 403, conflict: 409 }[outcome.error];
  return json({ error: outcome.error }, status);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function robots(env: Env, url: URL): Response {
  const appPages = ["/s/", "/r/", "/o/", "/en/s/", "/en/r/", "/en/o/", "/api/"].map((path) => `Disallow: ${path}`);
  // Preview bots get the landing pages (and the social image) for a link card; the noindex tags keep them out of search.
  const bots = (env.PREVIEW_BOTS ?? "").split(",").map((bot) => bot.trim()).filter((bot) => /^[A-Za-z0-9_.-]+$/.test(bot));
  const previews = bots.length ? [...bots.map((bot) => `User-agent: ${bot}`), "Allow: /", ...appPages, ""] : [];
  const lines =
    env.INDEXABLE === "true"
      ? ["User-agent: *", "Allow: /", ...appPages, "", `Sitemap: ${url.origin}/sitemap.xml`]
      : [...previews, "User-agent: *", "Disallow: /"];
  return new Response(`${lines.join("\n")}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function notFound(env: Env, request: Request, english = false): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL(english ? "/en/404" : "/404", request.url)));
  return withHeaders(new Response(page.body, { status: 404, headers: page.headers }), "app");
}

function withHeaders(response: Response, kind: "api" | "app" | "static" | "immutable", noindex = false): Response {
  const out = new Response(response.body, response);
  const headers = out.headers;
  headers.set("Content-Security-Policy", CSP);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (kind === "api" || kind === "app") {
    headers.set("Cache-Control", "no-store");
    headers.set("X-Robots-Tag", "noindex, nofollow");
  } else if (kind === "immutable") {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "public, max-age=300");
  }
  if (noindex) headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}
