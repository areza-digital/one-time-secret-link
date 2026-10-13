// End-to-end checks. Without BASE_URL it starts `wrangler dev` with throwaway storage, so every run starts clean.
// With BASE_URL it runs against that Worker (rate-limit checks then depend on earlier traffic).
// Uses a throwaway VIENKARTINE_HOME so it never touches real CLI state. Never prints secret values.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptText, newIdentity } from "../src/shared/crypto";
import { authFromIdentity, randomToken, type PublicItem } from "../src/shared/protocol";

const home = mkdtempSync(join(tmpdir(), "vienkartine-e2e-"));
const OPERATOR_TOKEN = randomToken(); // throwaway, 43 url-safe chars like a real one
let server: ReturnType<typeof Bun.spawn> | null = null;
let BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
if (!BASE) {
  const port = 8800 + Math.floor(Math.random() * 100);
  BASE = `http://127.0.0.1:${port}`;
  server = Bun.spawn(
    [
      "bunx", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(home, "state"),
      "--var", "IP_SALT:e2e-salt", "--var", `OPERATOR_TOKEN_SHA256:${createHash("sha256").update(OPERATOR_TOKEN).digest("hex")}`,
      "--var", "VERIFIED_NAME:E2E Operator",
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "ignore" },
  );
  for (let i = 0; i < 90; i++) {
    const up = await fetch(`${BASE}/`).then((r) => r.ok).catch(() => false);
    if (up) break;
    await Bun.sleep(1000);
  }
}

// The Worker started below knows only the hash of this throwaway operator token; no real token is involved.
const env = { ...process.env, VIENKARTINE_URL: BASE, VIENKARTINE_HOME: home, VIENKARTINE_OPERATOR_TOKEN: OPERATOR_TOKEN, VIENKARTINE_OPERATOR_URL: BASE } as Record<string, string>;
const anonymous = { ...env, VIENKARTINE_OPERATOR_TOKEN: "" };
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

