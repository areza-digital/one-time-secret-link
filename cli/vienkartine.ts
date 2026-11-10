#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The flags matter: without them Bun would load .env and bunfig.toml from whatever folder this runs in, and a planted
// file there could redirect the CLI and collect the operator token.
// vienkartine: request, send, open and pull secrets through a Vienkartinė nuoroda instance without printing a value.
// Runs on Bun, and, bundled by scripts/build-plugin.ts, on Node 22 or later: nothing here may need a Bun-only API.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { decryptText, encryptText, isIdentity, newIdentity } from "../src/shared/crypto";
import {
  ID_PATTERN,
  LIMITS,
  TOKEN_PATTERN,
  authFromIdentity,
  cleanLabel,
  linkFor,
  type Lang,
  type PublicItem,
} from "../src/shared/protocol";
import { STAT_KINDS, STATS_DAYS } from "../src/shared/stats";

const HOME = process.env.VIENKARTINE_HOME ?? join(homedir(), ".config/vienkartine");
// The live Areza instance. The default must always be a domain the project controls: secrets go wherever it points.
const BASE = (process.env.VIENKARTINE_URL ?? "https://secret.areza.digital").replace(/\/$/, "");
const BASE_ORIGIN = new URL(BASE).origin;
const LOCAL_BASE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE_ORIGIN);
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface SavedRequest {
  id: string;
  identity: string;
  pulledAt?: number;
  label: string;
  env: string | null;
  to: string | null;
  raw: string | null;
  base: string;
  createdAt: number;
  expiresAt: number;
}

interface SavedSend {
  id: string;
  manageToken: string;
  label: string | null;
  base: string;
  createdAt: number;
  expiresAt: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

// ---------- args ----------

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags.set(key, inline);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags.set(key, argv[++i]);
    else flags.set(key, true);
  }
  return { positional, flags };
}

function flag(flags: Map<string, string | true>, name: string): string | null {
  const value = flags.get(name);
  if (value === undefined) return null;
  if (value === true) throw new CliError(`--${name} needs a value`);
  return value;
}

function parseTtl(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const match = /^(\d+)([hd])$/.exec(value);
  if (!match) throw new CliError(`--ttl must look like 1h, 24h, 3d or 7d`);
  const seconds = Number(match[1]) * (match[2] === "h" ? 3600 : 86400);
  if (seconds < LIMITS.minTtlSeconds || seconds > LIMITS.maxTtlSeconds) throw new CliError("--ttl must be 1h to 7d");
  return seconds;
}

function parseLang(value: string | null): Lang {
  if (!value || value === "lt") return "lt";
  if (value === "en") return "en";
  throw new CliError("--lang must be lt or en");
}

function expandPath(path: string): string {
  return resolve(path.replace(/^~(?=$|\/)/, homedir()));
}

// ---------- local state ----------

function stateDir(kind: "requests" | "sent"): string {
  const dir = join(HOME, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(HOME, 0o700);
  chmodSync(dir, 0o700);
  return dir;
}

/** Atomic 0600 write. The temp name is random and created exclusively, so a planted symlink can't redirect it. */
function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function readJson<T>(path: string): T {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    // On Node the parse error quotes part of the input, and a request file holds a private key: name the path only.
    throw new CliError(`${path} is damaged (not valid JSON); delete it if you do not need that request any more`);
  }
}

/**
 * The instance operator's token (optional): makes created items "verified" and skips per-IP limits. It is pinned to
 * the URL it belongs to (VIENKARTINE_OPERATOR_URL, stored next to it), and only ever sent there.
 */
function operator(): { token: string; origin: string } | null {
  // Token and URL always come from the same place, so an environment can't pair its own URL with the file's token.
  let token: string | null = null;
  let url: string | null = null;
  if (process.env.VIENKARTINE_OPERATOR_TOKEN) {
    token = process.env.VIENKARTINE_OPERATOR_TOKEN;
    url = process.env.VIENKARTINE_OPERATOR_URL || null;
  } else {
    const file = join(HOME, "operator.env");
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    token = /^VIENKARTINE_OPERATOR_TOKEN=(\S+)$/m.exec(text)?.[1] ?? null;
    url = /^VIENKARTINE_OPERATOR_URL=(\S+)$/m.exec(text)?.[1] ?? null;
  }
  if (!token || !url) return null;
  try {
    return { token, origin: new URL(url).origin };
  } catch {
    return null;
  }
}

