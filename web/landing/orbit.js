// Website chips orbiting the search bar. Chips never cross the hero's text or form: a chip fades out as it nears
// any `keepClear` element, so on wide screens the rings read as two arcs in the gutters either side of the text.
// When the gutters are too narrow (about 1280px and below) the chips run in two slow lanes under the hero links
// instead. Hover or focus pauses the motion and lights the chip; a click calls onPick(origin).
// Each chip loads its site's own /favicon.ico (no-referrer); if that fails it keeps a letter mark.
// Reduced motion: nothing moves; chips rest in clear space.
const TAU = Math.PI * 2;
const FADE = 56;      // px over which a chip fades out as it nears text (and the screen edge, in lanes)
const LANE = { speed: [26, 18], dir: [-1, 1], gap: 14 }; // px/s per lane, direction, space between chips

// Letter-mark hue from the name, kept in green to violet.
const hueOf = (s) => { let h = 7; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0; return 150 + (h % 140); };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function mountOrbit(host, { sites = [], onPick = () => {}, around, keepClear = [] }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'orbit-rings');
  svg.setAttribute('aria-hidden', 'true');
  host.append(svg);

  let chips = []; // { origin, el, face, ring, offset, target, hw, hh, on, shown }
  let rings = [], W = 0, H = 0, cx = 0, cy = 0, clear = [], mode = 'ring', laneY = [];
  const angle = [0, 1.3];
  const shift = [0, 0];
  let speed = reduce ? 0 : 1, hovered = null, lit = null;
  let raf = 0, last = 0, visible = true;

  const running = () => !reduce && visible && !document.hidden;
  const kick = () => { if (!raf && running()) raf = requestAnimationFrame(frame); };
  const poke = () => { if (running()) kick(); else draw(0); };

  function measure() {
    for (const c of chips) { c.hw = c.el.offsetWidth / 2; c.hh = c.el.offsetHeight / 2; }
  }

  function layout() {
    const hr = host.getBoundingClientRect();
    const a = around.getBoundingClientRect();
    W = hr.width; H = hr.height;
    cx = a.left - hr.left + a.width / 2;
    cy = a.top - hr.top + a.height / 2;
    clear = keepClear.map((el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - hr.left - 8, t: r.top - hr.top - 6, r: r.right - hr.left + 8, b: r.bottom - hr.top + 6 };
    }).filter((r) => r.r > r.l);
    measure();
    const hwMax = Math.max(40, ...chips.map((c) => c.hw));
    const half = Math.max(a.width / 2, ...clear.map((q) => Math.max(cx - q.l, q.r - cx)));
    const inner = half + hwMax + 28, outer = W / 2 - hwMax - 12;
    mode = outer >= inner ? 'ring' : 'lane';
    host.dataset.mode = mode;
    if (mode === 'ring') {
      const free = Math.max(60, Math.min(cy - 76, H - cy - 24)); // 76: clear of the top bar
      rings = [{ rx: outer, ry: free, period: 120, dir: 1 }];
      if (outer - inner > 70) rings.unshift({ rx: inner + 6, ry: free * 0.72, period: 90, dir: -1 });
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = rings.map((r) => `<ellipse cx="${cx}" cy="${cy}" rx="${r.rx}" ry="${r.ry}"/>`).join('');
    } else {
      rings = [];
      svg.innerHTML = '';
      const below = Math.max(...clear.map((q) => q.b), cy) + 28;
      laneY = [below, below + 52];
      laneOver = Math.max(...chips.map((c) => c.hw));
    }
    assign(true);
    draw(0);
  }

  // Chips are dealt over the rings (or the two lanes), emptiest first. A chip keeps its place when others join.
  function assign(reset) {
    const n = mode === 'ring' ? rings.length : 2;
    if (!n) return;
    const per = Array.from({ length: n }, () => []);
    for (const c of chips) if (!reset && c.ring != null && c.ring < n) per[c.ring].push(c);
    for (const c of chips) {
      if (!reset && c.ring != null && c.ring < n) continue;
      const r = per.reduce((best, l, i) => (l.length < per[best].length ? i : best), 0);
      c.ring = r; per[r].push(c);
      if (reset) c.offset = null;
    }
    per.forEach((list, r) => {
      let at = 0;
      list.forEach((c, k) => {
        if (mode === 'ring') c.target = reduce ? restAngle(r, k, list.length) : (k / list.length) * TAU + r * 0.9;
        else { c.target = at; at += c.hw * 2 + LANE.gap; }
        if (c.offset == null) c.offset = c.target;
      });
      lanes[r] = Math.max(at, W + 2 * Math.max(...list.map((c) => c.hw * 2), 0)); // lane length, so chips can leave and return
    });
  }
  const lanes = [0, 0];
  let laneOver = 0; // widest chip: how far a lane runs off the left edge before it wraps

  // Reduced motion: choose the angles on the ring that sit in clear space, spread evenly.
  function restAngle(r, k, count) {
    const ok = [];
    for (let i = 0; i < 96; i++) { const th = (i / 96) * TAU; if (fadeAt(rings[r], th, 0, 0) > 0.95) ok.push(th); }
    return ok.length ? ok[Math.floor(((k + 0.5) / count) * ok.length)] : 0;
  }

  const gapTo = (l, t, rt, b) => {
    let g = Infinity;
    for (const q of clear) g = Math.min(g, Math.hypot(Math.max(q.l - rt, l - q.r, 0), Math.max(q.t - b, t - q.b, 0)));
    return g;
  };
  // 0 while a chip touches text, 1 once it is FADE px away. hw/hh of 0 only for the angle search above.
  function fadeAt(r, th, hw, hh) {
    const x = cx + r.rx * Math.cos(th), y = cy + r.ry * Math.sin(th);
    const w = hw || 80, h = hh || 14;
    return clamp01(gapTo(x - w, y - h, x + w, y + h) / FADE);
  }

  function draw(dt) {
    const want = hovered || lit || reduce ? 0 : 1;
    speed += (want - speed) * (dt ? 1 - Math.exp(-dt * (want ? 3 : 9)) : 1); // stops fast, starts gently
    if (speed < 0.002 && !want) speed = 0;
    if (mode === 'ring') rings.forEach((r, i) => { angle[i] += r.dir * (TAU / r.period) * dt * speed; });
    else for (let i = 0; i < 2; i++) shift[i] += LANE.dir[i] * LANE.speed[i] * dt * speed;
    const glide = dt ? 1 - Math.exp(-dt * 4) : 1;
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
        f = gapTo(x - c.hw, y - c.hh, x + c.hw, y + c.hh) / FADE;
      } else {
        c.offset += (c.target - c.offset) * glide;
        const span = lanes[c.ring];
        const left = ((((c.offset - shift[c.ring] + 2 * laneOver) % span) + span) % span) - 2 * laneOver + 16;
        x = left + c.hw; y = laneY[c.ring];
        const room = Math.min(left, W - left - 2 * c.hw);
        f = reduce ? (room >= 8 ? 1 : 0) : (room + 8) / FADE; // in motion, fades at the screen edges
      }
      const on = c === hovered || c.origin === lit;
      const o = on ? 1 : clamp01(f) * (0.72 + 0.28 * depth);
      const s = on ? 1.05 : 0.92 + 0.08 * depth;
      c.el.style.transform = `translate3d(${(x - c.hw).toFixed(1)}px, ${(y - c.hh).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
      c.el.style.opacity = o.toFixed(3);
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

  const faviconOf = (s) => s.logo || `${s.origin || 'https://' + s.domain}/favicon.ico`;

  function make(site) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'orb-chip';
    el.dataset.kind = site.kind || 'real';
    el.setAttribute('aria-label', `Check ${site.label || site.domain} on Sitebound`);
    const face = document.createElement('span');
    face.className = 'orb-face';
    const logo = document.createElement('span');
    logo.className = 'orb-logo';
    logo.setAttribute('aria-hidden', 'true');
    logo.style.setProperty('--h', hueOf(site.domain));
    logo.textContent = (site.domain.replace(/^www\./, '')[0] || '?').toUpperCase(); // the letter mark
    const img = new Image(16, 16);
    img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (img.naturalWidth > 1) logo.classList.add('has-img'); else img.remove(); };
    img.onerror = () => img.remove();
    img.src = faviconOf(site);
    logo.append(img);
    const dom = document.createElement('span');
    dom.className = 'orb-dom';
    dom.textContent = site.domain;
    face.append(logo, dom);
    el.append(face);
    const c = { origin: site.origin || `https://${site.domain}`, el, face };
    el.addEventListener('click', () => onPick(c.origin));
    el.addEventListener('pointerenter', () => { hovered = c; poke(); });
    el.addEventListener('pointerleave', () => { if (hovered === c) { hovered = null; poke(); } });
    el.addEventListener('focus', () => { hovered = c; poke(); });
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
          c.face.style.setProperty('--k', next.length); // first paint: chips fade in one after another
        }
      }
      next.push(c);
    }
    for (const c of chips) if (!seen.has(c.origin)) c.el.remove();
    chips = next;
    for (const c of chips) host.append(c.el); // DOM order is list order, so Tab follows the list
    if (W) { measure(); assign(false); }
    poke();
  }

  const ro = new ResizeObserver(() => layout());
  const io = new IntersectionObserver((e) => { visible = e[e.length - 1].isIntersecting; kick(); });
  const onVis = () => { last = 0; kick(); };
  document.addEventListener('visibilitychange', onVis);

  setSites(sites, false);
  ro.observe(host);
  io.observe(host);
  document.fonts?.ready.then(layout);

  return {
    setSites,
    highlight(origin) { lit = origin || null; poke(); },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      for (const c of chips) c.el.remove();
      svg.remove();
      chips = [];
    },
  };
}
