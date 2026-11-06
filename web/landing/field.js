// The hero's background: a dot lattice that lights up under the pointer. The lattice itself is CSS (the canvas's own
// background, one dot per `gap` cell); the canvas draws only the light: a soft green spotlight that follows the
// pointer with easing, the dots within `radius` brightening, and a ripple on each tap for touch. The canvas fills
// the hero and nothing else: once the hero is scrolled out of view the loop stops, the canvas is cleared and
// pointer events are ignored, so nothing follows the cursor further down the page. Draws only while something
// moves. Reduced motion: the static lattice only.
const TAU = Math.PI * 2;

export function mountField(canvas, { gap = 28, radius = 200 } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const ctx = canvas.getContext('2d');
  let tone = '63, 214, 154'; // the accent's rgb, read from --spot so the light follows the theme
  const readTone = () => { tone = getComputedStyle(canvas).getPropertyValue('--spot').trim() || tone; };
  readTone();
  const themeWatch = new MutationObserver(() => { readTone(); kick(); });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let W = 0, H = 0, raf = 0, last = 0, glow = 0, glowAim = 0, visible = true;
  const pos = { x: 0, y: 0 }, aim = { x: 0, y: 0 }; // aim: where the pointer is, in the viewport; pos: the eased light, in canvas px
  const ripples = [];

  const kick = () => { if (!raf && visible) raf = requestAnimationFrame(frame); };

  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    kick();
  }

  // Lattice dots near (x, y), each drawn at the brightness f(distance) returns (0..1).
  function dots(x, y, R, f) {
    const i0 = Math.max(0, Math.floor((x - R) / gap)), i1 = Math.floor((x + R) / gap);
    const j0 = Math.max(0, Math.floor((y - R) / gap)), j1 = Math.floor((y + R) / gap);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const px = (i + 0.5) * gap, py = (j + 0.5) * gap;
        const b = f(Math.hypot(px - x, py - y));
        if (b < 0.02) continue;
        ctx.globalAlpha = Math.min(1, b);
        ctx.beginPath();
        ctx.arc(px, py, 1 + 1.1 * b, 0, TAU);
        ctx.fill();
      }
    }
  }

  function frame(t) {
    raf = 0;
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 1 / 60;
    last = t;
    const k = 1 - Math.exp(-dt * 9);
    const box = canvas.getBoundingClientRect(), ax = aim.x - box.left, ay = aim.y - box.top;
    pos.x += (ax - pos.x) * k;
    pos.y += (ay - pos.y) * k;
    glow += (glowAim - glow) * (1 - Math.exp(-dt * 5));
    ctx.clearRect(0, 0, W, H);
    if (glow > 0.005) {
      const R = radius * 1.7;
      const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, R);
      g.addColorStop(0, `rgba(${tone}, ${0.085 * glow})`);
      g.addColorStop(1, `rgba(${tone}, 0)`);
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(pos.x - R, pos.y - R, 2 * R, 2 * R);
      ctx.fillStyle = `rgb(${tone})`;
      dots(pos.x, pos.y, radius, (d) => {
        const u = 1 - d / radius;
        return u > 0 ? u * u * (3 - 2 * u) * glow * 0.8 : 0;
      });
    }
    ctx.fillStyle = `rgb(${tone})`;
    for (let n = ripples.length - 1; n >= 0; n--) {
      const r = ripples[n];
      r.t += dt / 0.9;
      if (r.t >= 1) { ripples.splice(n, 1); continue; }
      const rad = (1 - (1 - r.t) ** 3) * radius * 1.4, band = 30, fade = 1 - r.t;
      dots(r.x, r.y, rad + band, (d) => {
        const u = 1 - Math.abs(d - rad) / band;
        return u > 0 ? u * fade * 0.9 : 0;
      });
    }
    ctx.globalAlpha = 1;
    const busy = Math.abs(ax - pos.x) + Math.abs(ay - pos.y) > 0.3 || Math.abs(glowAim - glow) > 0.004 || ripples.length;
    if (busy) kick();
    else last = 0;
  }

  // Only a pointer inside the hero counts: below it, or once the hero has scrolled away, the light fades out.
  const inside = (e) => { const r = canvas.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  const onMove = (e) => {
    if (e.pointerType !== 'mouse' || !visible) return;
    if (!inside(e)) { glowAim = 0; kick(); return; }
    aim.x = e.clientX; aim.y = e.clientY;
    if (glow < 0.02) { const r = canvas.getBoundingClientRect(); pos.x = aim.x - r.left; pos.y = aim.y - r.top; }
    glowAim = 1;
    kick();
  };
  const onOut = (e) => { if (!e.relatedTarget) { glowAim = 0; kick(); } };
  // A ripple only for a tap: lifted within 300 ms and 10 px of where it went down, so scrolling stays quiet.
  let down = null;
  const onDown = (e) => { down = !visible || !inside(e) || e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY, t: e.timeStamp }; };
  const onUp = (e) => {
    if (!down || e.timeStamp - down.t > 300 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) return;
    const r = canvas.getBoundingClientRect();
    ripples.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: 0 });
    down = null;
    kick();
  };
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerdown', onDown, { passive: true });
  addEventListener('pointerup', onUp, { passive: true });
  document.addEventListener('mouseout', onOut);
  const ro = new ResizeObserver(size);
  ro.observe(canvas);
  // Off screen: stop the loop, wipe the light and forget the pointer. Back on screen: wait for the next move.
  const io = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) return;
    cancelAnimationFrame(raf); raf = 0; last = 0;
    glow = glowAim = 0; ripples.length = 0;
    ctx.clearRect(0, 0, W, H);
  });
  io.observe(canvas);
  // Scrolling moves the hero under a still pointer, so the light follows the page.
  const onScroll = () => { if (glowAim) kick(); };
  addEventListener('scroll', onScroll, { passive: true });

  return () => {
    cancelAnimationFrame(raf);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerdown', onDown);
    removeEventListener('pointerup', onUp);
    document.removeEventListener('mouseout', onOut);
    ro.disconnect(); io.disconnect(); themeWatch.disconnect();
    removeEventListener('scroll', onScroll);
  };
}