function operatorToken(): string | null {
  const op = operator();
  return op && op.origin === BASE_ORIGIN ? op.token : null;
}

// ---------- http ----------

async function api<T>(base: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  if (!base.startsWith("https://") && !LOCAL_BASE) throw new CliError(`refusing to talk to ${base}: https only`);
  const headers: Record<string, string> = { "User-Agent": "vienkartine-cli", ...extra };
  const op = operator();
  // The operator token proves who runs the instance. It only goes to the origin it is pinned to, never anywhere else.
  if (op && new URL(base).origin === op.origin && op.origin === BASE_ORIGIN) headers.Authorization = `Bearer ${op.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      });
    } catch {
      throw new CliError(`cannot reach ${base} (or it redirected, which is refused)`);
    }
    // An HTML 429 comes from a Cloudflare zone rate-limit rule in front of the Worker, not from us: wait, retry once.
    const zoneLimit = response.status === 429 && !(response.headers.get("Content-Type") ?? "").includes("json");
    if (!zoneLimit || attempt > 0) break;
    await sleep(Math.min(60, Number(response.headers.get("Retry-After")) || 15) * 1000);
  }
  const data = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, data };
}

/** The answer to a create call. The id becomes a file name under VIENKARTINE_HOME, so a hostile server must not pick it. */
function created<T extends { id: string; expiresAt: number; manageToken?: string }>(status: number, data: T, send = false): T {
  if (status !== 201) throw apiError(status, data);
  const valid =
    ID_PATTERN.test(String(data.id)) && Number.isSafeInteger(data.expiresAt) && (!send || TOKEN_PATTERN.test(String(data.manageToken)));
  if (!valid) throw new CliError(`unexpected answer from ${BASE}; nothing was saved`);
  return data;
}

/** An error code or state from the server, printed only if it is a plain word: no terminal escapes from a hostile server. */
function word(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,32}$/.test(value) ? value : "?";
}

function apiError(status: number, data: unknown): CliError {
  const code = word((data as { error?: string })?.error ?? "error");
  if (status === 404) return new CliError("not found or expired", 3);
  if (status === 403) return new CliError("the key does not match this item", 4);
  if (status === 409) return new CliError("already used (read, answered or revoked)", 5);
  if (status === 429) return new CliError("rate limited, try again later", 6);
  return new CliError(`server said ${status} ${code}`);
}

// ---------- writing values without printing them ----------

/**
 * NAME=value in a form that `. file` and the dotenv parsers (Node, Bun, phpdotenv, python-dotenv) all read back
 * unchanged: bare when plain, single-quoted otherwise. Values with ', $ or a line break can't be written safely.
 */
export function envLine(name: string, value: string): string {
  if (/^[A-Za-z0-9_\-.:/+=@%,]*$/.test(value)) return `${name}=${value}`;
  // Bun's .env loader expands $VAR even inside single quotes, so $ can't round-trip either; control characters
  // (terminal escapes, NUL) never belong in an env file.
  if (/['$\p{Cc}]/u.test(value)) throw new CliError("the value has a quote, a $, a line break or a control character; save it with --raw FILE instead", 7);
  return `${name}='${value}'`;
}

/** Replaces NAME= (or export NAME=) in an env file, or appends it. Other lines are kept as they are. */
export function upsertEnv(content: string, name: string, value: string): string {
  const line = envLine(name, value);
  const pattern = new RegExp(`^(?:export\\s+)?${name}=`);
  const lines = content ? content.replace(/\n$/, "").split("\n") : [];
  let found = false;
  const out = lines.map((existing) => {
    if (!pattern.test(existing)) return existing;
    found = true;
    return line;
  });
  if (!found) out.push(line);
  return `${out.join("\n")}\n`;
}

type Target = { env: string | null; to: string | null; raw: string | null };

/** Checked BEFORE anything is opened, because opening burns the secret. */
function checkTarget(target: Target): void {
  if (!target.raw && !(target.env && target.to)) throw new CliError("say where to save it: --env NAME --to FILE, or --raw FILE");
  if (target.env && !NAME_PATTERN.test(target.env)) throw new CliError("--env must be a variable name like ANTHROPIC_API_KEY");
  const path = expandPath((target.raw ?? target.to)!);
  if (existsSync(path) && !lstatSync(path).isFile()) throw new CliError(`${path} is not a regular file`);
}

/** Writes the value; if that fails after the secret was burned, keeps it in a 0600 recovery file instead of losing it. */
function saveValue(value: string, target: Target, id: string): string {
  try {
    if (target.raw) {
      const path = expandPath(target.raw);
      writePrivate(path, value);
      return `saved ${[...value].length} chars to ${path} (0600)`;
    }
    const clean = value.replace(/\r?\n$/, ""); // drop one trailing newline from pasting, keep everything else
    const path = expandPath(target.to!);
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const next = upsertEnv(current, target.env!, clean);
    // If this replaces an existing value, keep the old file so a wrong answer can be undone after `reject`.
    let kept = "";
    if (current && new RegExp(`^(?:export\\s+)?${target.env}=`, "m").test(current) && next !== current) {
      writePrivate(`${path}.vienkartine.bak`, current);
      kept = `; previous file kept as ${path}.vienkartine.bak (0600)`;
    }
    writePrivate(path, next);
    return `saved ${target.env} (${[...clean].length} chars) to ${path} (0600)${kept}`;
  } catch (error) {
    const recovery = join(HOME, "recovered", `${id}.txt`);
    writePrivate(recovery, value);
    const reason = error instanceof Error ? error.message : "write failed";
    throw new CliError(`${reason}. The value is kept in ${recovery} (0600); move it where it belongs, then delete it`, 7);
  }
}

/** Reads NAME from an env file the way `. file` would: the last definition wins, quotes are honoured, and an
 * unquoted value ends at a ` #` comment. */
export function readEnvValue(spec: string): string {
  const [file, name] = spec.split(/:(?=[^:]+$)/);
  if (!file || !name || !NAME_PATTERN.test(name)) throw new CliError("--from-env takes FILE:NAME");
  const content = readFileSync(expandPath(file), "utf8");
  const matches = [...content.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}=(.*)$`, "gm"))];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) throw new CliError(`${name} not found in ${file}`);
  const single = /^'([^']*)'/.exec(raw);
  if (single) return single[1];
  const double = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (double) return double[1].replace(/\\(["\\$`])/g, "$1");
  return raw.replace(/\s+#.*$/, "").trim();
}

