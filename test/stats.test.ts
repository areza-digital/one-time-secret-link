import { afterAll, beforeAll, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { createHash, timingSafeEqual } from "node:crypto";
import { STATS_DAYS, type StatKind } from "../src/shared/stats";
import { addCount, readTotals, type CounterStore } from "../src/worker/stats";

// The Worker imports its Durable Object classes from a module that exists only in the Workers runtime, and checks the
// operator token with a WebCrypto method that only the Workers runtime has.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
Object.defineProperty(crypto.subtle, "timingSafeEqual", { value: (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b) });
type Fetch = (request: Request, env: unknown, ctx: { waitUntil(promise: Promise<unknown>): void }) => Promise<Response>;
const { default: worker } = (await import("../src/worker/index" as string)) as { default: { fetch: Fetch } };

const NOON = new Date("2026-11-10T12:00:00Z");
beforeAll(() => setSystemTime(NOON));
afterAll(() => setSystemTime());

/** Durable Object storage as a Map: the counters need only get, put, delete and list. */
function memory() {
  const data = new Map<string, number>();
  const store: CounterStore = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => void data.set(key, value),
    delete: async (keys) => keys.filter((key) => data.delete(key)).length,
    list: async <T>({ start, end, limit }: { start?: string; end?: string; limit?: number }) =>
      new Map(
        [...data]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .filter(([key]) => (start === undefined || key >= start) && (end === undefined || key < end))
          .slice(0, limit),
      ) as Map<string, T>,
  };
  return { data, store };
}

const OPERATOR = "o".repeat(43);
const GOOD = "G".repeat(22); // an item the fake box lets everything through for
const BAD = "B".repeat(22); // an item it refuses everything for
const ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----\nabc\n-----END AGE ENCRYPTED FILE-----";
const AUTH = "a".repeat(43);
const SEND = { kind: "send", ciphertext: ARMOR, ttl: 3600, auth: AUTH };
const REQUEST = { kind: "request", recipient: `age1pq1${"q".repeat(30)}`, label: "Wi-Fi slaptažodis biurui", ttl: 3600, auth: AUTH };

