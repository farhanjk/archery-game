// Real-touch verifier: drives the game ONLY through CDP Input.dispatchTouchEvent
// (genuine touch events through Chrome's input pipeline -> the page's real
// pointer handlers). No internal game functions are called to perform actions;
// window.__archery is read only for assertions.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const URL = process.argv[2] || "http://localhost:8765/index.html";
const OUTDIR = process.argv[3] || "/Users/farhankhan/claude/archery-game";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9223;
// Pixel 8 Pro logical viewport
const VW = 412, VH = 915, DSF = 2.625;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--disable-gpu",
  "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=/tmp/archery-chrome-touch", "--hide-scrollbars", "about:blank",
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
    } else if (m.method) events.push(m);
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, S);
  await send("Runtime.enable", {}, S);
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: DSF, mobile: true }, S);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, S);

  async function ev(expr) {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error("eval failed: " + r.exceptionDetails.text);
    return r.result.value;
  }
  async function shot(name) {
    const { data } = await send("Page.captureScreenshot", { format: "png" }, S);
    const path = `${OUTDIR}/${name}`;
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }
  // genuine touch primitives
  const tStart = (x, y) => send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }, S);
  const tMove  = (x, y) => send("Input.dispatchTouchEvent", { type: "touchMove",  touchPoints: [{ x, y, id: 1 }] }, S);
  const tEnd   = ()     => send("Input.dispatchTouchEvent", { type: "touchEnd",   touchPoints: [] }, S);
  async function tap(x, y) { await tStart(x, y); await sleep(40); await tEnd(); }

  await send("Page.navigate", { url: URL }, S);
  await sleep(1800);

  const out = { url: URL, viewport: `${VW}x${VH}@${DSF}` };

  // ---- 1) Pre-start sanity ----
  out.title = await ev("document.title");
  out.overlayVisibleAtLoad = await ev("!document.getElementById('overlay').classList.contains('hidden') && getComputedStyle(document.getElementById('overlay')).display !== 'none'");
  out.canvasTouchAction = await ev("getComputedStyle(document.getElementById('game')).touchAction");
  out.stateAtLoad = await ev("window.__archery.state");

  // ---- 2) Start the game with a REAL touch tap on the Start button ----
  const btn = await ev("(()=>{const r=document.getElementById('startBtn').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()");
  const b = JSON.parse(btn);
  await tap(b.x, b.y);
  await sleep(300);
  out.stateAfterTouchStart = await ev("window.__archery.state");   // expect "aiming"
  out.arrowsBeforeShot = await ev("window.__archery.arrowsLeft");  // expect 3

  // ---- 3) Compute a drag that should hit (using the page's own physics sim) ----
  const best = JSON.parse(await ev(`(()=>{let best=null;for(let a=-70;a<=5;a+=1){for(let p=0.4;p<=1;p+=0.05){const r=window.__archery.simulate(a,p);if(r.hit&&(!best||r.dist<best.dist))best={a,p,dist:r.dist,pts:r.pts};}}return JSON.stringify(best);})()`));
  out.plannedShot = best;
  // launch vector = (start - current); choose start, derive current from desired a,p
  const lay = JSON.parse(await ev("JSON.stringify(window.__archery.layout())"));
  const MAXDRAW = VH * 0.32;
  const len = best.p * MAXDRAW;
  const rad = best.a * Math.PI / 180;
  const vx = Math.cos(rad) * len, vy = Math.sin(rad) * len; // up-right (vy<0)
  const startX = Math.min(VW - 20, Math.max(20, VW * 0.55));
  const startY = Math.min(VH - 120, Math.max(120, VH * 0.5));
  const curX = startX - vx;   // down-left of start
  const curY = startY - vy;
  out.drag = { from: { x: Math.round(startX), y: Math.round(startY) }, to: { x: Math.round(curX), y: Math.round(curY) } };

  // ---- 4) Perform the drag as REAL touch events (start + intermediate moves) ----
  await tStart(startX, startY);
  await sleep(30);
  const STEPS = 8;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    await tMove(startX + (curX - startX) * t, startY + (curY - startY) * t);
    await sleep(25);
  }
  // mid-draw observations + screenshot (bow should be drawn)
  out.aimingMidDraw = await ev("window.__archery.aiming");      // expect true
  out.drawPowerMidDraw = await ev("window.__archery.drawPower"); // expect > 0
  out.pointerSeen = await ev("window.__archery.pointerSeen");    // expect true
  out.proofDraw = await shot("proof_draw.png");

  // ---- 5) Release -> arrow fires ----
  await tEnd();
  await sleep(1700); // fly + settle
  out.arrowsAfterShot = await ev("window.__archery.arrowsLeft"); // expect 2
  out.scoreAfterShot = await ev("window.__archery.score");
  out.stateAfterShot = await ev("window.__archery.state");
  out.proof = await shot("proof.png");

  out.exceptions = events.filter(e => e.method === "Runtime.exceptionThrown").map(e => e.params?.exceptionDetails?.text);

  console.log(JSON.stringify(out, null, 2));

  const pass =
    out.overlayVisibleAtLoad === true &&
    out.canvasTouchAction === "none" &&
    out.stateAfterTouchStart === "aiming" &&     // start worked via real touch
    out.aimingMidDraw === true &&                // drag registered via real touch
    out.drawPowerMidDraw > 0 &&
    out.arrowsBeforeShot === 3 &&
    out.arrowsAfterShot === 2 &&                 // an arrow was actually consumed
    out.scoreAfterShot > 0 &&                    // and it hit
    out.exceptions.length === 0;

  console.log(pass ? "\nRESULT: PASS ✅ — real touch drove a full shot" : "\nRESULT: FAIL ❌");
  ws.close(); chrome.kill();
  process.exit(pass ? 0 : 2);
}
main().catch((e) => { console.error("VERIFY ERROR:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