// ---------- commands ----------

async function request(args: ReturnType<typeof parseArgs>): Promise<void> {
  const label = cleanLabel(args.positional.join(" "));
  if (!label) throw new CliError(`give a short label (up to ${LIMITS.labelChars} characters): what you are asking for`);
  const env = flag(args.flags, "env");
  const to = flag(args.flags, "to");
  const raw = flag(args.flags, "raw");
  if (env && !NAME_PATTERN.test(env)) throw new CliError("--env must be a variable name");
  const ttl = parseTtl(flag(args.flags, "ttl"), 7 * 86400);
  const lang = parseLang(flag(args.flags, "lang"));

  const { identity, recipient } = await newIdentity();
  const auth = await authFromIdentity(identity);
  const answer = await api<{ id: string; expiresAt: number }>(BASE, "/api/items", {
    kind: "request",
    recipient,
    label,
    ttl,
    auth,
  });
  const data = created(answer.status, answer.data);

  const saved: SavedRequest = {
    id: data.id,
    identity,
    label,
    env,
    to: to ? expandPath(to) : null,
    raw: raw ? expandPath(raw) : null,
    base: BASE,
    createdAt: Date.now(),
    expiresAt: data.expiresAt,
  };
  writePrivate(join(stateDir("requests"), `${data.id}.json`), JSON.stringify(saved, null, 2));
  console.log(`request ${data.id} created${operatorToken() ? " (verified as the operator)" : ""}`);
  console.log(`link for the sender (safe to email): ${linkFor(BASE, lang, "r", data.id)}`);
  console.log(`expires: ${new Date(data.expiresAt).toISOString()}`);
  console.log(`when it is filled: vienkartine pull ${data.id}${env && to ? "" : " --env NAME --to FILE"}`);
}

