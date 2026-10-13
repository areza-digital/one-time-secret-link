// Screenshots at real device widths through the Chrome DevTools protocol, plus a horizontal-overflow check.
// Usage: bun run scripts/shoot.ts <base-url> <out-dir> [path ...]
// Reports any element wider than the viewport, which is how flex/grid clipping (REFLECT rule 4) shows up.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [base = "http://127.0.0.1:8787", out = "shots", ...paths] = process.argv.slice(2);
const targets = paths.length ? paths : ["/", "/en"];
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1440, height: 900, mobile: false },
];
const THEMES = ["light", "dark"] as const;

mkdirSync(out, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = Bun.spawn(
  [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${join(out, ".profile")}`, "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

let wsUrl = "";
for (let i = 0; i < 50 && !wsUrl; i++) {
  await Bun.sleep(200);
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
  wsUrl = (list as { type: string; webSocketDebuggerUrl: string }[] | null)?.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
}
if (!wsUrl) throw new Error("chrome did not start");

const ws = new WebSocket(wsUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map<number, (value: any) => void>();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message.result ?? message.error);
    pending.delete(message.id);
  }
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression: string) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

await send("Page.enable");
let problems = 0;
for (const path of targets) {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.mobile ? 2 : 1,
        mobile: viewport.mobile,
      });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      await send("Page.navigate", { url: `${base}${path}` });
      await Bun.sleep(1800);
      await evaluate(`document.querySelectorAll('[data-scene]').forEach(s => s.dataset.visible = '')`);
      const overflow = await evaluate(`(() => {
        const w = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > w + 1 || r.left < -1); })
          .filter(el => !el.closest('[hidden]'))
          .slice(0, 6)
          .map(el => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' ' + Math.round(el.getBoundingClientRect().right));
        return { scrollWidth: document.documentElement.scrollWidth, width: w, wide };
      })()`);
      const height = await evaluate("document.documentElement.scrollHeight");
      // Segments of about two screens each, so every part stays readable.
      const segment = viewport.height * 2;
      const name = `${path === "/" ? "home" : path.replace(/^\//, "").replace(/\//g, "_")}-${viewport.name}-${theme}`;
      for (let y = 0, part = 0; y < Math.min(height, 12000); y += segment, part++) {
        const shot = await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y, width: viewport.width, height: Math.min(segment, height - y), scale: 1 },
        });
        await Bun.write(join(out, `${name}-${part}.png`), Buffer.from(shot.data, "base64"));
      }
      const bad = overflow.scrollWidth > overflow.width || overflow.wide.length > 0;
      if (bad) problems++;
      console.log(`${bad ? "OVERFLOW" : "ok      "} ${name} scroll=${overflow.scrollWidth}/${overflow.width} ${overflow.wide.join(", ")}`);
    }
  }
}
ws.close();
chrome.kill();
process.exit(problems ? 1 : 0);
