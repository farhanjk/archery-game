(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const el = {
    level: document.getElementById("level"),
    score: document.getElementById("score"),
    round: document.getElementById("round"),
    roundMax: document.getElementById("roundMax"),
    arrows: document.getElementById("arrows"),
    overlay: document.getElementById("overlay"),
    overTitle: document.getElementById("overTitle"),
    overText: document.getElementById("overText"),
    result: document.getElementById("result"),
    hint: document.getElementById("hint"),
    levelBtns: Array.from(document.querySelectorAll(".levelBtn")),
  };

  // ---- Levels ----
  // moveXf / moveYf: target speed as a fraction of W / H per frame.
  // windf: wind strength as a fraction of gravity (0 = none).
  // rScale: target face size multiplier.
  const LEVELS = [
    { name: "Rookie", moveXf: 0,      moveYf: 0,      windf: 0,    windVar: false, rScale: 1.0 },
    { name: "Archer", moveXf: 0.0016, moveYf: 0,      windf: 0.20, windVar: false, rScale: 0.95 },
    { name: "Master", moveXf: 0.0024, moveYf: 0.0012, windf: 0.45, windVar: true,  rScale: 0.70 },
  ];

  // ---- High scores (localStorage, per level) ----
  const HS_KEY = "archery_high_v1";
  function loadHigh() { try { return JSON.parse(localStorage.getItem(HS_KEY)) || {}; } catch (e) { return {}; } }
  function saveHigh(o) { try { localStorage.setItem(HS_KEY, JSON.stringify(o)); } catch (e) {} }
  function bestFor(idx) { return loadHigh()[idx] || 0; }
  function recordBest(idx, val) {
    const h = loadHigh();
    if (val > (h[idx] || 0)) { h[idx] = val; saveHigh(h); }
    return h[idx] || 0;
  }
  function refreshBestLabels() {
    el.levelBtns.forEach((b) => {
      const idx = parseInt(b.dataset.level, 10);
      const span = b.querySelector(".lvBest");
      if (span) span.textContent = "Best " + bestFor(idx);
    });
  }

  // ---- World sizing ----
  let W = 0, H = 0, DPR = 1;
  const view = {}; // computed layout points

  function viewportSize() {
    // Use the SMALLEST sane width measurement so the canvas can never be wider
    // than the visible screen (innerWidth can be wrong/too-large at first paint
    // on mobile, which pushes the right side of the world off-screen).
    const vv = window.visualViewport;
    const widthCandidates = [
      window.innerWidth,
      document.documentElement && document.documentElement.clientWidth,
      vv && vv.width,
    ].filter((n) => typeof n === "number" && n > 0);
    const heightCandidates = [
      window.innerHeight,
      document.documentElement && document.documentElement.clientHeight,
      vv && vv.height,
    ].filter((n) => typeof n === "number" && n > 0);
    const w = widthCandidates.length ? Math.min(...widthCandidates) : 390;
    const h = heightCandidates.length ? Math.max(...heightCandidates) : 844;
    return { w, h };
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 3); // honor hi-dpi (Pixel = 3)
    const { w, h } = viewportSize();
    W = w; H = h;
    // CSS size == visible viewport; backing store scaled for sharpness.
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    layout();
  }

  function layout() {
    view.groundY = H * 0.86;
    view.anchor = { x: W * 0.18, y: view.groundY - H * 0.12 }; // bow hand (lower-left)
    view.baseR = Math.max(34, Math.min(W * 0.13, H * 0.085));
    target.r = view.baseR * (levelCfg ? levelCfg.rScale : 1);
    // home column for the target, kept clear of the right edge
    view.targetX = Math.min(W * 0.74, W - target.r - W * 0.06);
    // movement bounds (used by levels 2 & 3)
    view.targetMinX = W * 0.52;
    view.targetMaxX = W - target.r - W * 0.05;
    view.targetMinY = H * 0.18 + target.r;
    view.targetMaxY = view.groundY - target.r - H * 0.02;
  }

  // ---- Physics constants (scaled to screen height) ----
  const G = () => 0.00075 * H;        // gravity per frame
  const DRAG = 0.9985;                // air resistance
  const MAX_DRAW = () => H * 0.32;    // max pull distance
  const MIN_SPEED = () => H * 0.012;
  const MAX_SPEED = () => H * 0.045;

  // ---- Game state ----
  const ROUNDS = 5;
  const ARROWS_PER_ROUND = 3;
  let state = "select"; // select | aiming | flying
  let levelIdx = 0;
  let levelCfg = null;  // current level config (null on the select screen)
  let score = 0;
  let round = 1;
  let arrowsLeft = ARROWS_PER_ROUND;

  let aim = null;        // {sx,sy,cx,cy} drag start/current (screen)
  let arrow = null;      // active flying arrow
  let stuck = [];        // arrows stuck in target/ground (for this round visual)
  let popups = [];       // floating score texts
  let flash = 0;         // hit flash timer
  // target: position, motion and the active wind that pushes the arrow.
  let target = { x: 0, y: 0, dirX: 1, dirY: 1, vx: 0, vy: 0, r: 40, wind: 0, windFixed: undefined };

  const rings = [
    { f: 0.22, pts: 100, color: "#ffcf3f" }, // gold
    { f: 0.42, pts: 80,  color: "#ff5b4a" }, // red
    { f: 0.62, pts: 60,  color: "#4aa3ff" }, // blue
    { f: 0.81, pts: 40,  color: "#2c2c2c" }, // black
    { f: 1.0,  pts: 20,  color: "#f3f7fb" }, // white
  ];

  const isPlaying = () => state === "aiming" || state === "flying";

  // ---- Audio (WebAudio, created on first gesture) ----
  let actx = null;
  function audio() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { actx = null; }
    }
    return actx;
  }
  function beep(freq, dur, type, vol, slideTo) {
    const a = audio();
    if (!a) return;
    if (a.state === "suspended") a.resume();
    const t = a.currentTime;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.15, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sndTwang = () => beep(420, 0.18, "sawtooth", 0.18, 130);
  const sndHit   = (pts) => beep(pts >= 80 ? 880 : 600, 0.22, "triangle", 0.22, pts >= 80 ? 1320 : 760);
  const sndMiss  = () => beep(200, 0.25, "sine", 0.12, 90);

  // ---- HUD / screens ----
  function setHud() {
    el.level.textContent = levelIdx + 1;
    el.score.textContent = score;
    el.round.textContent = round;
    el.roundMax.textContent = ROUNDS;
    el.arrows.textContent = arrowsLeft;
  }

  function showSelect(resultHtml) {
    state = "select";
    levelCfg = null;
    aim = null; arrow = null;
    layout();
    refreshBestLabels();
    if (resultHtml) { el.result.innerHTML = resultHtml; el.result.classList.remove("hidden"); }
    else el.result.classList.add("hidden");
    el.hint.classList.add("hidden");
    el.overlay.classList.remove("hidden");
  }

  function startLevel(idx) {
    levelIdx = idx;
    levelCfg = LEVELS[idx];
    score = 0; round = 1; arrowsLeft = ARROWS_PER_ROUND;
    stuck = []; popups = []; arrow = null; aim = null;
    target.windFixed = undefined; // re-roll the level's fixed wind
    layout();                     // recompute target radius/bounds for this level
    setupRound();
    state = "aiming";
    el.overlay.classList.add("hidden");
    el.result.classList.add("hidden");
    el.hint.classList.remove("hidden");
    setHud();
  }

  function setLevelWind() {
    if (!levelCfg || levelCfg.windf === 0) { target.wind = 0; return; }
    const unit = levelCfg.windf * G();
    if (levelCfg.windVar) {
      // gusty: fresh strength & direction each round
      const mag = (0.55 + Math.random() * 0.45) * unit;
      target.wind = (Math.random() < 0.5 ? -1 : 1) * mag;
    } else {
      // steady tail/head wind, chosen once per level
      if (target.windFixed === undefined) target.windFixed = (Math.random() < 0.5 ? -1 : 1) * unit;
      target.wind = target.windFixed;
    }
  }

  function setupRound() {
    target.x = view.targetX;
    target.y = (view.targetMinY + view.targetMaxY) / 2;
    target.dirX = 1; target.dirY = 1;
    target.vx = (levelCfg ? levelCfg.moveXf : 0) * W;
    target.vy = (levelCfg ? levelCfg.moveYf : 0) * H;
    setLevelWind();
  }

  function nextArrowOrRound() {
    if (arrowsLeft > 0) { state = "aiming"; return; }
    if (round < ROUNDS) {
      round++;
      arrowsLeft = ARROWS_PER_ROUND;
      stuck = [];
      setupRound();
      setHud();
      state = "aiming";
    } else {
      endLevel();
    }
  }

  function endLevel() {
    const prevBest = bestFor(levelIdx);
    const best = recordBest(levelIdx, score);
    const max = ROUNDS * ARROWS_PER_ROUND * 100;
    const pct = score / max;
    let rank = "Keep practicing 🎯";
    if (pct >= 0.8) rank = "Legendary! 🏆";
    else if (pct >= 0.55) rank = "Sharpshooter! 🥇";
    else if (pct >= 0.3) rank = "Solid aim! 🥈";
    const isNew = score >= best && score > prevBest;
    const banner =
      "Level " + (levelIdx + 1) + " complete — " + rank +
      '<span class="big">' + score + "</span>" +
      (isNew ? "★ New best!" : "Best " + best);
    showSelect(banner);
  }

  // ---- Input (Pointer Events; unchanged touch flow) ----
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }

  let pointerDot = null; // {x, y, age} — visible tap indicator

  function onDown(e) {
    e.preventDefault();
    audio();
    const p = pos(e);
    pointerDot = { x: p.x, y: p.y, age: 1 };
    try { canvas.setPointerCapture && e.pointerId != null && canvas.setPointerCapture(e.pointerId); } catch (_) {}
    if (state !== "aiming") return;
    aim = { sx: p.x, sy: p.y, cx: p.x, cy: p.y };
  }

  function onMove(e) {
    e.preventDefault();
    const p = pos(e);
    pointerDot = { x: p.x, y: p.y, age: 1 };
    if (!aim || state !== "aiming") return;
    aim.cx = p.x; aim.cy = p.y;
  }

  function onUp(e) {
    e.preventDefault();
    const p = pos(e);
    pointerDot = { x: p.x, y: p.y, age: 1 };
    try { e.pointerId != null && canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!aim || state !== "aiming") return;
    release();
  }

  function onCancel(e) { aim = null; } // browser took over the gesture

  // Compute launch vector from current aim. Pull = start - current (drag back).
  function launchVector() {
    let dx = aim.sx - aim.cx;
    let dy = aim.sy - aim.cy;
    let len = Math.hypot(dx, dy);
    if (len < 6) return null; // too small a pull
    const draw = Math.min(len, MAX_DRAW());
    const power = draw / MAX_DRAW(); // 0..1
    const speed = MIN_SPEED() + (MAX_SPEED() - MIN_SPEED()) * power;
    return { vx: (dx / len) * speed, vy: (dy / len) * speed, power };
  }

  function release() {
    const lv = launchVector();
    aim = null;
    if (!lv) { state = "aiming"; return; } // ignore tiny taps
    arrow = {
      x: view.anchor.x, y: view.anchor.y,
      vx: lv.vx, vy: lv.vy,
      ang: Math.atan2(lv.vy, lv.vx),
      scored: false,
    };
    arrowsLeft = Math.max(0, arrowsLeft - 1);
    setHud();
    state = "flying";
    sndTwang();
  }

  function registerHit(pts, x, y) {
    score += pts;
    setHud();
    popups.push({ x, y, txt: pts > 0 ? "+" + pts : "Miss", life: 1, good: pts > 0 });
    if (pts > 0) { flash = 1; sndHit(pts); } else { sndMiss(); }
  }

  // ---- Update ----
  function update() {
    // move target while a level is in progress
    if (isPlaying()) {
      if (target.vx) {
        target.x += target.dirX * target.vx;
        if (target.x > view.targetMaxX) { target.x = view.targetMaxX; target.dirX = -1; }
        if (target.x < view.targetMinX) { target.x = view.targetMinX; target.dirX = 1; }
      }
      if (target.vy) {
        target.y += target.dirY * target.vy;
        if (target.y > view.targetMaxY) { target.y = view.targetMaxY; target.dirY = -1; }
        if (target.y < view.targetMinY) { target.y = view.targetMinY; target.dirY = 1; }
      }
    }

    if (flash > 0) flash = Math.max(0, flash - 0.05);

    if (arrow) {
      arrow.vy += G();
      arrow.vx += target.wind;   // horizontal wind acceleration
      arrow.vx *= DRAG;
      arrow.vy *= DRAG;
      arrow.x += arrow.vx;
      arrow.y += arrow.vy;
      arrow.ang = Math.atan2(arrow.vy, arrow.vx);

      const tip = { x: arrow.x + Math.cos(arrow.ang) * 14, y: arrow.y + Math.sin(arrow.ang) * 14 };

      if (!arrow.scored) {
        const dist = Math.hypot(tip.x - target.x, tip.y - target.y);
        if (dist <= target.r) {
          let pts = 20;
          for (const ring of rings) { if (dist <= target.r * ring.f) { pts = ring.pts; break; } }
          arrow.scored = true;
          registerHit(pts, target.x, target.y - target.r - 8);
          // store relative to the target so the arrow rides along when it moves
          stuck.push({ dx: tip.x - target.x, dy: tip.y - target.y, ang: arrow.ang, onTarget: true });
          arrow = null;
          settle();
        } else if (tip.y >= view.groundY) {
          arrow.scored = true;
          registerHit(0, tip.x, view.groundY - 30);
          stuck.push({ x: tip.x, y: view.groundY, ang: arrow.ang, onTarget: false });
          arrow = null;
          settle();
        } else if (tip.x > W + 40 || tip.x < -40 || tip.y > H + 60) {
          arrow.scored = true;
          registerHit(0, Math.min(W - 30, Math.max(30, tip.x)), H * 0.5);
          arrow = null;
          settle();
        }
      }
    }

    for (const p of popups) { p.y -= 0.8; p.life -= 0.018; }
    popups = popups.filter(p => p.life > 0);

    if (pointerDot && !aim) {
      pointerDot.age -= 0.03;
      if (pointerDot.age <= 0) pointerDot = null;
    }
  }

  let settleTimer = null;
  function settle() {
    if (settleTimer) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (state === "flying") nextArrowOrRound();
    }, 650);
  }

  // ---- Render ----
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#2b4a63");
    g.addColorStop(0.6, "#5b90b8");
    g.addColorStop(1, "#9bc4dd");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "rgba(255,231,168,0.55)";
    ctx.beginPath();
    ctx.arc(W * 0.78, H * 0.13, 34, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(60,110,90,0.5)";
    ctx.beginPath();
    ctx.moveTo(0, view.groundY);
    ctx.quadraticCurveTo(W * 0.25, view.groundY - H * 0.13, W * 0.5, view.groundY - H * 0.04);
    ctx.quadraticCurveTo(W * 0.78, view.groundY - H * 0.16, W, view.groundY - H * 0.05);
    ctx.lineTo(W, view.groundY);
    ctx.closePath();
    ctx.fill();
  }

  function drawGround() {
    const g = ctx.createLinearGradient(0, view.groundY, 0, H);
    g.addColorStop(0, "#5a8f4e");
    g.addColorStop(1, "#3f6b39");
    ctx.fillStyle = g;
    ctx.fillRect(0, view.groundY, W, H - view.groundY);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, view.groundY);
    ctx.lineTo(W, view.groundY);
    ctx.stroke();
  }

  function drawTarget() {
    const x = target.x, y = target.y, R = target.r;
    ctx.strokeStyle = "#7a5230";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x - R * 0.5, y + R * 0.4);
    ctx.lineTo(x - R * 0.5, view.groundY);
    ctx.moveTo(x + R * 0.5, y + R * 0.4);
    ctx.lineTo(x + R * 0.5, view.groundY);
    ctx.stroke();

    for (let i = rings.length - 1; i >= 0; i--) {
      ctx.beginPath();
      ctx.arc(x, y, R * rings[i].f, 0, Math.PI * 2);
      ctx.fillStyle = rings[i].color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, R * 0.05), 0, Math.PI * 2);
    ctx.fillStyle = "#1d2b3a";
    ctx.fill();
  }

  function drawWind() {
    if (!isPlaying()) return;
    const cx = W * 0.5, cy = Math.max(56, H * 0.085);
    const w = target.wind || 0;
    const ratio = w === 0 ? 0 : Math.abs(w) / G();
    ctx.save();
    ctx.textAlign = "left";
    ctx.font = "800 12px -apple-system, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    if (ratio < 0.02) {
      ctx.textAlign = "center";
      ctx.fillText("WIND · CALM", cx, cy + 4);
    } else {
      const dir = w > 0 ? 1 : -1;
      const chev = ratio < 0.25 ? 1 : ratio < 0.45 ? 2 : 3;
      ctx.fillText("WIND", cx - 46, cy + 4);
      ctx.strokeStyle = dir > 0 ? "#7ee081" : "#ff8a6b";
      ctx.lineWidth = 2.6;
      const startX = cx + 4;
      for (let i = 0; i < chev; i++) {
        const bx = startX + i * 11 * dir;
        ctx.beginPath();
        ctx.moveTo(bx, cy - 5);
        ctx.lineTo(bx + 8 * dir, cy);
        ctx.lineTo(bx, cy + 5);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawArrowShape(x, y, ang, len) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.strokeStyle = "#caa46b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    ctx.fillStyle = "#e9eef3";
    ctx.beginPath();
    ctx.moveTo(len + 8, 0);
    ctx.lineTo(len - 2, -4);
    ctx.lineTo(len - 2, 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ff6b4a";
    ctx.beginPath();
    ctx.moveTo(-len, 0); ctx.lineTo(-len + 8, -5); ctx.lineTo(-len + 4, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-len, 0); ctx.lineTo(-len + 8, 5); ctx.lineTo(-len + 4, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawBow() {
    const a = view.anchor;
    ctx.strokeStyle = "#3a2a18";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x, view.groundY);
    ctx.stroke();

    let dirAng = -0.5;
    let pull = 0;
    if (aim) {
      const dx = aim.sx - aim.cx, dy = aim.sy - aim.cy;
      const len = Math.hypot(dx, dy);
      if (len > 6) { dirAng = Math.atan2(dy, dx); pull = Math.min(len, MAX_DRAW()) / MAX_DRAW(); }
    }

    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(dirAng);
    const bowR = H * 0.07;
    ctx.strokeStyle = "#6b4a25";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, 0, bowR, -Math.PI / 2.4, Math.PI / 2.4);
    ctx.stroke();
    const top = { x: Math.cos(-Math.PI / 2.4) * bowR, y: Math.sin(-Math.PI / 2.4) * bowR };
    const bot = { x: Math.cos(Math.PI / 2.4) * bowR, y: Math.sin(Math.PI / 2.4) * bowR };
    const nock = { x: -pull * MAX_DRAW() * 0.45, y: 0 };
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(nock.x, nock.y);
    ctx.lineTo(bot.x, bot.y);
    ctx.stroke();
    if (aim && pull > 0) {
      ctx.strokeStyle = "#caa46b";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(nock.x, nock.y);
      ctx.lineTo(nock.x + bowR + 14, 0);
      ctx.stroke();
      ctx.fillStyle = "#e9eef3";
      ctx.beginPath();
      ctx.moveTo(nock.x + bowR + 22, 0);
      ctx.lineTo(nock.x + bowR + 12, -4);
      ctx.lineTo(nock.x + bowR + 12, 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawTrajectory() {
    if (!aim) return;
    const lv = launchVector();
    if (!lv) return;
    let x = view.anchor.x, y = view.anchor.y, vx = lv.vx, vy = lv.vy;
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    for (let i = 0; i < 60; i++) {
      vy += G(); vx += target.wind; vx *= DRAG; vy *= DRAG;
      x += vx; y += vy;
      if (y > view.groundY || x > W || x < 0) break;
      if (i % 3 === 0) {
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const mw = Math.min(180, W * 0.5), mh = 8;
    const mx = (W - mw) / 2, my = H * 0.92;
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(mx, my, mw, mh);
    const grad = ctx.createLinearGradient(mx, 0, mx + mw, 0);
    grad.addColorStop(0, "#7ee081"); grad.addColorStop(0.6, "#ffcf3f"); grad.addColorStop(1, "#ff5b4a");
    ctx.fillStyle = grad;
    ctx.fillRect(mx, my, mw * lv.power, mh);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(mx, my, mw, mh);
  }

  function drawPopups() {
    ctx.textAlign = "center";
    ctx.font = "800 22px -apple-system, system-ui, sans-serif";
    for (const p of popups) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.good ? "#ffe27a" : "#ff8a6b";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.strokeText(p.txt, p.x, p.y);
      ctx.fillText(p.txt, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    drawSky();
    drawGround();
    drawTarget();
    drawWind();

    for (const s of stuck) {
      const len = 12;
      const px = s.onTarget ? target.x + s.dx : s.x;
      const py = s.onTarget ? target.y + s.dy : s.y;
      drawArrowShape(px - Math.cos(s.ang) * len, py - Math.sin(s.ang) * len, s.ang, len);
    }

    drawTrajectory();
    drawBow();

    if (arrow) drawArrowShape(arrow.x, arrow.y, arrow.ang, 12);

    drawPopups();

    if (pointerDot) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, pointerDot.age));
      ctx.beginPath();
      ctx.arc(pointerDot.x, pointerDot.y, 16, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffe27a";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pointerDot.x, pointerDot.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffe27a";
      ctx.fill();
      ctx.restore();
    }

    if (flash > 0) {
      ctx.fillStyle = "rgba(255,236,150," + (flash * 0.25) + ")";
      ctx.fillRect(0, 0, W, H);
    }
  }

  function loop() {
    update();
    render();
    requestAnimationFrame(loop);
  }

  // ---- Wire up ----
  const supportsPointer = window.PointerEvent !== undefined;
  if (supportsPointer) {
    canvas.addEventListener("pointerdown", onDown, { passive: false });
    canvas.addEventListener("pointermove", onMove, { passive: false });
    canvas.addEventListener("pointerup", onUp, { passive: false });
    canvas.addEventListener("pointercancel", onCancel, { passive: false });
  } else {
    canvas.addEventListener("touchstart", onDown, { passive: false });
    canvas.addEventListener("touchmove", onMove, { passive: false });
    canvas.addEventListener("touchend", onUp, { passive: false });
    canvas.addEventListener("touchcancel", onCancel, { passive: false });
    canvas.addEventListener("mousedown", onDown, { passive: false });
    canvas.addEventListener("mousemove", onMove, { passive: false });
    canvas.addEventListener("mouseup", onUp, { passive: false });
  }

  el.levelBtns.forEach((btn) => {
    btn.addEventListener("click", () => { audio(); startLevel(parseInt(btn.dataset.level, 10)); });
  });

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => { resize(); setTimeout(resize, 250); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", resize);
    window.visualViewport.addEventListener("scroll", resize);
  }
  window.addEventListener("load", resize);
  setTimeout(resize, 100);
  setTimeout(resize, 500);

  resize();
  refreshBestLabels();
  loop();

  // ---- Test hook for automated verification ----
  window.__archery = {
    get state() { return state; },
    get score() { return score; },
    get round() { return round; },
    get level() { return levelIdx + 1; },
    get levelName() { return levelCfg ? levelCfg.name : null; },
    get wind() { return target.wind; },
    get windRatio() { return target.wind ? target.wind / G() : 0; },
    get overlayVisible() { return !el.overlay.classList.contains("hidden"); },
    // read-only observers used to assert REAL pointer/touch events reached the handlers
    get aiming() { return !!aim; },
    get arrowsLeft() { return arrowsLeft; },
    get hasArrow() { return !!arrow; },
    get pointerSeen() { return !!pointerDot; },
    get drawPower() {
      if (!aim) return 0;
      const dx = aim.sx - aim.cx, dy = aim.sy - aim.cy;
      return Math.min(Math.hypot(dx, dy), MAX_DRAW()) / MAX_DRAW();
    },
    bestFor: (idx) => bestFor(idx),
    layout: () => ({ ...view, targetX: target.x, targetY: target.y, targetR: target.r, wind: target.wind }),
    maxDraw: () => MAX_DRAW(),
    // pure physics sim (no state change), honoring current target pos/size + wind
    simulate(angleDeg, power) {
      const rad = angleDeg * Math.PI / 180;
      const speed = MIN_SPEED() + (MAX_SPEED() - MIN_SPEED()) * power;
      let x = view.anchor.x, y = view.anchor.y;
      let vx = Math.cos(rad) * speed, vy = Math.sin(rad) * speed;
      for (let i = 0; i < 1200; i++) {
        vy += G(); vx += target.wind; vx *= DRAG; vy *= DRAG;
        x += vx; y += vy;
        const ang = Math.atan2(vy, vx);
        const tx = x + Math.cos(ang) * 14, ty = y + Math.sin(ang) * 14;
        const dist = Math.hypot(tx - target.x, ty - target.y);
        if (dist <= target.r) {
          let pts = 20;
          for (const ring of rings) { if (dist <= target.r * ring.f) { pts = ring.pts; break; } }
          return { hit: true, dist, pts };
        }
        if (ty >= view.groundY || tx > W + 40 || tx < -40 || ty > H + 60) break;
      }
      return { hit: false };
    },
    // best (angle,power) for the current instant (used to plan a real touch drag)
    planShot() {
      let best = null;
      for (let a = -72; a <= 5; a += 1) {
        for (let p = 0.45; p <= 1.0; p += 0.05) {
          const r = this.simulate(a, p);
          if (r.hit && (!best || r.dist < best.dist)) best = { a, p, dist: r.dist, pts: r.pts };
        }
      }
      return best;
    },
  };
})();