async function send(args: ReturnType<typeof parseArgs>): Promise<void> {
  const file = flag(args.flags, "file");
  const fromEnv = flag(args.flags, "from-env");
  let value: string;
  if (fromEnv) value = readEnvValue(fromEnv);
  else if (file) value = readFileSync(expandPath(file), "utf8");
  else if (!process.stdin.isTTY) value = await readStdin();
  else throw new CliError("pipe the secret on stdin, or use --file FILE or --from-env FILE:NAME (never put it in argv)");
  if (!value.trim()) throw new CliError("the secret is empty");
  if ([...value].length > LIMITS.plaintextChars) throw new CliError(`the secret is over ${LIMITS.plaintextChars} characters`);
  const out = flag(args.flags, "out");
  const print = args.flags.has("print");

  const ttl = parseTtl(flag(args.flags, "ttl"), 86400);
  const lang = parseLang(flag(args.flags, "lang"));
  const { identity, recipient } = await newIdentity();
  const ciphertext = await encryptText(value, recipient);
  const answer = await api<{ id: string; expiresAt: number; manageToken: string }>(BASE, "/api/items", {
    kind: "send",
    ciphertext,
    ttl,
    auth: await authFromIdentity(identity),
  });
  const data = created(answer.status, answer.data, true);
  const saved: SavedSend = {
    id: data.id,
    manageToken: data.manageToken,
    label: cleanLabel(flag(args.flags, "label") ?? ""),
    base: BASE,
    createdAt: Date.now(),
    expiresAt: data.expiresAt,
  };
  writePrivate(join(stateDir("sent"), `${data.id}.json`), JSON.stringify(saved, null, 2));

  // The link unlocks the secret, so by default it goes to the clipboard, not into a terminal or transcript.
  const link = linkFor(BASE, lang, "s", data.id, identity);
  if (print) console.log(link);
  else if (out) {
    writePrivate(expandPath(out), `${link}\n`);
    console.log(`one-time link ${data.id} written to ${expandPath(out)} (0600)`);
  } else {
    const copied = spawnSync("pbcopy", { input: link });
    if (copied.status !== 0) throw new CliError("pbcopy failed; use --out FILE or --print");
    console.log(`one-time link ${data.id} copied to the clipboard (not printed)`);
  }
  console.log(`expires: ${new Date(data.expiresAt).toISOString()} · status: vienkartine status ${data.id}`);
}

async function decryptInto(base: string, id: string, identity: string, target: Target): Promise<string> {
  const { status, data } = await api<{ ciphertext: string }>(base, `/api/items/${id}/open`, {
    auth: await authFromIdentity(identity),
  });
  if (status !== 200) throw apiError(status, data);
  const value = await decryptText(data.ciphertext, identity);
  return saveValue(value, target, id);
}

function loadRequest(id: string | undefined, usage: string): { path: string; saved: SavedRequest } {
  if (!id || !ID_PATTERN.test(id)) throw new CliError(usage);
  const path = join(stateDir("requests"), `${id}.json`);
  if (!existsSync(path)) throw new CliError(`no local key for request ${id} (created on another machine, or expired)`);
  return { path, saved: readJson<SavedRequest>(path) };
}

