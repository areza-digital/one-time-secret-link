import { describe, expect, test } from "bun:test";
import { envLine, readEnvValue, upsertEnv } from "../cli/vienkartine";
import { decryptText, encryptText, isIdentity, newIdentity } from "../src/shared/crypto";
import {
  AUTH_PATTERN,
  authFromIdentity,
  cleanLabel,
  isArmoredAge,
  isRecipient,
  isTtl,
  linkFor,
  randomToken,
} from "../src/shared/protocol";

describe("crypto", () => {
  test("round trip with a post-quantum hybrid identity", async () => {
    const { identity, recipient } = await newIdentity();
    expect(identity.startsWith("AGE-SECRET-KEY-PQ-1")).toBe(true);
    expect(isIdentity(identity)).toBe(true);
    expect(isRecipient(recipient)).toBe(true);
    const secret = "sk-ant-api03-ąčęėįšųūž-\n line two";
    const armored = await encryptText(secret, recipient);
    expect(isArmoredAge(armored)).toBe(true);
    expect(armored).not.toContain("sk-ant");
    expect(await decryptText(armored, identity)).toBe(secret);
  });

  test("a different identity cannot decrypt", async () => {
    const a = await newIdentity();
    const b = await newIdentity();
    const armored = await encryptText("x", a.recipient);
    await expect(decryptText(armored, b.identity)).rejects.toThrow();
  });

  test("auth token is stable, 43 chars, and does not contain the identity", async () => {
    const { identity } = await newIdentity();
    const one = await authFromIdentity(identity);
    expect(one).toBe(await authFromIdentity(identity));
    expect(AUTH_PATTERN.test(one)).toBe(true);
    expect(one).not.toContain(identity.slice(20, 30));
  });
});

