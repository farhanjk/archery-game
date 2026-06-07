// Headless-Chrome verifier over the DevTools Protocol (no npm deps).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const URL = process.argv[2] || "http://localhost:8765/index.html";
const OUT = process.argv[3] || "/Users/farhankhan/claude/archery-game/proof.png";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=/tmp/archery-chrome-profile",
  "--hide-scrollbars",
  "about:blank",
], { stdio: "ignore" });

let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome devtools never came up");
}

async function main() {
  const wsUrl = await getWsUrl();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) {
      events.push(m);
    }
  };

  // create a page target and attach
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = sessionId;

  await send("Page.enable", {}, S);
  await send("Runtime.enable", {}, S);
  await send("Console.enable", {}, S);

  // mobile viewport ~ iPhone 12 (390x844)
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  }, S);

  await send("Page.navigate", { url: URL }, S);
  await sleep(1800);

  const collectErrors = events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params?.exceptionDetails?.text);

  async function eval_(expr) {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error("eval failed: " + r.exceptionDetails.text);
    return r.result.value;
  }

  // sanity: page + canvas present
  const title = await eval_("document.title");
  const canvasOk = await eval_("!!document.getElementById('game') && document.getElementById('game').width > 0");
  const hasHook = await eval_("typeof window.__archery === 'object'");

  // start the game and fire a guaranteed-hitting shot
  await eval_("window.__archery.start()");
  await sleep(300);
  const stateAfterStart = await eval_("window.__archery.state");
  const shot = await eval_("JSON.stringify(window.__archery.autoHit())");
  await sleep(1600); // let arrow fly + settle
  const score = await eval_("window.__archery.score");
  const stateNow = await eval_("window.__archery.state");

  // take the proof screenshot (back on the menu/aiming view shows full UI)
  const shotJson = JSON.parse(shot || "null");
  const { data } = await send("Page.captureScreenshot", { format: "png" }, S);
  writeFileSync(OUT, Buffer.from(data, "base64"));

  const result = {
    title, canvasOk, hasHook, stateAfterStart,
    shot: shotJson, score, stateNow,
    exceptions: collectErrors,
    consoleErrors: events.filter(e => e.method === "Runtime.consoleAPICalled" && e.params.type === "error").map(e => e.params.args.map(a=>a.value).join(" ")),
    screenshot: OUT,
  };
  console.log(JSON.stringify(result, null, 2));

  ws.close();
  chrome.kill();
  // pass/fail
  const pass = canvasOk && hasHook && shotJson && shotJson.hit && score >= 20 && collectErrors.length === 0;
  process.exit(pass ? 0 : 2);
}

main().catch((e) => { console.error("VERIFY ERROR:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