async function pull(args: ReturnType<typeof parseArgs>): Promise<void> {
  const { path, saved } = loadRequest(args.positional[0], "usage: vienkartine pull <id> [--env NAME --to FILE | --raw FILE] [--wait]");
  const id = saved.id;
  const target: Target = {
    env: flag(args.flags, "env") ?? saved.env,
    to: flag(args.flags, "to") ?? saved.to,
    raw: flag(args.flags, "raw") ?? saved.raw,
  };
  checkTarget(target);

  const timeout = /^(\d+)([mh])$/.exec(flag(args.flags, "timeout") ?? "1h");
  if (!timeout) throw new CliError("--timeout must look like 30m or 2h");
  const deadline = Date.now() + Number(timeout[1]) * (timeout[2] === "m" ? 60_000 : 3_600_000);
  let filledAt = 0;
  for (;;) {
    const { status, data } = await api<PublicItem>(saved.base, `/api/items/${id}`);
    if (status !== 200) throw apiError(status, data);
    if (data.state === "filled") {
      filledAt = data.filledAt ?? 0;
      break;
    }
    if (data.state === "read") throw new CliError(`already pulled at ${new Date(data.readAt ?? 0).toISOString()}; if the value was wrong: vienkartine reject ${id}`, 5);
    if (data.state !== "open") throw apiError(409, data);
    if (!args.flags.has("wait")) throw new CliError(`not filled yet; run again later or add --wait`, 2);
    if (Date.now() > deadline) throw new CliError("timed out waiting", 2);
    await sleep(10_000);
  }
  const message = await decryptInto(saved.base, id, saved.identity, target);
  // The local key stays until the request expires, so a wrong answer can still be rejected (it can't decrypt anything now).
  writePrivate(path, JSON.stringify({ ...saved, pulledAt: Date.now() }, null, 2));
  console.log(`${message}; answered ${new Date(filledAt).toISOString()}; the server copy is deleted`);
  console.log(`if this is not what the client sent (someone else answered first): vienkartine reject ${id}`);
}

async function reject(args: ReturnType<typeof parseArgs>): Promise<void> {
  const { saved } = loadRequest(args.positional[0], "usage: vienkartine reject <id>");
  const { status, data } = await api<{ state: string }>(saved.base, `/api/items/${saved.id}/reopen`, {
    auth: await authFromIdentity(saved.identity),
  });
  if (status !== 200) throw apiError(status, data);
  console.log(`${saved.id}: answer rejected, the same link accepts a new answer until ${new Date(saved.expiresAt).toISOString()}`);
}

async function open(args: ReturnType<typeof parseArgs>): Promise<void> {
  // Prefer stdin (pbpaste | vienkartine open ...): a link in argv lands in shell history and `ps`.
  const link = args.positional[0] ?? (!process.stdin.isTTY ? (await readStdin()).trim() : "");
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new CliError("usage: pbpaste | vienkartine open --env NAME --to FILE   (or --raw FILE)");
  }
  if (url.origin !== BASE_ORIGIN) throw new CliError(`that link is not on ${BASE_ORIGIN}; open it in a browser instead`);
  const id = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const identity = decodeURIComponent(url.hash.slice(1));
  if (!ID_PATTERN.test(id) || !isIdentity(identity)) throw new CliError("that is not a complete one-time link");
  const target: Target = { env: flag(args.flags, "env"), to: flag(args.flags, "to"), raw: flag(args.flags, "raw") };
  checkTarget(target);
  const message = await decryptInto(BASE, id, identity, target);
  console.log(`${message}; the link is now used up`);
}

async function status(args: ReturnType<typeof parseArgs>): Promise<void> {
  const only = args.positional[0];
  const rows: string[] = [];
  for (const kind of ["requests", "sent"] as const) {
    const dir = stateDir(kind);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const saved = readJson<SavedRequest | SavedSend>(join(dir, file));
      if (only && saved.id !== only) continue;
      const { status: code, data } = await api<PublicItem>(saved.base, `/api/items/${saved.id}`);
      const state =
        code === 200
          ? `${word(data.state)}${data.filledAt ? ` filled ${new Date(data.filledAt).toISOString()}` : ""}${data.readAt ? ` read ${new Date(data.readAt).toISOString()}` : ""}`
          : "gone";
      const label = "label" in saved && saved.label ? saved.label : "";
      rows.push(`${saved.id}  ${kind === "requests" ? "request" : "send   "}  ${state.padEnd(10)}  ${label}`);
      if (code === 404 || Date.now() > saved.expiresAt) rmSync(join(dir, file));
    }
  }
  console.log(rows.length ? rows.join("\n") : "nothing pending");
}