describe("protocol", () => {
  test("labels are cleaned and bounded", () => {
    expect(cleanLabel("  Banko\nAPI   raktas ")).toBe("Banko API raktas");
    expect(cleanLabel("")).toBeNull();
    expect(cleanLabel("x".repeat(141))).toBeNull();
    expect(cleanLabel(42)).toBeNull();
  });

  test("ttl bounds", () => {
    expect(isTtl(3600)).toBe(true);
    expect(isTtl(7 * 86400)).toBe(true);
    expect(isTtl(59 * 60)).toBe(false);
    expect(isTtl(7 * 86400 + 1)).toBe(false);
    expect(isTtl(3600.5)).toBe(false);
  });

  test("recipients: only post-quantum hybrid keys are accepted", () => {
    expect(isRecipient("age1pq1j7jqqqq")).toBe(true);
    expect(isRecipient("age1l80cdvqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe(false);
    expect(isRecipient("age1<script>")).toBe(false);
    expect(isRecipient("AGE1ABC")).toBe(false);
  });

  test("links put the key only in the fragment", () => {
    expect(linkFor("https://vienkartine.lt/", "lt", "s", "abc", "KEY")).toBe("https://vienkartine.lt/s/abc#KEY");
    expect(linkFor("https://vienkartine.lt", "en", "r", "abc")).toBe("https://vienkartine.lt/en/r/abc");
  });

  test("random tokens are url-safe", () => {
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("env files", () => {
  test("plain values stay bare, others are single-quoted, quotes and line breaks refused", () => {
    expect(envLine("KEY", "sk-ant-api03-AbC_d")).toBe("KEY=sk-ant-api03-AbC_d");
    expect(envLine("KEY", ' a b"`\\ ')).toBe("KEY=' a b\"`\\ '");
    expect(() => envLine("KEY", "it's")).toThrow();
    expect(() => envLine("KEY", "pa$$word")).toThrow();
    expect(() => envLine("KEY", "a\u001b[31mred")).toThrow();
    expect(() => envLine("KEY", "nul\u0000")).toThrow();
    expect(() => envLine("KEY", "a\nb")).toThrow();
  });

  test("upsert replaces in place and keeps other lines", () => {
    const before = "# comment\nA=1\nexport KEY=old\nB=2\n";
    expect(upsertEnv(before, "KEY", "new")).toBe("# comment\nA=1\nKEY=new\nB=2\n");
    expect(upsertEnv("A=1", "KEY", "v")).toBe("A=1\nKEY=v\n");
    expect(upsertEnv("", "KEY", "v")).toBe("KEY=v\n");
    expect(upsertEnv("KEY_LONG=1\n", "KEY", "v")).toBe("KEY_LONG=1\nKEY=v\n");
  });

  test("a quoted value reads back identically in sh and in Bun's dotenv parser", async () => {
    const value = ' p@ss w"rd #x`x`\\end ';
    const proc = Bun.spawnSync(["sh", "-c", `${envLine("V", value)}; printf %s "$V"`]);
    expect(proc.stdout.toString()).toBe(value);
    const dir = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/envtest-`);
    await Bun.write(`${dir}/.env`, `${envLine("V", value)}\n`);
    const bun = Bun.spawnSync(["bun", "-e", "process.stdout.write(process.env.V ?? '')"], { cwd: dir, env: { PATH: process.env.PATH ?? "" } });
    expect(bun.stdout.toString()).toBe(value);
  });
});

describe("rate-limit keys", () => {
  test("IPv4 unchanged, IPv6 grouped by /64", async () => {
    const { ipBucket } = await import("../src/worker/ip");
    expect(ipBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe("2001:0db8:0001:0002::/64");
    expect(ipBucket("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:0db8:0001:0002::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(ipBucket("::1")).toBe("0000:0000:0000:0000::/64");
  });
});

describe("labels", () => {
  test("invisible and bidi characters are stripped; brand words are reserved", async () => {
    const { cleanLabel, isReservedLabel, reservedWords, DEFAULT_RESERVED_WORDS } = await import("../src/shared/protocol");
    expect(cleanLabel("Banko​ PIN‮")).toBe("Banko PIN");
    expect(isReservedLabel("Patvirtinta: bankas")).toBe(true);
    expect(isReservedLabel("PATVIRTINTA")).toBe(true);
    expect(isReservedLabel("Official request")).toBe(true);
    expect(isReservedLabel("Wi-Fi slaptažodis")).toBe(false);
    expect(isReservedLabel("Ąkme UAB prašo", ["akme"])).toBe(true);
    expect(reservedWords("")).toEqual(DEFAULT_RESERVED_WORDS);
    expect(reservedWords(" akme , verif ")).toEqual(["akme", "verif"]);
  });
});

describe("anonymous label attacks from the 2026-10-13 pentest", () => {
  test("lookalikes, invisible characters, check marks and phishing words are refused", async () => {
    const { cleanLabel, labelProblem } = await import("../src/shared/protocol");
    const check = (raw: string) => labelProblem(cleanLabel(raw) ?? "");
    expect(check("✓ Patvіrtinta: Arеza Digital")).toBe("suspicious"); // check mark, Cyrillic і and е
    expect(check("Pаtvirtinta")).toBe("suspicious"); // Cyrillic а inside a Latin word
    expect(check("Swedbank saugumo patikra: įveskite Smart-ID PIN1 ir PIN2")).toBe("reserved");
    expect(check("Patvir\u{e0020}tinta")).toBe("reserved"); // tag character stripped first
    expect(check("Ver\u{e0100}ified")).toBe("reserved"); // supplementary variation selector stripped
    expect(check("Veri\u180bfied")).toBe("reserved");
    expect(check("Veri\ufff9fied")).toBe("reserved");
    expect(check("Veri\u{1d173}fied")).toBe("reserved");
    expect(check("Wi-Fi slaptažodis biurui")).toBeNull();
    expect(check("Pinigų sistemos API raktas")).toBeNull(); // "pin" only as a whole word
    expect(check("Пароль от Wi-Fi")).toBeNull(); // Cyrillic words are fine, only mixed words are not
    expect(check("API raktas 🔑")).toBe("suspicious");
  });
});

describe("reading env files like sh does", () => {
  test("last definition wins, quotes are honoured, unquoted values stop at a comment", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(`${(await import("node:os")).tmpdir()}/readenv-`);
    const file = `${dir}/x.env`;
    writeFileSync(file, "A=first\nA=second # comment\nexport B='p #not a comment'\nC=\"q\\\"uote\"\n  D=spaced\n");
    expect(readEnvValue(`${file}:A`)).toBe("second");
    expect(readEnvValue(`${file}:B`)).toBe("p #not a comment");
    expect(readEnvValue(`${file}:C`)).toBe('q"uote');
    expect(readEnvValue(`${file}:D`)).toBe("spaced");
    expect(() => readEnvValue(`${file}:MISSING`)).toThrow();
  });
});

describe("the CLI does not trust the server's answers", () => {
  /** Runs the CLI against a fake instance on 127.0.0.1 (http is allowed only for localhost) in a throwaway home. */
  async function againstServer(handler: (request: Request) => Response, args: string[], input = "", home?: string) {
    const { mkdtempSync } = await import("node:fs");
    const root = mkdtempSync(`${(await import("node:os")).tmpdir()}/vk-hostile-`);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    const base = `http://127.0.0.1:${server.port}`;
    if (home) {
      const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
      for (const file of readdirSync(`${home}/sent`)) {
        const record = JSON.parse(readFileSync(`${home}/sent/${file}`, "utf8"));
        writeFileSync(`${home}/sent/${file}`, JSON.stringify({ ...record, base }));
      }
    }
    try {
      const proc = Bun.spawn(["bun", "--no-env-file", "--config=/dev/null", `${import.meta.dir}/../cli/vienkartine.ts`, ...args], {
        env: { PATH: process.env.PATH ?? "", VIENKARTINE_URL: base, VIENKARTINE_HOME: home ?? `${root}/home/vk` },
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, out, err, root };
    } finally {
      server.stop(true);
    }
  }

  test("an item id that walks out of VIENKARTINE_HOME is refused before anything is written", async () => {
    const { existsSync } = await import("node:fs");
    const evil = () => Response.json({ id: "../../../escaped", expiresAt: Date.now() + 3_600_000, manageToken: "m".repeat(43) }, { status: 201 });
    const request = await againstServer(evil, ["request", "probe"]);
    expect(request.code).not.toBe(0);
    expect(request.err).toContain("unexpected answer");
    expect(existsSync(`${request.root}/escaped.json`)).toBe(false);
    const send = await againstServer(evil, ["send", "--print"], "a secret");
    expect(send.err).toContain("unexpected answer");
    expect(send.code).not.toBe(0);
    expect(existsSync(`${send.root}/escaped.json`)).toBe(false);
  });

  test("control characters in server strings never reach the terminal", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const escapes = "\u001b]52;c;aHR0cHM6Ly9ldmlsLmV4YW1wbGU=\u0007\u001b[2J";
    const id = "A".repeat(22);
    const hostile = (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/items") return Response.json({ error: `nope${escapes}` }, { status: 418 });
      if (path.endsWith("/revoke")) return Response.json({ state: `revoked${escapes}` });
      return Response.json({ id, state: `open${escapes}`, filledAt: null, readAt: null });
    };
    const failed = await againstServer(hostile, ["request", "probe"]);
    expect(failed.err).toContain("server said 418 ?");
    expect(failed.out + failed.err).not.toContain("\u001b");
    // status and revoke print the server's state for a link recorded as sent from this machine
    for (const args of [["status"], ["revoke", id]]) {
      const home = mkdtempSync(`${tmpdir()}/vk-seed-`);
      mkdirSync(`${home}/sent`, { recursive: true });
      writeFileSync(`${home}/sent/${id}.json`, JSON.stringify({ id, manageToken: "m".repeat(43), label: null, base: "", createdAt: 0, expiresAt: Date.now() + 3_600_000 }));
      const run = await againstServer(hostile, args, "", home);
      expect(run.code).toBe(0);
      expect(run.out + run.err).not.toContain("\u001b");
    }
  });
});
