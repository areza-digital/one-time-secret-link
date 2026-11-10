import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIPPED, buildPluginCli } from "../scripts/build-plugin";
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
    expect(body).toContain("vienkartine request");
    expect(body).toContain("vienkartine pull");
    const never = /## Never\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
    expect(never).toContain("chat");
    for (const word of ["command line", "cat", "printenv", "Read", "~/.config/vienkartine", "send", "open", "push"]) expect(never).toContain(word);
  });
});

describe("the shipped command", () => {
  test("is the CLI as built from the source now (run `bun run build:plugin` if this fails)", async () => {
    expect(readFileSync(SHIPPED, "utf8")).toBe(await buildPluginCli());
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
  const [major, minor] = node.exitCode === 0 ? node.stdout.toString().trim().replace(/^v/, "").split(".").map(Number) : [0, 0];
  const runnable = major > 20 || (major === 20 && minor >= 19);

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