/** A Worker environment with fake Durable Objects, and the counter object backed by a Map. */
function setup(options: { counterFails?: boolean } = {}) {
  const { data, store } = memory();
  const bumps: unknown[][] = [];
  const asked: number[] = [];
  const pending: Promise<unknown>[] = [];
  const limits = {
    hit: async () => true,
    tally: async (...args: unknown[]) => {
      bumps.push(args);
      if (options.counterFails) throw new Error("storage down");
      await addCount(store, args[0] as StatKind, Date.now());
    },
    totals: async (days: number) => (asked.push(days), readTotals(store, days, Date.now())),
  };
  const refuse = { ok: false, error: "conflict" } as const;
  const boxes = {
    create: async () => true,
    describe: async () => null,
    fill: async (_ciphertext: string, now: number) => ({ ok: true, value: now }),
    open: async () => ({ ok: true, value: ARMOR }),
    revoke: async () => ({ ok: true, value: "revoked" }),
    reopen: async () => ({ ok: true, value: "open" }),
  };
  const refusing = { ...boxes, fill: async () => refuse, open: async () => ({ ok: false, error: "forbidden" }) };
  const env = {
    ASSETS: {},
    BOXES: { idFromName: (name: string) => name, get: (name: string) => (name === BAD ? refusing : boxes) },
    LIMITS: { idFromName: (name: string) => name, get: () => limits },
    IP_SALT: "test-salt",
    OPERATOR_TOKEN_SHA256: createHash("sha256").update(OPERATOR).digest("hex"),
    VERIFIED_NAME: "Operator",
    INDEXABLE: "false",
  };
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
  /** One request as a visitor would send it, with the headers that identify them; then let the counter finish. */
  async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await worker.fetch(
      new Request(`https://secret.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", "User-Agent": "test-agent/1.0", Referer: "https://elsewhere.example/page", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    return response;
  }
  return { data, bumps, asked, call };
}

const today = "2026-11-10";

describe("daily totals", () => {
  test("each of the four actions raises its counter once, and refused actions raise nothing", async () => {
    const { data, call } = setup();
    const totals = () => Object.fromEntries(data);

    expect((await call("/api/items", SEND)).status).toBe(201);
    expect(totals()).toEqual({ [`${today}|send`]: 1 });
    expect((await call("/api/items", REQUEST)).status).toBe(201);
    expect(totals()).toEqual({ [`${today}|send`]: 1, [`${today}|request`]: 1 });
    expect((await call(`/api/items/${GOOD}/fill`, { ciphertext: ARMOR })).status).toBe(200);
    expect((await call(`/api/items/${GOOD}/open`, { auth: AUTH })).status).toBe(200);
    expect(totals()).toEqual({ [`${today}|send`]: 1, [`${today}|request`]: 1, [`${today}|fill`]: 1, [`${today}|open`]: 1 });

    // Not counted: reading metadata, revoking, rejecting an answer, a second fill or a wrong key, a bad request.
    expect((await call(`/api/items/${GOOD}`)).status).toBe(404);
    expect((await call(`/api/items/${GOOD}/revoke`, { manageToken: AUTH })).status).toBe(200);
    expect((await call(`/api/items/${GOOD}/reopen`, { auth: AUTH })).status).toBe(200);
    expect((await call(`/api/items/${BAD}/fill`, { ciphertext: ARMOR })).status).toBe(409);
    expect((await call(`/api/items/${BAD}/open`, { auth: AUTH })).status).toBe(403);
    expect((await call("/api/items", { ...SEND, ttl: 5 })).status).toBe(400);
    expect(totals()).toEqual({ [`${today}|send`]: 1, [`${today}|request`]: 1, [`${today}|fill`]: 1, [`${today}|open`]: 1 });

    await call("/api/items", SEND);
    expect(data.get(`${today}|send`)).toBe(2);
  });

  test("after a reject the next answer, and its opening, are counted again", async () => {
    const { data, call } = setup();
    await call(`/api/items/${GOOD}/fill`, { ciphertext: ARMOR });
    await call(`/api/items/${GOOD}/open`, { auth: AUTH });
    expect((await call(`/api/items/${GOOD}/reopen`, { auth: AUTH })).status).toBe(200);
    await call(`/api/items/${GOOD}/fill`, { ciphertext: ARMOR });
    await call(`/api/items/${GOOD}/open`, { auth: AUTH });
    expect(Object.fromEntries(data)).toEqual({ [`${today}|fill`]: 2, [`${today}|open`]: 2 });
  });

  test("a failed counter write never fails the action", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const { data, bumps, call } = setup({ counterFails: true });
    const created = await call("/api/items", SEND);
    expect(created.status).toBe(201);
    expect(typeof ((await created.json()) as { id: string }).id).toBe("string");
    expect((await call("/api/items", REQUEST)).status).toBe(201);
    expect((await call(`/api/items/${GOOD}/fill`, { ciphertext: ARMOR })).status).toBe(200);
    const opened = await call(`/api/items/${GOOD}/open`, { auth: AUTH });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { ciphertext: string }).ciphertext).toBe(ARMOR);
    expect(bumps.length).toBe(4); // it was tried every time
    expect(data.size).toBe(0);
    expect(logged.mock.calls.map(([tag, message]) => `${tag}: ${message}`)).toEqual(Array(4).fill("stats: storage down"));
    logged.mockRestore();
  });

  test("the stored record holds a day, a kind and a count, and the counter is told nothing else", async () => {
    const { data, bumps, call } = setup();
    await call("/api/items", SEND);
    await call("/api/items", REQUEST);
    await call(`/api/items/${GOOD}/fill`, { ciphertext: ARMOR });
    await call(`/api/items/${GOOD}/open`, { auth: AUTH });
    expect(data.size).toBe(4);
    for (const [key, value] of data) {
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}\|(send|request|fill|open)$/);
      expect(Number.isSafeInteger(value) && value > 0).toBe(true);
    }
    expect(bumps).toEqual([["send"], ["request"], ["fill"], ["open"]]); // the kind alone: no address, id, label or header
    const everything = JSON.stringify([...data, ...bumps]);
    for (const trace of ["203.0.113.9", "test-agent", "elsewhere.example", "slaptažodis", GOOD, AUTH]) expect(everything).not.toContain(trace);
  });

  test("history is bounded: counters older than the window go when a day's first count is added", async () => {
    const { data, store } = memory();
    const now = NOON.getTime();
    for (const day of ["2025-09-01", "2025-10-06", "2025-10-07", "2026-11-09"]) data.set(`${day}|send`, 3);
    await addCount(store, "send", now);
    expect([...data.keys()].sort()).toEqual(["2025-10-07|send", "2026-11-09|send", `${today}|send`]); // the window is 400 days, today included
    expect(STATS_DAYS).toBe(400);
    await addCount(store, "send", now); // not the first of the day: nothing to trim, counted
    expect(data.get(`${today}|send`)).toBe(2);
  });

  test("totals run newest first and are zero where nothing was counted", async () => {
    const { data, store } = memory();
    data.set(`${today}|open`, 2);
    data.set("2026-11-08|send", 5);
    data.set("2026-11-08|fill", 1);
    expect(await readTotals(store, 4, NOON.getTime())).toEqual([
      { day: today, send: 0, request: 0, fill: 0, open: 2 },
      { day: "2026-11-09", send: 0, request: 0, fill: 0, open: 0 },
      { day: "2026-11-08", send: 5, request: 0, fill: 1, open: 0 },
      { day: "2026-11-07", send: 0, request: 0, fill: 0, open: 0 },
    ]);
  });
});

describe("GET /api/stats", () => {
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  test("without the operator token it answers like any path that does not exist, and the counters are not read", async () => {
    const { asked, call } = setup();
    const unknown = await call("/api/nothing-here");
    expect(unknown.status).toBe(404);
    const expected = await unknown.text();
    for (const headers of [{}, bearer("x".repeat(43)), bearer("short"), { Authorization: OPERATOR }]) {
      const refused = await call("/api/stats", undefined, headers);
      expect(refused.status).toBe(404);
      expect(await refused.text()).toBe(expected);
    }
    expect(asked).toEqual([]);
  });

  test("with the token it answers with the totals as JSON, newest day first", async () => {
    const { call } = setup();
    await call("/api/items", SEND);
    await call("/api/items", SEND);
    await call("/api/items", REQUEST);
    const response = await call("/api/stats?days=2", undefined, bearer(OPERATOR));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      retentionDays: 400,
      days: [
        { day: today, send: 2, request: 1, fill: 0, open: 0 },
        { day: "2026-11-09", send: 0, request: 0, fill: 0, open: 0 },
      ],
    });
    const byDefault = (await (await call("/api/stats", undefined, bearer(OPERATOR))).json()) as { days: unknown[] };
    expect(byDefault.days.length).toBe(30);
  });

  test("a bad number of days is refused, and only GET is answered", async () => {
    const { call } = setup();
    for (const days of ["0", "401", "abc", "1.5", ""]) {
      expect((await call(`/api/stats?days=${days}`, undefined, bearer(OPERATOR))).status).toBe(400);
    }
    expect((await call("/api/stats?days=400", undefined, bearer(OPERATOR))).status).toBe(200);
    expect((await call("/api/stats", {}, bearer(OPERATOR))).status).toBe(404);
    expect((await call("/api/stats/extra", undefined, bearer(OPERATOR))).status).toBe(404);
  });
});

describe("vienkartine stats", () => {
  /** Runs the CLI against a fake instance on 127.0.0.1 with a throwaway home. */
  async function stats(handler: (request: Request) => Response, args: string[], operator = true) {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const proc = Bun.spawn(["bun", "--no-env-file", "--config=/dev/null", `${import.meta.dir}/../cli/vienkartine.ts`, "stats", ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          VIENKARTINE_URL: base,
          VIENKARTINE_HOME: mkdtempSync(`${tmpdir()}/vk-stats-`),
          ...(operator ? { VIENKARTINE_OPERATOR_TOKEN: OPERATOR, VIENKARTINE_OPERATOR_URL: base } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, out, err };
    } finally {
      server.stop(true);
    }
  }

  test("prints a table with a total, and sends the operator token", async () => {
    let seen = "";
    const run = await stats((request) => {
      seen = `${new URL(request.url).pathname}${new URL(request.url).search} ${request.headers.get("Authorization")}`;
      return Response.json({ retentionDays: 400, days: [{ day: today, send: 3, request: 1, fill: 1, open: 2 }, { day: "2026-11-09", send: 1, request: 0, fill: 0, open: 1 }] });
    }, ["--days", "2"]);
    expect(run.code).toBe(0);
    expect(seen).toBe(`/api/stats?days=2 Bearer ${OPERATOR}`);
    const lines = run.out.trim().split("\n");
    expect(lines[0].split(/\s+/)).toEqual(["day", "links", "requests", "filled", "opened"]);
    expect(lines[1].split(/\s+/)).toEqual([today, "3", "1", "1", "2"]);
    expect(lines[3].split(/\s+/)).toEqual(["total", "(2d)", "4", "1", "1", "3"]);
  });

  test("refuses without the operator token, and does not call the instance", async () => {
    let called = false;
    const run = await stats(() => ((called = true), Response.json({})), [], false);
    expect(run.code).toBe(1);
    expect(run.err).toContain("needs the operator token");
    expect(called).toBe(false);
  });

  test("says what a 404 means, and prints nothing a hostile instance made up", async () => {
    const old = await stats(() => Response.json({ error: "not_found" }, { status: 404 }), []);
    expect(old.code).toBe(3);
    expect(old.err).toContain("older than the daily totals");
    const hostile = await stats(() => Response.json({ days: [{ day: "\u001b]52;c;aGk=\u0007", send: 1, request: 1, fill: 1, open: 1 }] }), []);
    expect(hostile.code).toBe(1);
    expect(hostile.err).toContain("unexpected answer");
    expect(hostile.out + hostile.err).not.toContain("\u001b");
    expect((await stats(() => Response.json({}), ["--days", "401"])).err).toContain("--days must be");
  });
});

describe("the page says so", () => {
  test("the daily totals are named in the answer about what is stored, in both languages", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const out = mkdtempSync(`${tmpdir()}/vk-totals-text-`);
    // Hermetic: deploy scripts export VK_THEME and friends, which must not leak into the default build.
    const inherited: Record<string, string | undefined> = { ...process.env };
    for (const name of ["VK_THEME", "VK_WRANGLER_CONFIG", "VK_REPO", "VK_OUT"]) delete inherited[name];
    const build = Bun.spawn(["bun", "run", `${import.meta.dir}/../site/build.ts`], { env: { ...inherited, VK_OUT: out }, stdout: "ignore", stderr: "pipe" });
    expect(await build.exited).toBe(0);
    const lt = readFileSync(`${out}/index.html`, "utf8");
    const en = readFileSync(`${out}/en/index.html`, "utf8");
    expect(lt).toContain("Taip pat kasdien skaičiuojame, kiek nuorodų sukuriama, užpildoma ir atidaroma: saugome tik bendrus skaičius, be jokio adreso ar kito identifikatoriaus.");
    expect(en).toContain("We also count how many links are created, answered and opened each day, as plain totals without any address or other identifier.");
    // The statements it must not contradict are still there.
    expect(lt).toContain("Be registracijos, slapukų ir sekimo");
    expect(en).toContain("No sign-up, no cookies, no tracking");
    expect(en).toContain("No analytics, ads, cookies or outside scripts on the page.");
  });
});