async function revoke(args: ReturnType<typeof parseArgs>): Promise<void> {
  const id = args.positional[0];
  if (!id || !ID_PATTERN.test(id)) throw new CliError("usage: vienkartine revoke <id> [--admin]");
  const requestPath = join(stateDir("requests"), `${id}.json`);
  const sentPath = join(stateDir("sent"), `${id}.json`);
  let base = BASE;
  let body: Record<string, unknown>;
  if (args.flags.has("admin")) {
    // Abuse takedown of anyone's item. Needs the operator token; the server refuses it otherwise.
    if (!operatorToken()) throw new CliError(`--admin needs the operator token (${HOME}/operator.env)`);
    body = { admin: true };
  } else if (existsSync(requestPath)) {
    const saved = readJson<SavedRequest>(requestPath);
    base = saved.base;
    body = { auth: await authFromIdentity(saved.identity) };
  } else if (existsSync(sentPath)) {
    const saved = readJson<SavedSend>(sentPath);
    base = saved.base;
    body = { manageToken: saved.manageToken };
  } else throw new CliError(`nothing local for ${id} (use --admin to take down someone else's link)`);
  const { status: code, data } = await api<{ state: string }>(base, `/api/items/${id}/revoke`, body);
  if (code !== 200) throw apiError(code, data);
  rmSync(requestPath, { force: true });
  rmSync(sentPath, { force: true });
  console.log(data.state === "read" ? `${id}: it was already read before you revoked it; rotate that credential` : `${id}: ${word(data.state)}`);
}

/** The operator's daily totals: links and requests created, requests filled, links opened. Counts only, no identifiers. */
async function stats(args: ReturnType<typeof parseArgs>): Promise<void> {
  const days = Number(flag(args.flags, "days") ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > STATS_DAYS) throw new CliError(`--days must be a whole number from 1 to ${STATS_DAYS}`);
  if (!operatorToken()) throw new CliError(`stats needs the operator token (${HOME}/operator.env)`);
  const { status: code, data } = await api<{ days?: unknown }>(BASE, `/api/stats?days=${days}`);
  if (code === 404) throw new CliError("the instance does not know the operator token, or it is older than the daily totals", 3);
  if (code !== 200) throw apiError(code, data);
  // Printed only if it is a date and plain counts: nothing else from the server reaches the terminal.
  const rows = Array.isArray(data.days) ? (data.days as Record<string, unknown>[]) : [];
  const counts = (row: Record<string, unknown>) => STAT_KINDS.map((kind) => row[kind]);
  const valid = (row: Record<string, unknown>) =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(row?.day)) && counts(row).every((n) => Number.isSafeInteger(n) && (n as number) >= 0);
  if (!rows.length || !rows.every(valid)) throw new CliError(`unexpected answer from ${BASE}`);
  const cell = (value: unknown) => String(value).padStart(8);
  console.log(`day         ${["links", "requests", "filled", "opened"].map(cell).join("  ")}`);
  for (const row of rows) console.log(`${row.day}  ${counts(row).map(cell).join("  ")}`);
  const total = STAT_KINDS.map((kind) => rows.reduce((sum, row) => sum + (row[kind] as number), 0));
  console.log(`total (${rows.length}d)  ${total.map(cell).join("  ")}`);
}

