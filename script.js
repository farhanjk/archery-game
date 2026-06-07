(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const el = {
    score: document.getElementById("score"),
    round: document.getElementById("round"),
    roundMax: document.getElementById("roundMax"),
    arrows: document.getElementById("arrows"),
    overlay: document.getElementById("overlay"),
    overTitle: document.getElementById("overTitle"),
    overText: document.getElementById("overText"),
    finalScore: document.getElementById("finalScore"),
    startBtn: document.getElementById("startBtn"),
    hint: document.getElementById("hint"),
  };

  // ---- World sizing ----
  let W = 0, H = 0, DPR = 1;
  const view = {}; // computed layout points

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    layout();
  }

  function layout() {
    view.groundY = H * 0.86;
    view.anchor = { x: W * 0.2, y: view.groundY - H * 0.12 }; // bow hand
    view.targetX = W * 0.8;
    view.targetR = Math.max(38, Math.min(W, H) * 0.11);
    view.targetMinY = H * 0.18 + view.targetR;
    view.targetMaxY = view.groundY - view.targetR - H * 0.02;
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
  let state = "menu"; // menu | aiming | flying | over
  let score = 0;
  let round = 1;
  let arrowsLeft = ARROWS_PER_ROUND;

  let aim = null;        // {sx,sy,cx,cy} drag start/current (screen)
  let arrow = null;      // active flying arrow
  let stuck = [];        // arrows stuck in target/ground (for this round visual)
  let popups = [];       // floating score texts
  let flash = 0;         // hit flash timer
  let target = { y: 0, dir: 1, speed: 0 };

  const rings = [
    { f: 0.22, pts: 100, color: "#ffcf3f" }, // gold
    { f: 0.42, pts: 80,  color: "#ff5b4a" }, // red
    { f: 0.62, pts: 60,  color: "#4aa3ff" }, // blue
    { f: 0.81, pts: 40,  color: "#2c2c2c" }, // black
    { f: 1.0,  pts: 20,  color: "#f3f7fb" }, // white
  ];

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

  // ---- Helpers ----
  function setHud() {
    el.score.textContent = score;
    el.round.textContent = round;
    el.roundMax.textContent = ROUNDS;
    el.arrows.textContent = arrowsLeft;
  }

  function startGame() {
    score = 0; round = 1; arrowsLeft = ARROWS_PER_ROUND;
    stuck = []; popups = []; arrow = null; aim = null;
    state = "aiming";
    el.overlay.classList.add("hidden");
    el.hint.classList.remove("hidden");
    setTargetForRound();
    setHud();
  }

  function setTargetForRound() {
    target.y = (view.targetMinY + view.targetMaxY) / 2;
    target.dir = 1;
    // round 1 stationary-ish, then faster each round
    target.speed = (round - 1) * (H * 0.0016);
  }

  function nextArrowOrRound() {
    if (arrowsLeft > 0) {
      state = "aiming";
      return;
    }
    if (round < ROUNDS) {
      round++;
      arrowsLeft = ARROWS_PER_ROUND;
      stuck = [];
      setTargetForRound();
      setHud();
      state = "aiming";
    } else {
      gameOver();
    }
  }

  function gameOver() {
    state = "over";
    el.hint.classList.add("hidden");
    el.overTitle.textContent = "Game Over";
    el.overText.textContent = "Nice shooting! Think you can beat that?";
    let rank = "Keep practicing 🎯";
    const max = ROUNDS * ARROWS_PER_ROUND * 100;
    const pct = score / max;
    if (pct >= 0.8) rank = "Legendary archer! 🏆";
    else if (pct >= 0.55) rank = "Sharpshooter! 🥇";
    else if (pct >= 0.3) rank = "Solid aim! 🥈";
    el.finalScore.innerHTML = rank + '<span class="big">' + score + "</span>";
    el.finalScore.classList.remove("hidden");
    el.startBtn.textContent = "Play Again";
    el.overlay.classList.remove("hidden");
  }

  // ---- Input ----
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }

  function onDown(e) {
    if (state !== "aiming") return;
    e.preventDefault();
    audio();
    const p = pos(e);
    aim = { sx: p.x, sy: p.y, cx: p.x, cy: p.y };
  }

  function onMove(e) {
    if (!aim || state !== "aiming") return;
    e.preventDefault();
    const p = pos(e);
    aim.cx = p.x; aim.cy = p.y;
  }

  function onUp(e) {
    if (!aim || state !== "aiming") return;
    e.preventDefault();
    release();
  }

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
    // move target
    if (state !== "menu" && state !== "over" && target.speed > 0) {
      target.y += target.dir * target.speed;
      if (target.y > view.targetMaxY) { target.y = view.targetMaxY; target.dir = -1; }
      if (target.y < view.targetMinY) { target.y = view.targetMinY; target.dir = 1; }
    }

    if (flash > 0) flash = Math.max(0, flash - 0.05);

    if (arrow) {
      arrow.vy += G();
      arrow.vx *= DRAG;
      arrow.vy *= DRAG;
      arrow.x += arrow.vx;
      arrow.y += arrow.vy;
      arrow.ang = Math.atan2(arrow.vy, arrow.vx);

      const tip = { x: arrow.x + Math.cos(arrow.ang) * 14, y: arrow.y + Math.sin(arrow.ang) * 14 };

      if (!arrow.scored) {
        const dist = Math.hypot(tip.x - view.targetX, tip.y - target.y);
        if (dist <= view.targetR) {
          // hit — find ring
          let pts = 20;
          for (const ring of rings) {
            if (dist <= view.targetR * ring.f) { pts = ring.pts; break; }
          }
          arrow.scored = true;
          registerHit(pts, view.targetX, target.y - view.targetR - 8);
          stuck.push({ x: tip.x, y: tip.y, ang: arrow.ang, dx: tip.x - view.targetX, dy: tip.y - target.y });
          arrow = null;
          settle();
        } else if (tip.y >= view.groundY) {
          arrow.scored = true;
          registerHit(0, tip.x, view.groundY - 30);
          stuck.push({ x: tip.x, y: view.groundY, ang: arrow.ang, ground: true });
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

    // popups
    for (const p of popups) { p.y -= 0.8; p.life -= 0.018; }
    popups = popups.filter(p => p.life > 0);
  }

  let settleTimer = null;
  function settle() {
    // small pause so the player sees the result, then advance
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

    // sun
    ctx.fillStyle = "rgba(255,231,168,0.55)";
    ctx.beginPath();
    ctx.arc(W * 0.78, H * 0.13, 34, 0, Math.PI * 2);
    ctx.fill();

    // distant hills
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
    const x = view.targetX, y = target.y, R = view.targetR;
    // stand
    ctx.strokeStyle = "#7a5230";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x - R * 0.5, y + R * 0.4);
    ctx.lineTo(x - R * 0.5, view.groundY);
    ctx.moveTo(x + R * 0.5, y + R * 0.4);
    ctx.lineTo(x + R * 0.5, view.groundY);
    ctx.stroke();

    // rings outer->inner
    for (let i = rings.length - 1; i >= 0; i--) {
      ctx.beginPath();
      ctx.arc(x, y, R * rings[i].f, 0, Math.PI * 2);
      ctx.fillStyle = rings[i].color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.stroke();
    }
    // center dot
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, R * 0.05), 0, Math.PI * 2);
    ctx.fillStyle = "#1d2b3a";
    ctx.fill();
  }

  function drawArrowShape(x, y, ang, len) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    // shaft
    ctx.strokeStyle = "#caa46b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    // head
    ctx.fillStyle = "#e9eef3";
    ctx.beginPath();
    ctx.moveTo(len + 8, 0);
    ctx.lineTo(len - 2, -4);
    ctx.lineTo(len - 2, 4);
    ctx.closePath();
    ctx.fill();
    // fletching
    ctx.fillStyle = "#ff6b4a";
    ctx.beginPath();
    ctx.moveTo(-len, 0); ctx.lineTo(-len + 8, -5); ctx.lineTo(-len + 4, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-len, 0); ctx.lineTo(-len + 8, 5); ctx.lineTo(-len + 4, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawBow() {
    const a = view.anchor;
    // archer post
    ctx.strokeStyle = "#3a2a18";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x, view.groundY);
    ctx.stroke();

    // aim direction for bow orientation
    let dirAng = -0.5; // default pointing up-right
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
    // bow limb
    ctx.strokeStyle = "#6b4a25";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, 0, bowR, -Math.PI / 2.4, Math.PI / 2.4);
    ctx.stroke();
    // string (pulled back by `pull`)
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
    // nocked arrow while aiming
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
      vy += G(); vx *= DRAG; vy *= DRAG;
      x += vx; y += vy;
      if (y > view.groundY || x > W || x < 0) break;
      if (i % 3 === 0) {
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // power meter
    const pad = 16;
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

    // stuck arrows
    for (const s of stuck) {
      const len = 12;
      drawArrowShape(s.x - Math.cos(s.ang) * len, s.y - Math.sin(s.ang) * len, s.ang, len);
    }

    drawTrajectory();
    drawBow();

    if (arrow) drawArrowShape(arrow.x, arrow.y, arrow.ang, 12);

    drawPopups();

    if (flash > 0) {
      ctx.fillStyle = "rgba(255,236,150," + (flash * 0.25) + ")";
      ctx.fillRect(0, 0, W, H);
    }
  }

  function loop() {
    if (state !== "menu") update();
    render();
    requestAnimationFrame(loop);
  }

  // ---- Wire up ----
  canvas.addEventListener("pointerdown", onDown, { passive: false });
  canvas.addEventListener("pointermove", onMove, { passive: false });
  canvas.addEventListener("pointerup", onUp, { passive: false });
  canvas.addEventListener("pointercancel", onUp, { passive: false });
  // touch fallbacks
  canvas.addEventListener("touchstart", onDown, { passive: false });
  canvas.addEventListener("touchmove", onMove, { passive: false });
  canvas.addEventListener("touchend", onUp, { passive: false });

  el.startBtn.addEventListener("click", () => { audio(); startGame(); });
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 200));

  resize();
  loop();

  // ---- Test hook for automated verification ----
  window.__archery = {
    get state() { return state; },
    get score() { return score; },
    get round() { return round; },
    start: startGame,
    // fire an arrow at angleDeg (0=right, negative=up) with power 0..1
    shoot(angleDeg, power) {
      if (state === "menu" || state === "over") startGame();
      state = "aiming";
      const rad = angleDeg * Math.PI / 180;
      const speed = MIN_SPEED() + (MAX_SPEED() - MIN_SPEED()) * power;
      arrow = {
        x: view.anchor.x, y: view.anchor.y,
        vx: Math.cos(rad) * speed, vy: Math.sin(rad) * speed,
        ang: rad, scored: false,
      };
      arrowsLeft = Math.max(0, arrowsLeft - 1);
      setHud();
      state = "flying";
    },
    // aim the target dead-on and guarantee bullseye geometry test
    snapTargetStationary() { target.speed = 0; },
    layout: () => ({ ...view, targetY: target.y }),
    // pure physics simulation (no state change) -> {hit, dist, pts}
    simulate(angleDeg, power) {
      const rad = angleDeg * Math.PI / 180;
      const speed = MIN_SPEED() + (MAX_SPEED() - MIN_SPEED()) * power;
      let x = view.anchor.x, y = view.anchor.y;
      let vx = Math.cos(rad) * speed, vy = Math.sin(rad) * speed;
      for (let i = 0; i < 1200; i++) {
        vy += G(); vx *= DRAG; vy *= DRAG;
        x += vx; y += vy;
        const ang = Math.atan2(vy, vx);
        const tx = x + Math.cos(ang) * 14, ty = y + Math.sin(ang) * 14;
        const dist = Math.hypot(tx - view.targetX, ty - target.y);
        if (dist <= view.targetR) {
          let pts = 20;
          for (const ring of rings) { if (dist <= view.targetR * ring.f) { pts = ring.pts; break; } }
          return { hit: true, dist, pts };
        }
        if (ty >= view.groundY || tx > W + 40 || tx < -40 || ty > H + 60) break;
      }
      return { hit: false };
    },
    // find a hitting shot, fire it for real, return the chosen shot
    autoHit() {
      this.snapTargetStationary();
      let best = null;
      for (let a = -70; a <= 5; a += 0.5) {
        for (let p = 0.4; p <= 1.0; p += 0.05) {
          const r = this.simulate(a, p);
          if (r.hit && (!best || r.dist < best.dist)) best = { a, p, ...r };
        }
      }
      if (best) this.shoot(best.a, best.p);
      return best;
    },
  };
})();
