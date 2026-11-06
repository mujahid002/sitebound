// Website chips orbiting the search bar, on up to three rings with their own speeds. Chips never cross the hero's text
// or form: a chip fades out as it nears any `keepClear` element, so on wide screens the rings read as arcs in the
// gutters either side of the text. When the gutters are too narrow (about 1280px and below) the chips run in two or
// three slow lanes under the hero links instead. Where two chips overlap, the one that is further back dims until it
// has passed. Hovering a chip, or keyboard focus on it, holds the motion; clicking one calls onPick(site, button).
// While a panel is open (setSlow) the orbit slows down but keeps going.
// Reduced motion: nothing moves; the chips sit in wrapped rows under the links, so every one is in view and reachable.
import { makeLogo } from './logo.js';

const TAU = Math.PI * 2;
const FADE = 56;        // px over which a chip fades out as it nears text (and the screen edge, in lanes)
const SLOW = 0.35;      // speed factor while a panel is open
const RING_STEP = 64;   // least px between neighbouring rings
const RING_PERIOD = [80, 140]; // seconds per turn, inner to outer
const LANE = [{ speed: 26, dir: -1 }, { speed: 17, dir: 1 }, { speed: 22, dir: -1 }]; // px/s per lane
const LANE_GAP = 14, LANE_PITCH = 48;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function mountOrbit(host, { sites = [], onPick = () => {}, around, keepClear = [] }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hero = host.parentElement;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'orbit-rings');
  svg.setAttribute('aria-hidden', 'true');
  host.append(svg);

  let chips = []; // { origin, site, el, face, ring, offset, target, hw, hh, occ, on, shown, z }
  let rings = [], W = 0, H = 0, cx = 0, cy = 0, clear = [], mode = 'ring', laneY = [], laneN = 2, laneOver = 0, staticRows = 1;
  const angle = [0, 2.1, 4.2];
  const shift = [0, 0, 0];
  const lanes = [0, 0, 0];
  let speed = reduce ? 0 : 1, hovered = null, suppressed = null, lit = null, slow = false;
  let raf = 0, last = 0, visible = true, tabbing = false;

  const running = () => !reduce && visible && !document.hidden;
  const kick = () => { if (!raf && running()) raf = requestAnimationFrame(frame); };
  const poke = () => { if (running()) kick(); else draw(0); };

  function measure() {
    for (const c of chips) { c.hw = c.el.offsetWidth / 2; c.hh = c.el.offsetHeight / 2; }
  }

  function readGeometry() {
    const hr = host.getBoundingClientRect();
    const a = around.getBoundingClientRect();
    W = hr.width; H = hr.height;
    cx = a.left - hr.left + a.width / 2;
    cy = a.top - hr.top + a.height / 2;
    clear = keepClear.map((el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - hr.left - 8, t: r.top - hr.top - 6, r: r.right - hr.left + 8, b: r.bottom - hr.top + 6 };
    }).filter((r) => r.r > r.l);
    return a;
  }

  function layout() {
    const a = readGeometry();
    measure();
    const widths = chips.map((c) => c.hw).sort((x, y) => x - y);
    const hwRef = widths.length ? widths[Math.floor(widths.length / 2)] : 70; // a typical chip; long ones simply fade sooner
    const half = Math.max(a.width / 2, ...clear.map((q) => Math.max(cx - q.l, q.r - cx)));
    const inner = half + hwRef + 28, outer = W / 2 - hwRef - 12;
    mode = !reduce && outer >= inner ? 'ring' : 'lane'; // reduced motion: always the static rows, so every chip stays in view
    host.dataset.mode = mode;
    laneOver = Math.max(40, ...widths);
    let pad = '';
    if (mode === 'lane') {
      laneN = chips.length > 9 ? 3 : 2;
      const rows = reduce ? packRows() : laneN;
      pad = `${28 + (rows - 1) * LANE_PITCH + 36 + 32}px`; // gap under the links, the lanes, and some air
    }
    if (hero.style.paddingBottom !== pad) { hero.style.paddingBottom = pad; readGeometry(); }
    if (mode === 'ring') {
      const free = Math.max(60, Math.min(cy - 76, H - cy - 24)); // 76: clear of the top bar
      const n = Math.min(3, 1 + Math.floor((outer - inner - 6) / RING_STEP));
      rings = Array.from({ length: n }, (_, i) => {
        const t = n > 1 ? i / (n - 1) : 1;
        return {
          rx: n > 1 ? inner + 6 + t * (outer - inner - 6) : outer, ry: free * (n > 1 ? 0.66 + 0.34 * t : 1),
          period: n > 1 ? RING_PERIOD[0] + t * (RING_PERIOD[1] - RING_PERIOD[0]) : 120, dir: i % 2 ? 1 : -1,
        };
      });
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = rings.map((r) => `<ellipse cx="${cx}" cy="${cy}" rx="${r.rx}" ry="${r.ry}"/>`).join('');
    } else {
      rings = [];
      svg.innerHTML = '';
      const below = Math.max(...clear.map((q) => q.b), cy) + 28;
      laneY = Array.from({ length: reduce ? staticRows : laneN }, (_, i) => below + i * LANE_PITCH);
    }
    assign(true);
    draw(0);
  }

  // Chips are dealt over the rings (or the lanes), emptiest first, rings in proportion to their length. A chip keeps
  // its place when others join.
  function assign(reset) {
    const n = mode === 'ring' ? rings.length : laneN;
    if (!n) return;
    const len = (r) => (r ? Math.PI * (3 * (r.rx + r.ry) - Math.sqrt((3 * r.rx + r.ry) * (r.rx + 3 * r.ry))) : 1); // Ramanujan
    const wt = Array.from({ length: n }, (_, i) => (mode === 'ring' ? len(rings[i]) : 1));
    const per = Array.from({ length: n }, () => []);
    for (const c of chips) if (!reset && c.ring != null && c.ring < n) per[c.ring].push(c);
    for (const c of chips) {
      if (!reset && c.ring != null && c.ring < n) continue;
      let best = 0;
      for (let i = 1; i < n; i++) if ((per[i].length + 1) / wt[i] < (per[best].length + 1) / wt[best]) best = i;
      c.ring = best; per[best].push(c);
      if (reset) c.offset = null;
    }
    per.forEach((list, r) => {
      let at = 0;
      list.forEach((c, k) => {
        if (mode === 'ring') c.target = (k / list.length) * TAU + r * 0.9;
        else { c.target = at; at += c.hw * 2 + LANE_GAP; }
        if (c.offset == null) c.offset = c.target;
      });
      lanes[r] = Math.max(at, W + 2 * laneOver); // lane length, so chips can leave and return
    });
  }

  // Reduced motion, lane mode: wrapped rows, centred, so no chip is parked off the screen. Returns the row count.
  function packRows() {
    const room = W - 32;
    const rows = [[]];
    let used = 0;
    for (const c of chips) {
      const w = c.hw * 2;
      if (used && used + LANE_GAP + w > room) { rows.push([]); used = 0; }
      rows.at(-1).push(c); used += (used ? LANE_GAP : 0) + w;
    }
    rows.forEach((row, i) => {
      const total = row.reduce((s, c) => s + c.hw * 2, 0) + LANE_GAP * (row.length - 1);
      let x = (W - total) / 2;
      for (const c of row) { c.rowX = x; c.rowY = i; x += c.hw * 2 + LANE_GAP; }
    });
    staticRows = rows.length;
    return staticRows;
  }

  const gapTo = (l, t, rt, b) => {
    let g = Infinity;
    for (const q of clear) g = Math.min(g, Math.hypot(Math.max(q.l - rt, l - q.r, 0), Math.max(q.t - b, t - q.b, 0)));
    return g;
  };
  
  function draw(dt) {
    const want = reduce || hovered ? 0 : slow ? SLOW : 1;
    speed += (want - speed) * (dt ? 1 - Math.exp(-dt * (want ? 3 : 9)) : 1); // holds fast, restarts gently
    if (Math.abs(speed - want) < 0.002) speed = want;
    if (mode === 'ring') rings.forEach((r, i) => { angle[i] += r.dir * (TAU / r.period) * dt * speed; });
    else for (let i = 0; i < laneN; i++) shift[i] += LANE[i].dir * LANE[i].speed * dt * speed;
    const glide = dt ? 1 - Math.exp(-dt * 4) : 1;
    const place = [];
    for (const c of chips) {
      if (c.ring == null) continue;
      let x, y, depth = 1, f;
      if (mode === 'ring') {
        const r = rings[c.ring];
        if (!r) continue;
        let d = c.target - c.offset;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        c.offset += d * glide;
        const th = angle[c.ring] + c.offset;
        x = cx + r.rx * Math.cos(th); y = cy + r.ry * Math.sin(th);
        depth = (Math.sin(th) + 1) / 2; // 0 at the top (far), 1 at the bottom (near)
        f = Math.min(gapTo(x - c.hw, y - c.hh, x + c.hw, y + c.hh), Math.min(x - c.hw, W - x - c.hw) + 8) / FADE; // text, and the screen edge
      } else if (reduce) {
        x = c.rowX + c.hw; y = laneY[c.rowY]; f = 1;
      } else {
        c.offset += (c.target - c.offset) * glide;
        const span = lanes[c.ring];
        const left = ((((c.offset - shift[c.ring] + 2 * laneOver) % span) + span) % span) - 2 * laneOver + 16;
        x = left + c.hw; y = laneY[c.ring];
        f = Math.min(left, W - left - 2 * c.hw) + 8; // in motion, fades at the screen edges
        f /= FADE;
      }
      c.x = x; c.y = y; c.depth = depth; c.f = clamp01(f);
      place.push(c);
    }
    // Overlap: of two chips that touch, the one further back dims (eased) until they part.
    for (const c of place) c.under = false;
    for (let i = 0; i < place.length; i++) {
      const a = place[i];
      if (a.f < 0.04) continue;
      for (let j = i + 1; j < place.length; j++) {
        const b = place[j];
        if (b.f < 0.04 || Math.abs(a.x - b.x) >= a.hw + b.hw + 4 || Math.abs(a.y - b.y) >= a.hh + b.hh + 4) continue;
        const pa = (a === hovered || a.origin === lit ? 2 : 0) + a.depth, pb = (b === hovered || b.origin === lit ? 2 : 0) + b.depth;
        if (pa >= pb) b.under = true; else a.under = true;
      }
    }
    for (const c of place) {
      c.occ += ((c.under ? 0 : 1) - c.occ) * glide;
      const on = c === hovered || c.origin === lit;
      const o = c.f * (on ? 1 : 0.72 + 0.28 * c.depth) * (0.2 + 0.8 * c.occ);
      const s = on ? 1.05 : 0.92 + 0.08 * c.depth;
      c.el.style.transform = `translate3d(${(c.x - c.hw).toFixed(1)}px, ${(c.y - c.hh).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
      c.el.style.opacity = o.toFixed(3);
      const z = 3 + (on ? 20 : Math.round(c.depth * 10));
      if (z !== c.z) { c.z = z; c.el.style.zIndex = z; }
      const show = o > 0.04; // out of sight: out of the tab order and the pointer's way too
      if (show !== c.shown) { c.shown = show; c.el.style.visibility = show ? '' : 'hidden'; }
      if (on !== c.on) { c.on = on; c.el.classList.toggle('is-lit', on); }
    }
  }

  function frame(t) {
    raf = 0;
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 0;
    last = t;
    draw(dt);
    if (running()) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  function make(site) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'orb-chip';
    el.dataset.kind = site.kind || 'real';
    if (site.kind === 'real') {
      el.setAttribute('aria-haspopup', 'dialog');
      el.setAttribute('aria-expanded', 'false');
      el.setAttribute('aria-label', `${site.domain}: how it takes crypto today`);
    } else {
      el.setAttribute('aria-label', `Set up Sitebound for ${site.domain}`);
    }
    const face = document.createElement('span');
    face.className = 'orb-face';
    const dom = document.createElement('span');
    dom.className = 'orb-dom';
    dom.textContent = site.domain;
    face.append(makeLogo(site), dom);
    el.append(face);
    const c = { origin: site.origin || `https://${site.domain}`, site, el, face, occ: 1 };
    // A click hands over to the panel or the kit, and the orbit goes on: the pointer resting on the chip does not hold it.
    el.addEventListener('click', () => { if (hovered === c) hovered = null; suppressed = c; onPick(site, el); poke(); });
    el.addEventListener('pointerenter', () => { if (suppressed !== c) { hovered = c; poke(); } });
    el.addEventListener('pointerleave', () => { if (suppressed === c) suppressed = null; if (hovered === c) { hovered = null; poke(); } });
    // Keyboard focus holds the chip still, so it cannot slide away or fade out under the focus ring. A mouse press does not.
    el.addEventListener('focus', () => { if (tabbing) { hovered = c; poke(); } });
    el.addEventListener('blur', () => { if (hovered === c) { hovered = null; poke(); } });
    face.addEventListener('animationend', () => face.classList.remove('is-new', 'is-in'));
    return c;
  }

  function setSites(list, pop = true) {
    const seen = new Set();
    const next = [];
    for (const s of list) {
      const origin = s?.origin || (s?.domain && `https://${s.domain}`);
      if (!origin || seen.has(origin)) continue;
      seen.add(origin);
      let c = chips.find((x) => x.origin === origin);
      if (!c) {
        c = make(s);
        if (!reduce) {
          c.face.classList.add(pop ? 'is-new' : 'is-in');
          c.face.style.setProperty('--k', Math.min(next.length, 10)); // first paint: chips fade in one after another
        }
      }
      next.push(c);
    }
    for (const c of chips) if (!seen.has(c.origin)) c.el.remove();
    chips = next;
    for (const c of chips) host.append(c.el); // DOM order is list order, so Tab follows the list
    if (W) { measure(); if (reduce && mode === 'lane') layout(); else assign(false); }
    poke();
  }

  const ro = new ResizeObserver(() => layout());
  const io = new IntersectionObserver((e) => { visible = e[e.length - 1].isIntersecting; kick(); });
  const onVis = () => { last = 0; kick(); };
  document.addEventListener('visibilitychange', onVis);
  // Focus holds a chip only when it arrived by Tab. Focus handed back after a panel closes, or left by a click, does not.
  const onKey = (e) => { tabbing = e.key === 'Tab'; };
  const onPtr = () => { tabbing = false; };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPtr, true);

  setSites(sites, false);
  ro.observe(host);
  io.observe(host);
  document.fonts?.ready.then(layout);

  return {
    setSites,
    highlight(origin) { lit = origin || null; poke(); },  // style only: a lit chip still fades near text and still moves
    setSlow(on) { slow = !!on; poke(); },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPtr, true);
      for (const c of chips) c.el.remove();
      svg.remove();
      chips = [];
    },
  };
}
