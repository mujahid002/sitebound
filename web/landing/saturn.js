// Saturn hero for the landing page: a ringed planet drawn on one 2D canvas, with site chips orbiting it.
// The planet, rings and stars are rendered pixel by pixel once per size into offscreen layers; each frame only
// composites those layers (with a little pointer parallax), moves ring particles and positions the chips.
//
//   const s = mountSaturn(host, { sites: [{ origin, label, kind }], onPick: (origin) => {} });
//   s.setSites(list); s.highlight(origin | null); s.destroy();
//
// kind: 'live' (the real demo shop), 'fake' (the fake-site demo), 'demo' (.example names), 'user' (typed here).

const TAU = Math.PI * 2;
const INC = (72 * Math.PI) / 180; // ring inclination: 90 would be edge-on
const ROLL = (-18 * Math.PI) / 180; // ring roll on screen: right side up
const CI = Math.cos(INC), SI = Math.sin(INC);
const CR = Math.cos(ROLL), SR = Math.sin(ROLL);
const RING_IN = 1.12, RING_OUT = 2.34; // in planet radii
const TRACKS = [1.8, 2.66]; // chip orbits: on the B ring, and just outside the rings
const TRACK_NARROW = 2.28; // narrow hosts: one orbit, on the A ring, so dots stay inside the box
const PERIOD = [68, 90]; // seconds per revolution; the inner track is faster
// Parallax shift in CSS px at full pointer travel. Planet and both ring halves share one shift: separate shifts
// open a seam where the back and front ring layers meet.
const OFF = { stars: 3, body: 10 };
// Narrow hosts show the first 4 sites, on one orbit.
const NARROW = 480, NARROW_MAX = 4;
const ACCENT = '#3fd69a';
const DOT = { live: ACCENT, fake: '#ff6b5e', demo: '#8b93a1', user: '#f4f5f2' };
const PCOL = ['rgba(255,247,230,0.55)', 'rgba(255,247,230,0.28)', 'rgba(170,255,220,0.32)'];

// Light from the upper left and toward the viewer, given on screen, then turned into the unrolled frame.
const L = (() => {
  const n = Math.hypot(-0.52, -0.4, 0.75);
  const x = -0.52 / n, y = -0.4 / n, z = 0.75 / n;
  return [x * CR + y * SR, -x * SR + y * CR, z];
})();
const N0 = [0, -SI, CI]; // ring-plane normal (north), unrolled frame

const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const band = (r, a, b, w) => sm(a - w, a + w, r) * (1 - sm(b - w, b + w, r));

