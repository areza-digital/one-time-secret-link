// Checks that a running instance serves the JavaScript built from this repository.
// Usage: bun run verify https://vienkartine.lt
//
// The page names the commit it was built from (<meta name="vk-commit">). Check out that commit, then run this:
// it rebuilds the JS here and compares it byte for byte with what the site serves, checks the Subresource
// Integrity values, and checks that the Content-Security-Policy only allows our own scripts. Themes change HTML and
// CSS, never the JS, so this works for any instance, whatever it looks like.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const target = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(target)) {
  console.error("usage: bun run verify https://vienkartine.lt");
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

const page = await fetch(`${target}/`, { redirect: "follow" });
const html = await page.text();
const csp = page.headers.get("content-security-policy") ?? "";
const commit = /<meta name="vk-commit" content="([^"]+)">/.exec(html)?.[1] ?? "unknown";
const version = /<meta name="vk-version" content="([^"]+)">/.exec(html)?.[1] ?? "unknown";
console.log(`${target} says: version ${version}, commit ${commit}\n`);

// 1. Policy: scripts only from our own origin, nothing inline that could run.
const scriptSrc = /(?:^|;\s*)script-src ([^;]+)/.exec(csp)?.[1].trim();
if (scriptSrc === "'self'") ok("CSP allows only same-origin scripts, no inline or eval");
else fail(`CSP script-src is not just 'self': ${scriptSrc ?? "(missing)"}`);
if (csp.includes("require-trusted-types-for 'script'")) ok("CSP requires Trusted Types");
else warn("CSP does not require Trusted Types");

const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const external = scripts.filter(([, attrs]) => /\bsrc=/.test(attrs));
const inlineCode = scripts.filter(([, attrs, body]) => !/\bsrc=/.test(attrs) && !/type="application\/(ld\+)?json"/.test(attrs) && body.trim());
for (const [, attrs] of external) {
  const src = /src="([^"]+)"/.exec(attrs)?.[1] ?? "";
  if (!src.startsWith("/assets/")) fail(`script from outside /assets/: ${src}`);
}
if (inlineCode.length) warn(`${inlineCode.length} inline script(s) in the page, not ours (e.g. injected by Cloudflare zone features); the CSP blocks them`);

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
  for (const [, attrs] of external) {
    const src = /src="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const integrity = /integrity="([^"]+)"/.exec(attrs)?.[1];
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

console.log(failures ? `\n${failures} check(s) failed` : "\nverified: the site runs the JavaScript of this commit");
process.exit(failures ? 1 : 0);
