import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTICES, SHIPPED, buildPlugin } from "../scripts/build-plugin";
import { encryptText } from "../src/shared/crypto";
import { ID_PATTERN, randomToken } from "../src/shared/protocol";

const ROOT = join(import.meta.dir, "..");
const PLUGIN = join(ROOT, "plugins/vienkartine");
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

describe("the manifests", () => {
  const marketplace = json(".claude-plugin/marketplace.json");
  const plugin = json("plugins/vienkartine/.claude-plugin/plugin.json");

  test("the marketplace names itself, its owner and a plugin whose folder exists and has the same name", () => {
    expect(marketplace.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.source).toMatch(/^\.\/[^.]/); // relative to the marketplace root, no ".."
    expect(existsSync(join(ROOT, entry.source, ".claude-plugin/plugin.json"))).toBe(true);
    expect(join(ROOT, entry.source)).toBe(PLUGIN);
    expect(entry.name).toBe(plugin.name); // the install id is <entry name>@<marketplace name>
  });

  test("the plugin manifest has what a listing needs, and nothing else claims to be Anthropic's", () => {
    expect(plugin.name).toBe("vienkartine");
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.license).toBe("MIT");
    for (const field of ["description", "homepage", "repository"]) expect(typeof plugin[field]).toBe("string");
    expect(() => new URL(plugin.homepage)).not.toThrow();
    expect(plugin.author.name).toBeTruthy();
    expect(`${plugin.name} ${marketplace.name}`).not.toMatch(/claude|anthropic/i);
    // Nothing starts by itself: no hooks, servers or monitors. The command runs only when the assistant runs it.
    for (const component of ["hooks", "mcpServers", "monitors"]) expect(plugin[component]).toBeUndefined();
    for (const path of ["hooks", ".mcp.json", "monitors"]) expect(existsSync(join(PLUGIN, path))).toBe(false);
    expect(existsSync(join(PLUGIN, "README.md"))).toBe(true);
  });
});

// `version` in plugin.json pins users: a changed command or skill reaches nobody until it is raised. This pair records
// what the shipped command and skill hashed to at that version. When this test fails after you changed either one:
// raise "version" in plugin.json, then put the new version and the new hash here (the failure message prints it).
const RELEASED = { version: "0.1.0", sha256: "3ccd2e924355e46a1bb36cb103cc0eeaa8c9fcf8097acd38f89d526071b16fc3" };
const releasedHash = () => createHash("sha256").update(readFileSync(SHIPPED)).update("\0").update(readFileSync(join(PLUGIN, "skills/request-secret/SKILL.md"))).digest("hex");

describe("the privacy statement", () => {
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

  test("is an answer on both landing pages, at the addresses the plugin documents link to", async () => {
    const out = mkdtempSync(join(tmpdir(), "vk-plugin-site-"));
    // Hermetic: deploy scripts export VK_THEME and friends, which must not leak into the default build.
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of ["VK_THEME", "VK_WRANGLER_CONFIG", "VK_REPO", "VK_OUT"]) delete env[name];
    const build = Bun.spawn(["bun", "run", join(ROOT, "site/build.ts")], { env: { ...env, VK_OUT: out }, stdout: "ignore", stderr: "pipe" });
    expect(await build.exited).toBe(0);
    const pages = { en: readFileSync(join(out, "en/index.html"), "utf8"), lt: readFileSync(join(out, "index.html"), "utf8") };
    // The id is on the answer inside the collapsed <details>, so a browser opens it when it follows the link.
    for (const [html, id] of [[pages.en, "plugin-privacy"], [pages.lt, "papildinio-privatumas"]]) {
      expect(html).toMatch(new RegExp(`<details class="faq-item">(?:(?!</details>)[\\s\\S])*<p id="${id}">`));
      const answer = new RegExp(`<p id="${id}">([^<]*)</p>`).exec(html)?.[1] ?? "";
      for (const fact of ["secret.areza.digital", "VIENKARTINE_URL", "Cloudflare", "7 "]) expect(answer).toContain(fact);
    }
    expect(pages.en).toContain("the label you give it (not encrypted)");
    expect(pages.en).toContain("the server never receives the secret in plain text");
    expect(pages.lt).toContain("paties slapto teksto serveris niekada negauna");
    // The documents that link to it use exactly those addresses, and none says the statement is still missing.
    for (const path of ["README.md", "plugins/vienkartine/README.md", "docs/claude-code-plugin.md"]) {
      expect(read(path)).toContain("https://secret.areza.digital/en/#plugin-privacy");
      expect(read(path)).not.toMatch(/does not exist yet/i);
    }
  });
});