// Optical depth of the rings at radius r (planet radii); w softens edges by about one pixel.
function ringDensity(r, w) {
  const striae = 0.8 + 0.2 * (0.5 + 0.5 * Math.sin(r * 181.3) * Math.sin(r * 57.1 + 1.7));
  const d =
    0.07 * band(r, 1.12, 1.24, w) + // D
    (0.19 + 0.07 * Math.sin(r * 41)) * band(r, 1.24, 1.53, w) + // C
    (0.7 + 0.22 * sm(1.58, 1.76, r) - 0.12 * sm(1.86, 1.95, r)) * band(r, 1.53, 1.95, w) + // B
    0.045 * band(r, 1.95, 2.03, w) + // Cassini division
    0.55 * band(r, 2.03, 2.27, w) * (1 - 0.85 * band(r, 2.208, 2.222, w)) + // A, with the Encke gap
    0.34 * band(r, 2.314, 2.326, w); // F
  return d * striae;
}

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STYLE = `
:where(.orbit-canvas){position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
:where(.orbit-label){position:absolute;left:0;top:0;z-index:2;display:inline-flex;align-items:center;gap:7px;height:32px;margin:0;
padding:0 13px 0 10px;border:1px solid rgba(255,255,255,.13);border-radius:999px;background:rgba(12,14,17,.74);
box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 8px 22px rgba(0,0,0,.38);color:rgba(232,235,231,.86);
font:500 12.5px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em;white-space:nowrap;
cursor:pointer;opacity:0;transform-origin:50% 50%;will-change:transform,opacity;-webkit-tap-highlight-color:transparent;
transition:border-color .2s,background-color .2s,color .2s,box-shadow .2s}
:where(.orbit-label .orbit-dot){width:6px;height:6px;flex:none;border-radius:50%;background:${DOT.demo}}
:where(.orbit-label[data-kind=live] .orbit-dot){background:${DOT.live};box-shadow:0 0 8px rgba(63,214,154,.75)}
:where(.orbit-label[data-kind=fake] .orbit-dot){background:${DOT.fake};box-shadow:0 0 8px rgba(255,107,94,.6)}
:where(.orbit-label[data-kind=user]){color:#fff}
:where(.orbit-label[data-kind=user] .orbit-dot){background:${DOT.user}}
:where(.orbit-label.is-hot){border-color:rgba(63,214,154,.62);background:rgba(13,25,20,.9);color:#fff;
box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 0 0 4px rgba(63,214,154,.12),0 12px 28px rgba(0,0,0,.5)}
:where(.orbit-label:focus-visible){outline:2px solid ${ACCENT};outline-offset:2px}
:where(.orbit-label[hidden]){display:none}
@media (pointer:coarse){:where(.orbit-label){height:36px;font-size:13px;padding:0 14px 0 11px}}
`;

function injectStyle() {
  if (document.getElementById('orbit-style')) return;
  const s = document.createElement('style');
  s.id = 'orbit-style';
  s.textContent = STYLE;
  document.head.append(s);
}

