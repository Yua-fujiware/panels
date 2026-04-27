'use strict';
/* ═══════════════════════════════════════════════════════════════
   PANELS — particles.js  v4.5
   Themes: sakura/neko → petals  |  glossy → rain  |  moonsedge → sparkles
   Exposes window._particleApply(n) for performance system
   ═══════════════════════════════════════════════════════════════ */

(function () {
  let canvas, ctx, W, H, raf, particles = [];
  let currentTheme = null;
  let targetCount  = null; // null = use theme default

  const THEME_COUNTS = { sakura: 38, neko: 28, glossy: 80, moonsedge: 60 };

  /* ── bootstrap ─────────────────────────────────────────────── */
  function init() {
    canvas = document.createElement('canvas');
    canvas.id = 'particle-canvas';
    document.body.insertBefore(canvas, document.body.firstChild);
    ctx = canvas.getContext('2d', { alpha: true });

    resize();
    window.addEventListener('resize', resize, { passive: true });

    const observer = new MutationObserver(() => switchTheme());
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme']
    });

    switchTheme();
    loop();
  }

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function getCount() {
    if (targetCount !== null) return Math.round(targetCount);
    return THEME_COUNTS[currentTheme] ?? 40;
  }

  function switchTheme() {
    const t = document.documentElement.dataset.theme || 'sakura';
    if (t === currentTheme) return;
    currentTheme = t;
    particles = [];
    const n = getCount();
    if (t === 'sakura' || t === 'neko') spawnPetals(n);
    if (t === 'glossy')                 spawnRain(n);
    if (t === 'moonsedge')              spawnSparkles(n);
  }

  /* Exposed to performance system */
  window._particleApply = function (n) {
    targetCount = n;
    const diff = n - particles.length;
    if (diff > 0) {
      // Spawn more
      for (let i = 0; i < diff; i++) {
        if (currentTheme === 'sakura' || currentTheme === 'neko') particles.push(makePetal(true));
        else if (currentTheme === 'glossy')    particles.push(makeRainDrop(true));
        else if (currentTheme === 'moonsedge') particles.push(makeSparkle(true));
      }
    } else if (diff < 0) {
      particles.splice(0, -diff);
    }
  };

  /* ── SAKURA / NEKO PETALS ──────────────────────────────────── */
  function spawnPetals(n) {
    for (let i = 0; i < n; i++) particles.push(makePetal(true));
  }

  function makePetal(randomY = false) {
    const isNeko = currentTheme === 'neko';
    return {
      type:    'petal',
      x:       rand(0, W),
      y:       randomY ? rand(-100, H) : rand(-150, -10),
      size:    rand(isNeko ? 4 : 5, isNeko ? 9 : 11),
      speedY:  rand(0.45, 1.20),
      speedX:  rand(-0.35, 0.35),
      angle:   rand(0, Math.PI * 2),
      spin:    rand(-0.020, 0.020),
      wave:    rand(0, Math.PI * 2),
      waveAmp: rand(16, 38),
      waveSpd: rand(0.005, 0.014),
      hue:     isNeko ? rand(300, 340) : rand(320, 355),
      sat:     rand(55, 85),
      lum:     isNeko ? rand(72, 88) : rand(78, 92),
      alpha:   rand(0.35, 0.72),
    };
  }

  function drawPetal(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    const s = p.size;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.bezierCurveTo( s * 0.9, -s * 0.5,  s * 0.9,  s * 0.5, 0,  s);
    ctx.bezierCurveTo(-s * 0.9,  s * 0.5, -s * 0.9, -s * 0.5, 0, -s);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
    grad.addColorStop(0, `hsla(${p.hue},${p.sat}%,${p.lum}%,${p.alpha})`);
    grad.addColorStop(1, `hsla(${p.hue},${p.sat}%,${p.lum - 12}%,${p.alpha * 0.25})`);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  function updatePetal(p) {
    p.wave  += p.waveSpd;
    p.x     += p.speedX + Math.sin(p.wave) * 0.48;
    p.y     += p.speedY;
    p.angle += p.spin;
    if (p.y > H + 20)  Object.assign(p, makePetal(false));
    if (p.x < -30)     p.x = W + 20;
    if (p.x > W + 30)  p.x = -20;
  }

  /* ── GLOSSY RAIN ───────────────────────────────────────────── */
  function spawnRain(n) {
    for (let i = 0; i < n; i++) particles.push(makeRainDrop(true));
  }

  function makeRainDrop(randomY = false) {
    const speed = rand(12, 26);
    return {
      type:  'rain', x: rand(0, W),
      y:     randomY ? rand(-H, 0) : rand(-200, -10),
      len:   rand(12, 36), speed,
      slant: speed * rand(0.06, 0.14),
      alpha: rand(0.08, 0.24),
      width: rand(0.5, 1.1),
      hue:   rand(195, 225),
    };
  }

  function drawRain(p) {
    ctx.save();
    ctx.strokeStyle = `hsla(${p.hue},80%,72%,${p.alpha})`;
    ctx.lineWidth = p.width; ctx.lineCap = 'round';
    const dx = p.slant * (p.len / p.speed);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + dx, p.y + p.len);
    ctx.stroke(); ctx.restore();
  }

  const splashes = [];
  function makeSplash(x, y) {
    const count = Math.floor(rand(2, 4));
    for (let i = 0; i < count; i++)
      splashes.push({ x, y, r: 0, maxR: rand(4, 10), alpha: rand(0.15, 0.35), speed: rand(1.0, 2.0) });
  }

  function updateRain(p) {
    p.x += p.slant; p.y += p.speed;
    if (p.y - p.len > H) {
      if (Math.random() < 0.12) makeSplash(p.x, H - 2);
      Object.assign(p, makeRainDrop(false));
    }
    if (p.x > W + 20) p.x = -20;
  }

  function drawSplashes() {
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i]; s.r += s.speed; s.alpha -= 0.022;
      if (s.alpha <= 0) { splashes.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(120,200,255,${s.alpha})`; ctx.lineWidth = 0.6; ctx.stroke();
    }
  }

  /* ── MOONSEDGE SPARKLES ─────────────────────────────────────── */
  function spawnSparkles(n) {
    for (let i = 0; i < n; i++) particles.push(makeSparkle(true));
  }

  function makeSparkle(randomY = false) {
    return {
      type: 'sparkle', x: rand(0, W),
      y:    randomY ? rand(0, H) : rand(-20, H + 20),
      size: rand(0.9, 2.8), speedX: rand(-0.10, 0.10), speedY: rand(-0.12, 0.06),
      alpha: rand(0.10, 0.50), pulseSpd: rand(0.010, 0.028),
      pulseOff: rand(0, Math.PI * 2), pulseAmp: rand(0.10, 0.28),
      hue: rand(260, 310), sat: rand(60, 90), lum: rand(80, 96),
      star: Math.random() < 0.38,
      drift: rand(0, Math.PI * 2), driftSpd: rand(0.003, 0.008),
    };
  }

  function drawSparkle(p, t) {
    const pulse = p.alpha + Math.sin(t * p.pulseSpd + p.pulseOff) * p.pulseAmp;
    const a = Math.max(0, Math.min(1, pulse));
    if (a < 0.01) return;
    ctx.save(); ctx.translate(p.x, p.y); ctx.globalAlpha = a;
    if (p.star) {
      const s = p.size;
      ctx.rotate(Math.PI / 4 * (t * 0.0003));
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 3);
      grd.addColorStop(0,   `hsla(${p.hue},${p.sat}%,${p.lum}%,0.5)`);
      grd.addColorStop(0.5, `hsla(${p.hue},${p.sat}%,${p.lum}%,0.10)`);
      grd.addColorStop(1,   'transparent');
      ctx.beginPath(); ctx.arc(0, 0, s * 3, 0, Math.PI * 2);
      ctx.fillStyle = grd; ctx.fill();
      ctx.fillStyle = `hsl(${p.hue},${p.sat}%,${p.lum}%)`;
      ctx.beginPath(); ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2); ctx.fill();
      for (let arm = 0; arm < 4; arm++) {
        ctx.save(); ctx.rotate(arm * Math.PI / 2);
        ctx.fillRect(-s * 0.10, 0, s * 0.20, s * 1.5); ctx.restore();
      }
    } else {
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size * 2);
      grd.addColorStop(0, `hsla(${p.hue},${p.sat}%,${p.lum}%,0.9)`);
      grd.addColorStop(0.5, `hsla(${p.hue},${p.sat}%,${p.lum}%,0.28)`);
      grd.addColorStop(1, 'transparent');
      ctx.beginPath(); ctx.arc(0, 0, p.size * 2, 0, Math.PI * 2);
      ctx.fillStyle = grd; ctx.fill();
    }
    ctx.restore();
  }

  function updateSparkle(p) {
    p.drift += p.driftSpd;
    p.x += p.speedX + Math.cos(p.drift) * 0.035;
    p.y += p.speedY; p.pulseOff += p.pulseSpd;
    if (p.y < -20) p.y = H + 10; if (p.y > H + 20) p.y = -10;
    if (p.x < -10) p.x = W + 5;  if (p.x > W + 10) p.x = -5;
  }

  /* ── MAIN LOOP ─────────────────────────────────────────────── */
  let t = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    t++;
    ctx.clearRect(0, 0, W, H);
    const theme = currentTheme;
    const n = getCount();

    if (theme === 'sakura' || theme === 'neko') {
      for (const p of particles) { updatePetal(p); drawPetal(p); }
      if (t % 100 === 0 && particles.length < n) particles.push(makePetal());
    }
    if (theme === 'glossy') {
      for (const p of particles) { updateRain(p); drawRain(p); }
      drawSplashes();
      if (t % 180 === 0 && particles.length < n) {
        for (let i = 0; i < 6; i++) particles.push(makeRainDrop());
      }
    }
    if (theme === 'moonsedge') {
      for (const p of particles) { updateSparkle(p); drawSparkle(p, t); }
      if (t % 150 === 0 && particles.length < n) particles.push(makeSparkle());
    }
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