/** Puts NAME=value from a local env file into a remote env file over ssh. The value travels on stdin only. */
async function push(args: ReturnType<typeof parseArgs>): Promise<void> {
  const from = flag(args.flags, "from");
  const name = flag(args.flags, "env");
  const host = flag(args.flags, "ssh");
  const remote = flag(args.flags, "remote");
  if (!from || !name || !host || !remote) {
    throw new CliError("usage: vienkartine push --from FILE --env NAME --ssh HOST --remote /path/to/.env");
  }
  if (!NAME_PATTERN.test(name)) throw new CliError("--env must be a variable name");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(host)) throw new CliError("--ssh must be a host or ssh config alias");
  if (!/^\/[A-Za-z0-9_./-]+$/.test(remote) || remote.endsWith("/")) throw new CliError("--remote must be an absolute file path without spaces");
  const line = envLine(name, readEnvValue(`${from}:${name}`));

  // Keeps the owner and mode of an existing file (cat >) so the app can still read it, makes a 0600 file otherwise,
  // and leaves one 0600 backup. Refuses directories.
  const script = [
    "set -eu",
    'f="$1"; n="$2"',
    "umask 077",
    'if [ -d "$f" ]; then echo "$f is a directory" >&2; exit 3; fi',
    "IFS= read -r line",
    'tmp=$(mktemp "${f}.vienkartine.XXXXXX")',
    // The backup goes through a fresh temp file and mv, so a symlink planted at the backup path is replaced, not followed.
    'if [ -f "$f" ]; then b=$(mktemp "${f}.vienkartine.XXXXXX"); cat "$f" > "$b"; mv -f "$b" "$f.vienkartine.bak"; grep -v -E "^(export[[:space:]]+)?${n}=" "$f" > "$tmp" || true; fi',
    'printf "%s\\n" "$line" >> "$tmp"',
    'if [ -f "$f" ]; then cat "$tmp" > "$f"; rm -f "$tmp"; else mv "$tmp" "$f"; fi',
  ].join("\n");
  const quoted = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const command = `sh -c ${quoted(script)} sh ${quoted(remote)} ${quoted(name)}`;
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", "--", host, command], { input: `${line}\n`, encoding: "utf8" });
  if (result.status !== 0) throw new CliError(`ssh failed: ${(result.stderr || "").trim().split("\n").pop()}`);
  console.log(`set ${name} in ${host}:${remote} (previous file kept as ${remote}.vienkartine.bak, 0600)`);
}

const HELP = `vienkartine: share secrets through ${BASE} without printing them

  vienkartine request "<what you ask for>" [--env NAME --to FILE | --raw FILE] [--ttl 7d] [--lang lt|en]
      Make a request link for a client. Safe to email. The key stays in ${HOME}/requests.
  vienkartine pull <id> [--env NAME --to FILE | --raw FILE] [--wait] [--timeout 1h]
      Decrypt a filled request straight into an env file (0600). Prints only the name, length and answer time.
  vienkartine reject <id>
      The pulled value is wrong (or someone else answered first): discard it, the same link takes a new answer.
  vienkartine send [--file FILE | --from-env FILE:NAME | < stdin] [--ttl 24h] [--lang lt|en] [--out FILE | --print]
      Make a one-time link and copy it to the clipboard. The link unlocks the secret: treat it like the secret.
  pbpaste | vienkartine open --env NAME --to FILE | --raw FILE
      Use up a one-time link someone sent you (only ${BASE_ORIGIN} links), saving the value without printing it.
  vienkartine status [id]          Server state of everything you created here.
  vienkartine revoke <id> [--admin]
      Delete a request or one-time link now. --admin takes down anyone's link (abuse reports; operator token).
  vienkartine push --from FILE --env NAME --ssh HOST --remote PATH
      Copy one variable into a remote env file over ssh (stdin only, one 0600 .vienkartine.bak kept).
  vienkartine stats [--days 30]
      Daily totals (operator token): links = one-time links created, requests = request links created,
      filled = requests answered, opened = secrets handed out. Counts per UTC day, no identifiers; ${STATS_DAYS} days kept.

Env: VIENKARTINE_URL (default https://secret.areza.digital), VIENKARTINE_HOME, VIENKARTINE_OPERATOR_TOKEN + VIENKARTINE_OPERATOR_URL.
Exit codes: 2 not filled yet, 3 not found, 4 wrong key, 5 already used, 6 rate limited, 7 not saved as asked.`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const commands: Record<string, (a: typeof args) => Promise<void>> = { request, send, pull, reject, open, status, revoke, push, stats };
  if (!command || command === "help" || command === "--help" || !commands[command]) {
    console.log(HELP);
    if (command && !["help", "--help"].includes(command)) process.exit(1);
    return;
  }
  await commands[command](args);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof CliError) {
      console.error(`vienkartine: ${error.message}`);
      process.exit(error.code);
    }
    console.error(`vienkartine: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  });
}