export function mountSaturn(host, { sites = [], onPick = () => {} } = {}) {
  injectStyle();
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.className = 'orbit-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  const ctx = canvas.getContext('2d');

  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mqFine = matchMedia('(pointer: fine)');
  let reduce = mqReduce.matches;

  let W = 0, H = 0, dpr = 1, R = 0, cx = 0, cy = 0; // CSS px
  let layers = null;
  let chips = [];
  let hoverC = null, focusC = null, progOrigin = null, hotC = null;
  const rot = [0.9, 0];
  let px = 0, py = 0, tx = 0, ty = 0; // eased and target pointer, -1..1
  let visible = true, raf = 0, last = 0, dead = false;
  let pn = 0, pr, pa, pw, ps; // ring particles

  // ------------------------------------------------------------ offscreen layers (once per size)

  function layer(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    return { c, g, img: g.createImageData(w, h) };
  }

  function renderStars() {
    const w = canvas.width, h = canvas.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const ccx = cx * dpr, ccy = cy * dpr, k = R * dpr;
    // Faint glow behind the planet: a cool accent haze and a warm offset, very low alpha.
    // Elliptical, and fully faded before the host's edges, so the box never shows against the page.
    g.save();
    g.translate(ccx, ccy);
    g.scale(W / H, 1);
    let grad = g.createRadialGradient(0, 0, k * 0.5, 0, 0, (H / 2) * dpr);
    grad.addColorStop(0, 'rgba(63,214,154,0.06)');
    grad.addColorStop(0.55, 'rgba(63,214,154,0.025)');
    grad.addColorStop(1, 'rgba(63,214,154,0)');
    g.fillStyle = grad;
    g.fillRect(-w, -h, w * 2, h * 2);
    grad = g.createRadialGradient(-k * 0.5, -k * 0.7, 0, -k * 0.5, -k * 0.7, (H / 2.4) * dpr);
    grad.addColorStop(0, 'rgba(255,214,170,0.04)');
    grad.addColorStop(1, 'rgba(255,214,170,0)');
    g.fillStyle = grad;
    g.fillRect(-w, -h, w * 2, h * 2);
    g.restore();
    const rand = rng(7);
    const n = Math.round((W * H) / 5200);
    for (let i = 0; i < n; i++) {
      const x = rand() * w, y = rand() * h, big = rand() < 0.06;
      const a = big ? 0.5 + rand() * 0.35 : 0.1 + rand() * 0.38;
      g.fillStyle = rand() < 0.15 ? `rgba(190,255,228,${a})` : `rgba(255,250,240,${a})`;
      g.beginPath();
      g.arc(x, y, (big ? 0.9 + rand() * 0.5 : 0.35 + rand() * 0.5) * dpr, 0, TAU);
      g.fill();
    }
    return { c, x: 0, y: 0 };
  }

  function renderPlanet() {
    const k = R * dpr, half = Math.ceil(1.1 * k) + 1, size = half * 2;
    const { c, g, img } = layer(size, size);
    const d = img.data;
    const ccx = cx * dpr, ccy = cy * dpr;
    const x0 = Math.round(ccx) - half, y0 = Math.round(ccy) - half;
    const l2 = Math.hypot(L[0], L[1]), lx = L[0] / l2, ly = L[1] / l2;
    const denom = L[1] * N0[1] + L[2] * N0[2];
    for (let j = 0; j < size; j++) {
      const Ys = (y0 + j + 0.5 - ccy) / k;
      for (let i = 0; i < size; i++) {
        const Xs = (x0 + i + 0.5 - ccx) / k;
        const x = Xs * CR + Ys * SR, y = -Xs * SR + Ys * CR;
        const r2 = x * x + y * y;
        if (r2 > 1.21) continue;
        const dist = Math.sqrt(r2);
        const away = sm(-0.35, 0.85, dist > 1e-6 ? -(x * lx + y * ly) / dist : 0);
        let cr = 0, cg = 0, cb = 0, ca = 0;
        if (r2 < 1) {
          const z = Math.sqrt(1 - r2);
          const s = y * N0[1] + z * N0[2]; // sine of latitude
          let b = 0.5 + 0.27 * Math.sin(s * 9.5 + 0.4) + 0.15 * Math.sin(s * 23 + 1.1) + 0.07 * Math.sin(s * 61 + 0.3);
          b = Math.min(1, Math.max(0, b));
          let r0 = 148 + 74 * b, g0 = 131 + 77 * b, b0 = 110 + 72 * b;
          const polar = sm(0.72, 0.97, Math.abs(s)) * 0.55;
          r0 += (126 - r0) * polar; g0 += (133 - g0) * polar; b0 += (138 - b0) * polar;
          const ndl = x * L[0] + y * L[1] + z * L[2];
          let shade = 0.028 + 0.972 * (0.3 * sm(-0.15, 0.5, ndl) + 0.7 * Math.max(0, ndl));
          shade *= 0.6 + 0.4 * Math.sqrt(z); // limb darkening
          if (denom > 1e-6) { // the rings' shadow on the planet
            const t = -s / denom;
            if (t > 0) {
              const qx = x + t * L[0], qy = y + t * L[1], qz = z + t * L[2];
              const rq = Math.sqrt(qx * qx + qy * qy + qz * qz);
              if (rq > RING_IN && rq < RING_OUT) shade *= 1 - 0.78 * Math.min(1, ringDensity(rq, 0.006) / 0.9);
            }
          }
          const rim = (1 - z) * (1 - z) * (1 - z) * away * 0.5;
          cr = r0 * shade + 63 * rim; cg = g0 * shade + 214 * rim; cb = b0 * shade + 154 * rim;
          ca = Math.min(1, (1 - dist) * k + 0.5);
        }
        let ga = 0; // thin accent atmosphere past the limb, stronger on the unlit side
        if (dist > 0.985) ga = Math.pow(Math.max(0, 1 - Math.max(0, dist - 1) / 0.08), 2.6) * (0.03 + 0.17 * away);
        const A = ca + ga * (1 - ca);
        if (A < 0.003) continue;
        const o = (j * size + i) * 4, q = ga * (1 - ca);
        d[o] = (cr * ca + 63 * q) / A;
        d[o + 1] = (cg * ca + 214 * q) / A;
        d[o + 2] = (cb * ca + 154 * q) / A;
        d[o + 3] = A * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return { c, x: x0, y: y0 };
  }

  function renderRings() {
    const k = R * dpr, a = RING_OUT + 0.03, b = a * CI;
    const hw = Math.ceil(Math.sqrt(a * a * CR * CR + b * b * SR * SR) * k) + 1;
    const hh = Math.ceil(Math.sqrt(a * a * SR * SR + b * b * CR * CR) * k) + 1;
    const w = hw * 2, h = hh * 2;
    const back = layer(w, h), front = layer(w, h);
    const ccx = cx * dpr, ccy = cy * dpr;
    const x0 = Math.round(ccx) - hw, y0 = Math.round(ccy) - hh;
    const unit = 1 / k, in2 = (RING_IN - 0.02) ** 2, out2 = (RING_OUT + 0.02) ** 2, fore = 1 / CI - 1;
    for (let j = 0; j < h; j++) {
      const Ys = (y0 + j + 0.5 - ccy) / k;
      for (let i = 0; i < w; i++) {
        const Xs = (x0 + i + 0.5 - ccx) / k;
        const x = Xs * CR + Ys * SR, y = -Xs * SR + Ys * CR;
        const yp = y / CI; // back into the ring plane
        const r2 = x * x + yp * yp;
        if (r2 < in2 || r2 > out2) continue;
        const r = Math.sqrt(r2);
        const dens = ringDensity(r, 0.75 * unit * (1 + fore * Math.abs(yp) / r));
        if (dens < 0.004) continue;
        const t = sm(1.2, 1.9, r), outer = sm(1.99, 2.06, r);
        let lit = 1; // the planet's shadow on the rings
        const z = yp * SI, bb = x * L[0] + y * L[1] + z * L[2];
        if (bb < 0) { const disc = bb * bb - (r2 - 1); if (disc > 0) lit = 1 - 0.88 * sm(0, 0.02, disc); }
        const d = (yp > 0 ? front : back).img.data, o = (j * w + i) * 4;
        d[o] = (138 + 92 * t - 22 * outer) * lit;
        d[o + 1] = (134 + 80 * t - 20 * outer) * lit;
        d[o + 2] = (128 + 56 * t - 16 * outer) * lit;
        d[o + 3] = Math.min(1, dens * 0.95) * 255;
      }
    }
    back.g.putImageData(back.img, 0, 0);
    front.g.putImageData(front.img, 0, 0);
    return [{ c: back.c, x: x0, y: y0 }, { c: front.c, x: x0, y: y0 }];
  }

  function seedParticles() {
    const rand = rng(11);
    pn = W < 560 ? 120 : 240;
    pr = new Float32Array(pn); pa = new Float32Array(pn); pw = new Float32Array(pn); ps = new Float32Array(pn);
    const base = (TAU / 84) * Math.pow(2, 1.5); // one turn in 84 s at r = 2
    for (let i = 0; i < pn; i++) {
      let r;
      do r = 1.25 + rand() * 1.08; while (rand() > ringDensity(r, 0.01) / 0.95);
      pr[i] = r;
      pa[i] = rand() * TAU;
      pw[i] = base * Math.pow(r, -1.5);
      ps[i] = 0.6 + rand() * 1.1;
    }
  }

  function build() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return false;
    W = w; H = h;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    R = W < 560 ? Math.min(W / 4.75, H / 3.3) : Math.min(W / 5.8, H / 3.1);
    cx = W / 2; cy = H / 2;
    layout();
    const [back, front] = renderRings();
    layers = { stars: renderStars(), back, planet: renderPlanet(), front };
    seedParticles();
    return true;
  }

  // ------------------------------------------------------------ chips

  function makeChip(s) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'orbit-label';
    const dot = document.createElement('span');
    dot.className = 'orbit-dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    el.append(dot, text);
    const c = { origin: s.origin, el, text, track: 0, slot: 0, cur: 0, fade: 0, hw: 0, hh: 0,
      dx: 0, dy: 0, dz: 0, bx: 0, by: 0, s: 1, occ: false, z: -1, op: -1, pe: true, hot: false, kind: '', label: '' };
    el.addEventListener('click', () => onPick(c.origin));
    el.addEventListener('pointerenter', () => { hoverC = c; sync(); });
    el.addEventListener('pointerleave', () => { if (hoverC === c) hoverC = null; sync(); });
    el.addEventListener('focus', () => { focusC = c; sync(); });
    el.addEventListener('blur', () => { if (focusC === c) focusC = null; sync(); });
    return c;
  }

  function setSites(list) {
    const old = new Map(chips.map((c) => [c.origin, c]));
    const next = [];
    for (const s of list || []) {
      if (!s || !s.origin || next.some((c) => c.origin === s.origin)) continue;
      let c = old.get(s.origin);
      if (c) old.delete(s.origin);
      else { c = makeChip(s); c.isNew = true; }
      if (c.label !== s.label) { c.label = s.label || s.origin; c.text.textContent = c.label; c.el.setAttribute('aria-label', `Check ${c.label}`); }
      if (c.kind !== s.kind) { c.kind = s.kind in DOT ? s.kind : 'demo'; c.el.dataset.kind = c.kind; }
      next.push(c);
    }
    for (const c of old.values()) c.el.remove();
    chips = next;
    for (const c of chips) host.append(c.el); // DOM order = list order, for Tab
    layout();
    measure();
    sync();
  }

  // Tracks and evenly spaced slots. Wide: alternate between two orbits. Narrow: one orbit, first NARROW_MAX only.
  function layout() {
    const narrow = W > 0 && W < NARROW;
    const n = [0, 0], k = [0, 0];
    chips.forEach((c, i) => {
      c.el.hidden = narrow && i >= NARROW_MAX;
      c.track = narrow ? 1 : i % 2 ? 0 : 1;
      if (!c.el.hidden) n[c.track]++;
    });
    for (const c of chips) {
      if (c.el.hidden) continue;
      const t = c.track;
      c.slot = (k[t]++ / n[t]) * TAU + (t ? 0 : Math.PI / Math.max(1, n[t]));
      if (c.isNew || reduce || c.fade === 0) { c.cur = c.slot; c.isNew = false; }
      if (reduce) c.fade = 1;
    }
  }

  function measure() {
    for (const c of chips) { c.hw = c.el.offsetWidth / 2; c.hh = c.el.offsetHeight / 2; }
  }

  function sync() {
    if (hoverC && !chips.includes(hoverC)) hoverC = null;
    if (focusC && !chips.includes(focusC)) focusC = null;
    hotC = hoverC || focusC || (progOrigin && chips.find((c) => c.origin === progOrigin)) || null;
    kick();
  }

  // ------------------------------------------------------------ per frame

  function step(dt) {
    if (!hotC) {
      rot[0] += (dt * TAU) / PERIOD[0];
      rot[1] += (dt * TAU) / PERIOD[1];
    }
    const e = Math.min(1, dt * 3);
    for (const c of chips) {
      let dd = (c.slot - c.cur) % TAU;
      if (dd > Math.PI) dd -= TAU; else if (dd < -Math.PI) dd += TAU;
      c.cur += dd * e;
      if (c.fade < 1) c.fade = Math.min(1, c.fade + dt * 2.2);
    }
    for (let i = 0; i < pn; i++) pa[i] += pw[i] * dt;
    const f = Math.min(1, dt * 3.5);
    px += (tx - px) * f;
    py += (ty - py) * f;
  }

  function placeChips() {
    for (const c of chips) {
      const a = rot[c.track] + c.cur, rr = W < NARROW ? TRACK_NARROW : TRACKS[c.track];
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = rr * ca, y = rr * sa * CI;
      const X = (x * CR - y * SR) * R, Y = (x * SR + y * CR) * R;
      const t = (sa + 1) / 2;
      c.dz = sa;
      c.dx = cx + X - OFF.body * px;
      c.dy = cy + Y - OFF.body * py;
      c.occ = sa < 0 && X * X + Y * Y < R * R * 1.04;
      c.s = c === hotC ? 1.05 : 0.86 + 0.14 * t;
      const hw = c.hw * c.s, hh = c.hh * c.s;
      c.bx = Math.min(W - hw - 6, Math.max(hw + 6, c.dx));
      // Narrow hosts: chips on the near half hang below their dot, the rest sit above it.
      const below = W < NARROW && sa > 0.2;
      const cyc = below ? c.dy + (14 + 10 * t) + hh : c.dy - (14 + 12 * t) - hh;
      c.by = Math.min(H - hh - 4, Math.max(hh + 4, cyc));
    }
    // Overlapping chips: the one further back steps vertically clear of the nearer one. Continuous as the
    // overlap grows, so nothing jumps; occluded and hidden chips take no part.
    for (let i = 0; i < chips.length; i++) {
      const a = chips[i];
      if (a.el.hidden || (a.occ && a !== hotC)) continue;
      for (let j = i + 1; j < chips.length; j++) {
        const b = chips[j];
        if (b.el.hidden || (b.occ && b !== hotC)) continue;
        const needY = a.hh * a.s + b.hh * b.s + 4;
        if (a.hw * a.s + b.hw * b.s + 4 <= Math.abs(a.bx - b.bx) || needY <= Math.abs(a.by - b.by)) continue;
        const back = a === hotC ? b : b === hotC ? a : a.dz < b.dz ? a : b;
        const front = back === a ? b : a;
        const up = back.by <= front.by;
        const lo = back.hh * back.s + 4, hi = H - back.hh * back.s - 4;
        let y = up ? front.by - needY : front.by + needY;
        if (y < lo || y > hi) y = up ? front.by + needY : front.by - needY;
        back.by = Math.min(hi, Math.max(lo, y));
      }
    }
  }

  function blit(l, off) {
    ctx.drawImage(l.c, l.x - off * px * dpr, l.y - off * py * dpr);
  }

  function drawParticles(front, off) {
    const k = R * dpr, ox = (cx - off * px) * dpr, oy = (cy - off * py) * dpr;
    for (let bkt = 0; bkt < 3; bkt++) {
      ctx.fillStyle = PCOL[bkt];
      for (let i = bkt; i < pn; i += 3) {
        const a = pa[i], r = pr[i], sa = Math.sin(a);
        if (sa >= 0 !== front) continue;
        const x = r * Math.cos(a), yp = r * sa, y = yp * CI, z = yp * SI;
        const bb = x * L[0] + y * L[1] + z * L[2];
        if (bb < 0 && bb * bb > r * r - 1) continue; // in the planet's shadow
        const s = ps[i] * dpr;
        ctx.fillRect((x * CR - y * SR) * k + ox - s / 2, (x * SR + y * CR) * k + oy - s / 2, s, s);
      }
    }
  }

  function drawDots(front) {
    ctx.lineWidth = dpr;
    for (const c of chips) {
      if (c.dz >= 0 !== front || c.fade <= 0 || c.el.hidden) continue;
      const hot = c === hotC;
      if (c.occ && !hot) continue;
      const fx = c.dx * dpr, fy = c.dy * dpr;
      ctx.globalAlpha = c.fade * (hot ? 0.85 : hotC ? 0.1 : 0.2 + 0.12 * c.dz);
      ctx.strokeStyle = hot ? ACCENT : '#ffffff';
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(c.bx * dpr, (c.by > c.dy ? c.by - c.hh * c.s : c.by + c.hh * c.s) * dpr);
      ctx.stroke();
      ctx.fillStyle = DOT[c.kind];
      ctx.globalAlpha = c.fade * (hot ? 0.35 : 0.16);
      ctx.beginPath(); ctx.arc(fx, fy, 6 * dpr, 0, TAU); ctx.fill();
      ctx.globalAlpha = c.fade * (hot ? 1 : hotC ? 0.5 : 0.85);
      ctx.beginPath(); ctx.arc(fx, fy, 2.2 * dpr, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function applyChips() {
    for (const c of chips) {
      const hot = c === hotC;
      let o = hot ? 1 : c.occ ? 0.12 : 0.55 + 0.45 * ((c.dz + 1) / 2);
      if (hotC && !hot) o *= 0.5;
      o *= c.fade;
      c.el.style.transform = `translate3d(${(c.bx - c.hw).toFixed(1)}px,${(c.by - c.hh).toFixed(1)}px,0) scale(${c.s.toFixed(3)})`;
      if (Math.abs(o - c.op) > 0.004) { c.el.style.opacity = o.toFixed(3); c.op = o; }
      const z = hot ? 5 : c.dz >= 0 ? 4 : 3;
      if (z !== c.z) { c.el.style.zIndex = z; c.z = z; }
      const pe = hot || (!c.occ && o > 0.2);
      if (pe !== c.pe) { c.el.style.pointerEvents = pe ? '' : 'none'; c.pe = pe; }
      if (hot !== c.hot) { c.el.classList.toggle('is-hot', hot); c.hot = hot; }
    }
  }

  function draw() {
    if (!layers) return;
    placeChips();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    blit(layers.stars, OFF.stars);
    blit(layers.back, OFF.body);
    drawParticles(false, OFF.body);
    drawDots(false);
    blit(layers.planet, OFF.body);
    blit(layers.front, OFF.body);
    drawParticles(true, OFF.body);
    drawDots(true);
    applyChips();
  }

  const running = () => !dead && !reduce && visible && !document.hidden;

  function frame(now) {
    raf = 0;
    if (dead) return;
    if (running()) {
      step(last ? Math.min(0.05, (now - last) / 1000) : 0);
      last = now;
      draw();
      raf = requestAnimationFrame(frame);
    } else {
      last = 0;
      draw(); // one still frame: reduced motion, or a state change while paused
    }
  }
  function kick() {
    if (!raf && !dead) raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ wiring

  const onPointer = (e) => {
    if (reduce || !mqFine.matches) return;
    tx = Math.max(-1, Math.min(1, (e.clientX / innerWidth) * 2 - 1));
    ty = Math.max(-1, Math.min(1, (e.clientY / innerHeight) * 2 - 1));
  };
  const onLeave = () => { tx = 0; ty = 0; };
  const onVis = () => kick();
  const onReduce = () => {
    reduce = mqReduce.matches;
    if (reduce) { px = py = tx = ty = 0; for (const c of chips) { c.cur = c.slot; c.fade = 1; } }
    kick();
  };
  addEventListener('pointermove', onPointer, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  document.addEventListener('visibilitychange', onVis);
  mqReduce.addEventListener('change', onReduce);

  const ro = new ResizeObserver(() => {
    if (host.clientWidth === W && host.clientHeight === H) return;
    if (build()) { measure(); kick(); }
  });
  ro.observe(host);
  const io = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    kick();
  });
  io.observe(host);
  document.fonts?.ready.then(() => { if (!dead) { measure(); kick(); } });

  setSites(sites);
  if (build()) kick();

  return {
    setSites,
    highlight(origin) { progOrigin = origin || null; sync(); },
    destroy() {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      mqReduce.removeEventListener('change', onReduce);
      for (const c of chips) c.el.remove();
      canvas.remove();
      chips = [];
    },
  };
}
