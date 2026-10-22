// Checks that a running instance serves the JavaScript built from this repository.
// Usage: bun run verify https://secret.areza.digital
//
// Every page names the commit it was built from (<meta name="vk-commit">). Check out that commit, then run this. It
// fetches the two landing pages and the app pages for one-time links, requests and their owners (where secrets are
// encrypted and decrypted), checks each page's Content-Security-Policy and every <script> tag, rebuilds the JS here
// and compares it byte for byte with what the site serves, and checks the Subresource Integrity values. Themes change
// HTML and CSS, never the JS, so this works for any instance. What it cannot check is listed in docs/threat-model.md.

import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanScripts } from "./scan-scripts";

const ROOT = join(import.meta.dir, "..");
const target = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(target)) {
  console.error("usage: bun run verify https://secret.areza.digital");
  process.exit(1);
}

let failures = 0;
const ok = (label: string) => console.log(`ok    ${label}`);
const fail = (label: string) => {
  console.log(`FAIL  ${label}`);
  failures++;
};
const warn = (label: string) => console.log(`warn  ${label}`);
const sha = (algorithm: string, data: Uint8Array) => createHash(algorithm).update(data).digest(algorithm === "sha384" ? "base64" : "hex");

const metaOf = (html: string, name: string) => new RegExp(`<meta name="${name}" content="([^"]+)">`).exec(html)?.[1] ?? "unknown";

// 1. Every kind of page: same commit, CSP script-src 'self', and no script except our files under /assets/.
// A fresh, well-formed id per run: the Worker serves an app page for any id, and a fixed one would be easy to special-case.
const id = () => randomBytes(16).toString("base64url");
const paths = ["/", "/en", ...["s", "r", "o"].flatMap((kind) => [`/${kind}/${id()}`, `/en/${kind}/${id()}`])];
let commit = "";
const sources = new Map<string, string | null>(); // src -> integrity
for (const path of paths) {
  const label = path.replace(/[A-Za-z0-9_-]{22}$/, "<id>");
  const page = await fetch(`${target}${path}`, { redirect: "follow" });
  const html = await page.text();
  if (!commit) {
    commit = metaOf(html, "vk-commit");
    console.log(`${target} says: version ${metaOf(html, "vk-version")}, commit ${commit}\n`);
  }
  const problems: string[] = [];
  if (page.status !== 200) problems.push(`status ${page.status}`);
  if (metaOf(html, "vk-commit") !== commit) problems.push(`names commit ${metaOf(html, "vk-commit")}, the home page ${commit}`);
  const csp = page.headers.get("content-security-policy") ?? "";
  const scriptSrc = /(?:^|;\s*)script-src ([^;]+)/.exec(csp)?.[1].trim();
  if (scriptSrc !== "'self'") problems.push(`CSP script-src is not just 'self': ${scriptSrc ?? "(missing)"}`);
  const scan = scanScripts(html);
  problems.push(...scan.problems);
  if (!scan.sources.length) problems.push("no script from /assets/");
  for (const { src, integrity } of scan.sources) {
    if (sources.has(src) && sources.get(src) !== integrity) problems.push(`${src} carries a different integrity value than on another page`);
    sources.set(src, integrity);
  }
  if (problems.length) for (const problem of problems) fail(`${label}: ${problem}`);
  else ok(`${label}: CSP script-src 'self', scripts only from /assets/`);
  if (!csp.includes("require-trusted-types-for 'script'")) warn(`${label}: CSP does not require Trusted Types`);
  if (scan.inline) warn(`${label}: ${scan.inline} inline script(s), not ours (e.g. injected by Cloudflare zone features); the CSP blocks them`);
}
console.log("");

// 2. The commit must be the one checked out here.
const local = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim() !== "";
if (commit.replace(/-dirty$/, "") !== local) {
  fail(`this checkout is ${local.slice(0, 7)}; run \`git checkout ${commit.replace(/-dirty$/, "")}\` and try again`);
  process.exit(1);
}
if (commit.endsWith("-dirty")) warn("the site was built from a checkout with uncommitted changes");
if (dirty) warn("this checkout has uncommitted changes");
const pinned = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).packageManager?.split("@")[1];
if (pinned && pinned !== Bun.version) warn(`Bun ${Bun.version} here, the project pins ${pinned}; bundles may differ`);

// 3. Rebuild the JS and compare it with what the site serves.
const out = mkdtempSync(join(tmpdir(), "vienkartine-verify-"));
try {
  execSync("bun run site/build.ts", { cwd: ROOT, env: { ...process.env, VK_OUT: out }, stdio: "ignore" });
  const built = readdirSync(join(out, "assets")).filter((name) => name.endsWith(".js"));
  for (const [src, integrity] of sources) {
    const served = new Uint8Array(await (await fetch(`${target}${src}`)).arrayBuffer());
    const name = src.split("/").pop() ?? "";
    if (integrity && integrity === `sha384-${sha("sha384", served)}`) ok(`${name}: integrity matches the served file`);
    else fail(`${name}: integrity attribute ${integrity ? "does not match" : "missing"}`);
    if (!built.includes(name)) {
      fail(`${name}: not produced by this build (got ${built.join(", ")})`);
      continue;
    }
    const mine = new Uint8Array(readFileSync(join(out, "assets", name)));
    if (sha("sha256", mine) === sha("sha256", served)) ok(`${name}: identical to this build (sha256 ${sha("sha256", served).slice(0, 16)}…)`);
    else fail(`${name}: differs from this build`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nverified: every page checked runs the JavaScript of this commit");
process.exit(failures ? 1 : 0);