function cli(args: string[], input?: string, extraEnv = env) {
  const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "../cli/vienkartine.ts"), ...args], {
    env: extraEnv,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

try {
  // 1. Request flow: CLI request -> browser-style fill -> CLI pull into an env file.
  const envFile = join(home, "client.env");
  writeFileSync(envFile, "# keep me\nOTHER=1\n");
  const req = cli(["request", "E2E Anthropic API raktas", "--env", "ANTHROPIC_API_KEY", "--to", envFile]);
  const id = /request (\S{22}) created/.exec(req.out)?.[1];
  check("cli request created", req.code === 0 && !!id, req.err);
  check("request is verified (operator token)", req.out.includes("verified"));
  const share = /safe to email\): (\S+)/.exec(req.out)?.[1] ?? "";
  check("share link has no fragment", share.endsWith(`/r/${id}`) && !share.includes("#"));

  const meta = await call(`/api/items/${id}`);
  const item = meta.data as unknown as PublicItem;
  check("metadata exposes recipient, label, verified", meta.status === 200 && !!item.recipient && item.verified && item.label === "E2E Anthropic API raktas");
  check("metadata has no ciphertext or hashes", !("ciphertext" in meta.data) && !("authHash" in meta.data));

  const notYet = cli(["pull", id!]);
  check("pull before fill exits 2", notYet.code === 2, notYet.err);

  const secret = "sk-ant-e2e-0123456789";
  const ciphertext = await encryptText(secret, item.recipient!);
  const fill = await call(`/api/items/${id}/fill`, { ciphertext }, { Origin: BASE });
  check("fill accepted", fill.status === 200 && typeof fill.data.filledAt === "number");
  const fillAgain = await call(`/api/items/${id}/fill`, { ciphertext });
  check("second fill refused (409)", fillAgain.status === 409);
  const afterFill = await call(`/api/items/${id}`);
  check("recipient hidden after fill", afterFill.data.recipient === null && afterFill.data.state === "filled");

  const wrong = await call(`/api/items/${id}/open`, { auth: "A".repeat(43) });
  check("wrong auth refused (403) without burning", wrong.status === 403);

  const pulled = cli(["pull", id!]);
  check("cli pull saved the value and says when it was answered", pulled.code === 0 && pulled.out.includes("ANTHROPIC_API_KEY (21 chars)") && pulled.out.includes("answered 20"), pulled.err);
  check("pull output never contains the value", !pulled.out.includes(secret) && !pulled.err.includes(secret));
  const saved = readFileSync(envFile, "utf8");
  check("env file updated, other lines kept", saved === `# keep me\nOTHER=1\nANTHROPIC_API_KEY=${secret}\n`);
  check("env file is 0600", (statSync(envFile).mode & 0o777) === 0o600);
  const read = await call(`/api/items/${id}`);
  check("state is read with readAt", read.data.state === "read" && typeof read.data.readAt === "number");
  const again = cli(["pull", id!]);
  check("second pull says already pulled (exit 5) and suggests reject", again.code === 5 && again.err.includes("reject"), again.err);

  // 1b. Someone answered first: reject, the client answers again on the same link.
  const rejected = cli(["reject", id!]);
  check("reject reopens the request", rejected.code === 0 && (await call(`/api/items/${id}`)).data.state === "open", rejected.err);
  const reopened = (await call(`/api/items/${id}`)).data as unknown as PublicItem;
  const refill = await call(`/api/items/${id}/fill`, { ciphertext: await encryptText("sk-ant-e2e-second", reopened.recipient!) });
  check("the same link accepts a new answer", refill.status === 200);
  const repull = cli(["pull", id!]);
  check("pull after reject gets the new value", repull.code === 0 && readFileSync(envFile, "utf8").includes("ANTHROPIC_API_KEY=sk-ant-e2e-second\n"), repull.err);

  // 2. One-time link: CLI send -> CLI open; second open refused.
  const sent = cli(["send", "--print"], "line one\nline two");
  const link = sent.out.trim().split("\n")[0];
  check("cli send prints a link with a key fragment", sent.code === 0 && /\/s\/\S{22}#AGE-SECRET-KEY-PQ-1/.test(link), sent.err);
  const rawFile = join(home, "raw.txt");
  const opened = cli(["open", link, "--raw", rawFile]);
  check("cli open saved a multi-line value raw", opened.code === 0 && readFileSync(rawFile, "utf8") === "line one\nline two", opened.err);
  const secondOpen = cli(["open", link, "--raw", join(home, "raw2.txt")]);
  check("second open refused (exit 5)", secondOpen.code === 5, secondOpen.err);
  const multi = cli(["send", "--print"], "a\nb");
  const multiLink = multi.out.trim().split("\n")[0];
  const multiOpen = cli(["open", "--env", "X", "--to", join(home, "x.env")], multiLink);
  const multiId = /\/s\/(\S{22})#/.exec(multiLink)?.[1];
  check("multi-line value for --env goes to a 0600 recovery file (exit 7)", multiOpen.code === 7 && readFileSync(join(home, "recovered", `${multiId}.txt`), "utf8") === "a\nb", multiOpen.err);
  const noTarget = cli(["send", "--print"], "keep me");
  const noTargetOpen = cli(["open", noTarget.out.trim().split("\n")[0]]);
  const noTargetId = /\/s\/(\S{22})#/.exec(noTarget.out)?.[1];
  check("open without a target fails before burning", noTargetOpen.code !== 0 && (await call(`/api/items/${noTargetId}`)).data.state === "open");
  const foreign = cli(["open", "--raw", join(home, "f.txt")], `https://vienkartine-phish.example/s/${noTargetId}#AGE-SECRET-KEY-PQ-1QQQQ`);
  check("open refuses links on other hosts", foreign.code === 1 && foreign.err.includes("not on"), foreign.err);

  // 3. Revoke a one-time link.
  const toRevoke = cli(["send", "--print"], "revoke me");
  const revokeId = /\/s\/(\S{22})#/.exec(toRevoke.out)?.[1];
  const revoked = cli(["revoke", revokeId!]);
  check("revoke works", revoked.code === 0 && revoked.out.includes("revoked"), revoked.err);
  const afterRevoke = await call(`/api/items/${revokeId}`);
  check("revoked state visible", afterRevoke.data.state === "revoked");
  const keyHolder = await newIdentity();
  const linkOnly = await call("/api/items", { kind: "send", ciphertext: await encryptText("x", keyHolder.recipient), ttl: 3600, auth: await authFromIdentity(keyHolder.identity) });
  const recipientRevoke = await call(`/api/items/${linkOnly.data.id}/revoke`, { auth: await authFromIdentity(keyHolder.identity) });
  check("a link holder cannot revoke a one-time link (only its creator)", recipientRevoke.status === 403);
  const adminRevoke = cli(["revoke", String(linkOnly.data.id), "--admin"]);
  check("operator token takes down anyone's link (state removed)", adminRevoke.code === 0 && (await call(`/api/items/${linkOnly.data.id}`)).data.state === "removed", adminRevoke.err);

  // 4. Browser-style anonymous send and API guards.
  const keys = await newIdentity();
  const auth = await authFromIdentity(keys.identity);
  const anonSend = await call("/api/items", { kind: "send", ciphertext: await encryptText("x", keys.recipient), ttl: 3600, auth });
  check("anonymous send created (201)", anonSend.status === 201 && typeof anonSend.data.manageToken === "string");
  const anonMeta = await call(`/api/items/${anonSend.data.id}`);
  check("anonymous item is not verified", anonMeta.data.verified === false && anonMeta.data.verifiedName === null);
  const crossOrigin = await call("/api/items", { kind: "send", ciphertext: "x", ttl: 3600, auth }, { Origin: "https://evil.example" });
  check("cross-origin POST refused (403)", crossOrigin.status === 403);
  const formPost = await fetch(`${BASE}/api/items`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  check("non-JSON content type refused (400)", formPost.status === 400);
  const notArmored = await call("/api/items", { kind: "send", ciphertext: "plain text secret", ttl: 3600, auth });
  check("plaintext instead of age armor refused (400)", notArmored.status === 400);
  const tooLong = await call("/api/items", { kind: "send", ciphertext: await encryptText("x".repeat(60_000), keys.recipient), ttl: 3600, auth });
  check("oversized ciphertext refused (400)", tooLong.status === 400);
  const badTtl = await call("/api/items", { kind: "send", ciphertext: await encryptText("x", keys.recipient), ttl: 30 * 86400, auth });
  check("ttl over 7 days refused (400)", badTtl.status === 400);
  const badLabel = await call("/api/items", { kind: "request", recipient: keys.recipient, label: "", ttl: 3600, auth });
  check("empty label refused (400)", badLabel.status === 400);
  const fakeBrand = await call("/api/items", { kind: "request", recipient: keys.recipient, label: "Patvir\u200btinta: PIN", ttl: 3600, auth });
  check("anonymous label posing as verified refused", fakeBrand.status === 400 && fakeBrand.data.error === "label_reserved");
  const fakeOwner = await call("/api/items", { kind: "send", ciphertext: await encryptText("x", keys.recipient), ttl: 3600, auth }, { Authorization: `Bearer ${"B".repeat(43)}` });
  const fakeMeta = await call(`/api/items/${fakeOwner.data.id}`);
  check("wrong operator token does not verify", fakeOwner.status === 201 && fakeMeta.data.verified === false);

  // 5. App pages and headers.
  const pageResponse = await fetch(`${BASE}/s/${anonSend.data.id}`);
  const csp = pageResponse.headers.get("content-security-policy") ?? "";
  check("app page served with no-store + noindex", pageResponse.headers.get("cache-control") === "no-store" && (pageResponse.headers.get("x-robots-tag") ?? "").includes("noindex"));
  check("CSP forbids inline and third-party scripts", csp.includes("script-src 'self'") && !csp.includes("unsafe-inline"));
  check("referrer policy is no-referrer", pageResponse.headers.get("referrer-policy") === "no-referrer");
  const getDoesNotBurn = await call(`/api/items/${anonSend.data.id}`);
  check("viewing the page does not burn the secret", getDoesNotBurn.data.state === "open");

  // 6. Rate limit for anonymous creates (30 per hour per IP).
  let limited = false;
  for (let i = 0; i < 35 && !limited; i++) {
    const r = await call("/api/items", { kind: "request", recipient: keys.recipient, label: `rl ${i}`, ttl: 3600, auth });
    limited = r.status === 429;
  }
  check("anonymous creates are rate limited", limited);
  const ownerStill = cli(["request", "owner after limit"], undefined, env);
  check("operator token bypasses the IP limit", ownerStill.code === 0, ownerStill.err);
  const anonCli = cli(["request", "anon via cli"], undefined, anonymous);
  check("anonymous CLI is limited too", anonCli.code === 6, anonCli.err);
} finally {
  server?.kill();
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
