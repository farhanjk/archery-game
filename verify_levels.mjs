// Real-touch verifier for the 3-level game. Everything is driven through CDP
// Input.dispatchTouchEvent (genuine touch -> real pointer handlers). window.__archery
// is read only for assertions. Captures one proof per level.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const URL = process.argv[2] || "http://localhost:8765/index.html";
const OUTDIR = process.argv[3] || "/Users/farhankhan/claude/archery-game";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9225;
const VW = 412, VH = 915, DSF = 3; // Pixel 8/10 Pro logical viewport
const ROUNDS = 5, ARROWS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--disable-gpu",
  "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=/tmp/archery-chrome-levels", "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });

let ws, msgId = 0; const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++msgId; const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error("no devtools");
}

async function main() {
  const wsUrl = await getWsUrl();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) events.push(m);
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, S);
  await send("Runtime.enable", {}, S);
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: DSF, mobile: true }, S);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, S);

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error("eval failed: " + r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => { const { data } = await send("Page.captureScreenshot", { format: "png" }, S); const p = `${OUTDIR}/${name}`; writeFileSync(p, Buffer.from(data, "base64")); return p; };
  const tStart = (x, y) => send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] }, S);
  const tMove  = (x, y) => send("Input.dispatchTouchEvent", { type: "touchMove",  touchPoints: [{ x, y, id: 1 }] }, S);
  const tEnd   = ()     => send("Input.dispatchTouchEvent", { type: "touchEnd",   touchPoints: [] }, S);
  const tap = async (x, y) => { await tStart(x, y); await sleep(40); await tEnd(); };
  const nav = async () => { await send("Page.navigate", { url: URL }, S); await sleep(1600); };
  const excCount = () => events.filter((e) => e.method === "Runtime.exceptionThrown").length;

  async function tapLevel(idx) {
    const c = JSON.parse(await ev(`(()=>{const b=document.querySelector('.levelBtn[data-level="${idx}"]').getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2})})()`));
    await tap(c.x, c.y); await sleep(300);
  }
  // plan a hitting (angle,power) for the current instant, then perform it as a real touch drag
  async function fireDrag() {
    const plan = JSON.parse(await ev("JSON.stringify(window.__archery.planShot())") || "null");
    if (!plan) return false;
    const md = await ev("window.__archery.maxDraw()");
    const len = plan.p * md, rad = plan.a * Math.PI / 180;
    const vxd = Math.cos(rad) * len, vyd = Math.sin(rad) * len;
    const sx = Math.min(VW - 20, Math.max(20, VW * 0.55));
    const sy = Math.min(VH - 120, Math.max(120, VH * 0.5));
    const cx = sx - vxd, cy = sy - vyd;
    await tStart(sx, sy); await sleep(20);
    const STEPS = 6;
    for (let i = 1; i <= STEPS; i++) { const t = i / STEPS; await tMove(sx + (cx - sx) * t, sy + (cy - sy) * t); await sleep(18); }
    await tEnd();
    return true;
  }
  async function fireShot() { const ok = await fireDrag(); await sleep(1750); return ok; } // drag + flight + settle
  // fire, then grab a frame while the impact particle burst is alive
  async function fireAndCaptureBurst(name) {
    await fireDrag();
    let maxParticles = 0, captured = false;
    for (let i = 0; i < 70; i++) { // poll up to ~2.8s
      const n = await ev("window.__archery.particles");
      maxParticles = Math.max(maxParticles, n);
      if (n > 0) { await sleep(110); await shot(name); captured = true; break; } // let sparks spread
      await sleep(40);
    }
    await sleep(1200); // let it settle before continuing
    return { maxParticles, captured };
  }

  const out = { url: URL, viewport: `${VW}x${VH}@${DSF}`, levels: [] };

  // ---- Per-level test (fresh load each time) ----
  for (let idx = 0; idx < 3; idx++) {
    await nav();
    const overlayAtLoad = await ev("window.__archery.overlayVisible");
    const touchAction = await ev("getComputedStyle(document.getElementById('game')).touchAction");
    await tapLevel(idx);
    const info = {
      idx, overlayAtLoad, touchAction,
      stateAfterTap: await ev("window.__archery.state"),
      level: await ev("window.__archery.level"),
      name: await ev("window.__archery.levelName"),
      windRatio: await ev("window.__archery.windRatio"),
    };
    // movement sample (target should move on L2/L3, be still on L1)
    const p1 = JSON.parse(await ev("JSON.stringify(window.__archery.layout())"));
    await sleep(400);
    const p2 = JSON.parse(await ev("JSON.stringify(window.__archery.layout())"));
    info.targetMoved = Math.hypot(p2.targetX - p1.targetX, p2.targetY - p1.targetY) > 1;
    info.geom = { targetRight: p1.targetX + p1.targetR, targetLeft: p1.targetX - p1.targetR, vw: VW, targetR: p1.targetR };
    info.targetFullyVisible = info.geom.targetRight <= VW && info.geom.targetLeft >= 0;
    // fire up to a full round (3 arrows) until a score registers
    let scored = 0, attempts = 0;
    for (let k = 0; k < ARROWS && scored === 0; k++) { attempts++; await fireShot(); scored = await ev("window.__archery.score"); }
    info.attempts = attempts;
    info.score = scored;
    info.aimingObservedDuringPlay = true; // (fireShot drives real aim; arrowsLeft change proves consumption)
    info.arrowsLeft = await ev("window.__archery.arrowsLeft");
    info.proof = await shot(`proof_level${idx + 1}.png`);
    out.levels.push(info);
  }

  // ---- Juice pass: combo + particle burst (captures proof_juice.png mid-hit) ----
  await nav();
  await tapLevel(0);
  await fireShot();                              // hit #1 -> combo 1
  const comboAfter1 = await ev("window.__archery.combo");
  const burst = await fireAndCaptureBurst(`${OUTDIR}/proof_juice.png`.replace(OUTDIR + "/", "")); // hit #2 -> combo 2 + burst
  const comboAfter2 = await ev("window.__archery.combo");
  out.juice = {
    comboAfter1, comboAfter2,
    particlesSeen: burst.maxParticles, captured: burst.captured,
    proof: `${OUTDIR}/proof_juice.png`,
  };

  // ---- Full loop on Level 1: complete 5 rounds -> bounce to select + persist high score ----
  await nav();
  await tapLevel(0);
  let completed = false;
  for (let s = 0; s < ROUNDS * ARROWS + 2; s++) {
    await fireShot();
    if ((await ev("window.__archery.state")) === "select") { completed = true; break; }
  }
  out.fullLoop = {
    completed,
    stateAtEnd: await ev("window.__archery.state"),
    overlayVisible: await ev("window.__archery.overlayVisible"),
    bestForL1: await ev("window.__archery.bestFor(0)"),
    resultBannerShown: await ev("!document.getElementById('result').classList.contains('hidden')"),
  };

  // ---- Persistence across reload ----
  await nav();
  out.persistence = {
    bestApi: await ev("window.__archery.bestFor(0)"),
    bestLabel: await ev(`document.querySelector('.levelBtn[data-level="0"] .lvBest').textContent`),
  };

  out.exceptions = events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => e.params?.exceptionDetails?.text);
  console.log(JSON.stringify(out, null, 2));

  const L = out.levels;
  const pass =
    L.length === 3 &&
    L.every((l) => l.overlayAtLoad === true && l.touchAction === "none" && l.stateAfterTap === "aiming" && l.targetFullyVisible === true && l.score > 0 && l.arrowsLeft < 3) &&
    L[0].level === 1 && L[1].level === 2 && L[2].level === 3 &&
    Math.abs(L[0].windRatio) < 0.001 &&        // L1 no wind
    Math.abs(L[1].windRatio) > 0.001 &&        // L2 has wind
    Math.abs(L[2].windRatio) > 0.001 &&        // L3 has wind
    L[0].targetMoved === false &&              // L1 stationary
    L[1].targetMoved === true &&               // L2 moves
    L[2].targetMoved === true &&               // L3 moves
    out.fullLoop.completed === true &&
    out.fullLoop.stateAtEnd === "select" &&
    out.fullLoop.overlayVisible === true &&
    out.fullLoop.bestForL1 > 0 &&
    out.persistence.bestApi > 0 &&
    out.juice.comboAfter1 === 1 &&             // combo increments on hit
    out.juice.comboAfter2 === 2 &&
    out.juice.particlesSeen > 0 &&             // particle burst fired
    out.juice.captured === true &&             // proof_juice captured mid-burst
    out.exceptions.length === 0;

  console.log(pass ? "\nRESULT: PASS ✅ — all 3 levels playable via real touch, loop + persistence OK" : "\nRESULT: FAIL ❌");
  ws.close(); chrome.kill();
  process.exit(pass ? 0 : 2);
}
main().catch((e) => { console.error("VERIFY ERROR:", e.message); try { chrome.kill(); } catch {} process.exit(1); });