describe("the version", () => {
  test("is raised whenever the bundled command or the skill changes", () => {
    const version = json("plugins/vienkartine/.claude-plugin/plugin.json").version;
    const hash = releasedHash();
    if (version === RELEASED.version && hash === RELEASED.sha256) return;
    throw new Error(
      version === RELEASED.version
        ? `bin/vienkartine or SKILL.md changed but plugin.json still says ${version}: raise it, then set RELEASED to { version: "<new>", sha256: "${hash}" } in this test`
        : `plugin.json says ${version}, this test records ${RELEASED.version}: set RELEASED to { version: "${version}", sha256: "${hash}" }`,
    );
  });
});

describe("the skill", () => {
  const text = readFileSync(join(PLUGIN, "skills/request-secret/SKILL.md"), "utf8");
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];

  test("starts with front matter that names it and says when to use it", () => {
    expect(front).toBeDefined();
    const name = /^name: (.+)$/m.exec(front)?.[1];
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
    expect(name).toBe("request-secret");
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1536); // Claude Code cuts the listing text there
    expect(description).not.toMatch(/[<>]/); // angle brackets show as &lt; and &gt; in the listing
    for (const trigger of ["API key", "password", "token", "request"]) expect(description).toContain(trigger);
  });

  test("teaches the request flow and forbids every way of seeing or leaking the value", () => {
    expect(body).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/vienkartine" request');
    expect(body).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/vienkartine" pull');
    const never = /## Never\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
    expect(never).toContain("chat");
    for (const word of ["command line", "cat", "printenv", "Read", "~/.config/vienkartine", "send", "open", "push"]) expect(never).toContain(word);
  });

  test("calls the bundled command by its full path, never as a bare name that a user's own copy could shadow", () => {
    // The plugin's bin/ is on the PATH after the user's own entries. The variable is replaced in plugin skills.
    expect(body).not.toMatch(/(^|[\s`])vienkartine (request|pull|status|reject|revoke)\b/m);
    expect(body).not.toMatch(/(?<!bin)\/vienkartine /); // every path to the command is the bundled one
  });

  test("no example puts the value on a command line, where other local users could read it", () => {
    for (const source of [text, readFileSync(join(PLUGIN, "README.md"), "utf8"), readFileSync(join(ROOT, "README.md"), "utf8")]) {
      expect(source).not.toMatch(/Bearer\s+"?\$/); // a header with the value in the command's own argument
      expect(source).not.toMatch(/(?:-H|--header)\s+["'][^"']*\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)/);
    }
    expect(body).toContain("@<(printf");
  });
});

describe("the shipped command", () => {
  test("is the CLI as built from the source now (run `bun run build:plugin` if this fails)", async () => {
    expect(readFileSync(SHIPPED, "utf8")).toBe((await buildPlugin()).cli);
  });

  test("comes with the licence notice of every package bundled into it (run `bun run build:plugin` if this fails)", async () => {
    const notices = readFileSync(NOTICES, "utf8");
    expect(notices).toBe((await buildPlugin()).notices);
    // Independent of the generator: each package the bundle says it contains has a block with its licence text.
    const bundled = new Set([...readFileSync(SHIPPED, "utf8").matchAll(/^\/\/ node_modules\/((?:[^/\n]+\/node_modules\/)*(?:@[^/\n]+\/)?[^/\n]+)\//gm)].map((match) => match[1].split("/node_modules/").pop()!));
    expect([...bundled].sort()).toEqual(["@noble/ciphers", "@noble/curves", "@noble/hashes", "@noble/post-quantum", "@scure/base", "age-encryption"]);
    for (const name of bundled) expect(notices).toContain(`\n${name} `);
    expect(notices).toContain("(BSD-3-Clause)");
    expect(notices).toContain("Redistribution and use in source and binary forms"); // age-encryption
    expect(notices).toContain("Permission is hereby granted, free of charge"); // the MIT packages
  });

  test("is executable, starts with a Node shebang, and runs as CommonJS wherever it is installed", () => {
    expect(statSync(SHIPPED).mode & 0o111).toBe(0o111);
    expect(readFileSync(SHIPPED, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    // Without this, Node would take the nearest package.json up the tree (a "type": "module" there breaks the file).
    expect(json("plugins/vienkartine/bin/package.json")).toEqual({ type: "commonjs" });
  });

  test("needs no Bun-only API and loads nothing but Node's own modules", () => {
    const code = readFileSync(SHIPPED, "utf8");
    expect(code).not.toMatch(/\bBun\b/);
    const requires = [...code.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((match) => match[1]);
    expect(requires.length).toBeGreaterThan(0);
    for (const specifier of requires) expect(specifier).toStartWith("node:");
  });

  // The remaining tests run the shipped file itself on Node, which is what a user who installed only the plugin has.
  const node = Bun.spawnSync(["node", "--version"]);
  const major = node.exitCode === 0 ? Number(node.stdout.toString().trim().replace(/^v/, "").split(".")[0]) : 0;
  const runnable = major >= 22;

  /** A throwaway Vienkartinė nuoroda in memory, speaking just enough of the API for a request round trip. */
  function fakeInstance() {
    const item: { id: string; auth: string; recipient: string; state: string; ciphertext: string | null; filledAt: number | null } = {
      id: randomToken(16), auth: "", recipient: "", state: "none", ciphertext: null, filledAt: null,
    };
    const sha = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (request.method === "POST" && pathname === "/api/items") {
          const body = (await request.json()) as { recipient: string; auth: string };
          Object.assign(item, { recipient: body.recipient, auth: await sha(body.auth), state: "open" });
          return Response.json({ id: item.id, expiresAt: Date.now() + 3_600_000 }, { status: 201 });
        }
        if (request.method === "GET" && pathname === `/api/items/${item.id}`) {
          return Response.json({ id: item.id, kind: "request", state: item.state, recipient: item.state === "open" ? item.recipient : null, filledAt: item.filledAt, readAt: null });
        }
        if (request.method === "POST" && pathname === `/api/items/${item.id}/open`) {
          const { auth } = (await request.json()) as { auth: string };
          if ((await sha(auth)) !== item.auth) return Response.json({ error: "forbidden" }, { status: 403 });
          item.state = "read";
          return Response.json({ ciphertext: item.ciphertext });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    return { item, server, base: `http://127.0.0.1:${server.port}` };
  }

  /** Async, because the fake instance answers from this same process. */
  async function run(args: string[], env: Record<string, string>) {
    const proc = Bun.spawn([SHIPPED, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  }

  test.skipIf(!runnable)("on Node: help shows the default instance, and a planted .env does not change it", () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-plugin-"));
    writeFileSync(join(dir, ".env"), "VIENKARTINE_URL=https://evil.example\n");
    const done = Bun.spawnSync([SHIPPED, "help"], { cwd: dir, env: { PATH: process.env.PATH ?? "", VIENKARTINE_HOME: join(dir, "home") } });
    expect(done.exitCode).toBe(0);
    expect(done.stdout.toString()).toStartWith("vienkartine: share secrets through https://secret.areza.digital without printing them");
  });

  test.skipIf(!runnable)("on Node: a damaged request file is reported by path only, never by content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-plugin-"));
    const id = "A".repeat(22);
    const fakeKey = "AGE-SECRET-KEY-PQ-1NOTAREALKEYBUTSHAPEDLIKEONE";
    mkdirSync(join(dir, "home/requests"), { recursive: true });
    const file = join(dir, `home/requests/${id}.json`);
    // Starts with the key, so that Node's own parse error would quote it ("Unexpected token 'A', "AGE-SECRET"...").
    writeFileSync(file, `${fakeKey}: the rest of a file that was cut off`);
    const env = { VIENKARTINE_HOME: join(dir, "home") };
    for (const args of [["pull", id], ["status"]]) {
      const done = await run(args, env);
      expect(done.code).toBe(1);
      expect(done.err).toContain(file);
      expect(done.out + done.err).not.toContain("AGE-SECRET");
      expect(done.out + done.err).not.toContain("cut off");
    }
  });

  test.skipIf(!runnable)("on Node: a request round trip saves the answer to a 0600 file and prints only its name and length", async () => {
    const { item, server, base } = fakeInstance();
    try {
      const dir = mkdtempSync(join(tmpdir(), "vk-plugin-"));
      const env = { VIENKARTINE_URL: base, VIENKARTINE_HOME: join(dir, "home") };
      const file = join(dir, "home/secrets/TEST_API_KEY.env");
      const made = await run(["request", "Test API key", "--env", "TEST_API_KEY", "--to", file, "--lang", "en"], env);
      expect(made.code).toBe(0);
      const id = /request (\S{22}) created/.exec(made.out)?.[1] ?? "";
      expect(ID_PATTERN.test(id)).toBe(true);
      expect(made.out).toContain(`link for the sender (safe to email): ${base}/en/r/${id}`);

      expect((await run(["pull", id], env)).code).toBe(2); // not answered yet

      const secret = "sk-test-0123456789abcdef";
      item.ciphertext = await encryptText(secret, item.recipient);
      item.state = "filled";
      item.filledAt = Date.now();
      const pulled = await run(["pull", id], env);
      expect(pulled.code).toBe(0);
      expect(pulled.out).toContain("saved TEST_API_KEY (24 chars)");
      expect(pulled.out + pulled.err).not.toContain(secret);
      expect(readFileSync(file, "utf8")).toBe(`TEST_API_KEY=${secret}\n`);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect((await run(["pull", id], env)).code).toBe(5); // already used
    } finally {
      server.stop(true);
    }
  });
});
