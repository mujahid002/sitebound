// Website chips orbiting the search bar on elliptical rings. A chip in the back half of its ring, or over the hero's
// text and form, goes behind them: smaller, dimmer, blurred. Hover or focus pauses the orbit and lights the chip, and
// a click calls onPick(origin). Reduced motion: the chips stay where they are. No network: the "favicon" is a
// monogram dot, so no request goes to the sites on the ring.
const TAU = Math.PI * 2;
// Per ring: extra width beyond the bar's half width (px), share of the free height, seconds per turn, direction.
const RINGS = [
  { x: 70, y: 0.52, period: 70, dir: 1 },
  { x: 165, y: 0.76, period: 96, dir: -1 },
  { x: 265, y: 1, period: 130, dir: 1 },
];
const NARROW = 560; // below this width: two rings and at most 6 chips

// Monogram hue from the name, kept in green to violet so no demo site looks like the red fake.
const hueOf = (s) => { let h = 7; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0; return 150 + (h % 140); };

export function mountOrbit(host, { sites = [], onPick = () => {}, around, keepClear = [] }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'orbit-rings');
  svg.setAttribute('aria-hidden', 'true');
  host.append(svg);

  let chips = []; // { origin, el, face, ring, offset, target, hw, hh, back, on }
  let rings = [], W = 0, H = 0, cx = 0, cy = 0, clear = [], narrow = false;
  const angle = RINGS.map((_, i) => i * 1.3);
  let speed = reduce ? 0 : 1, hovered = null, lit = null;
  let raf = 0, last = 0, visible = true;

  const running = () => !reduce && visible && !document.hidden;
  const kick = () => { if (!raf && running()) raf = requestAnimationFrame(frame); };
  const poke = () => { if (running()) kick(); else draw(0); };

  function layout() {
    const hr = host.getBoundingClientRect();
    const a = around.getBoundingClientRect();
    W = hr.width; H = hr.height;
    cx = a.left - hr.left + a.width / 2;
    cy = a.top - hr.top + a.height / 2;
    narrow = W < NARROW;
    const free = Math.max(60, Math.min(cy - 76, H - cy - 24)); // 76: clear of the top bar
    rings = (narrow ? [RINGS[1], RINGS[2]] : RINGS).map((r, i) => ({
      ...r,
      rx: Math.min(a.width / 2 + (narrow ? 0 : r.x), W / 2 - 16),
      ry: free * (narrow ? [0.8, 1][i] : r.y),
    }));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = rings.map((r) => `<ellipse cx="${cx}" cy="${cy}" rx="${r.rx}" ry="${r.ry}"/>`).join('');
    clear = keepClear.map((el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - hr.left - 8, t: r.top - hr.top - 6, r: r.right - hr.left + 8, b: r.bottom - hr.top + 6 };
    }).filter((r) => r.r > r.l);
    assign(true);
    draw(0);
  }

  // Ring and slot per chip. A chip keeps its ring; new chips join the emptiest ring, and the rest glide to new slots.
  function assign(reset) {
    const n = rings.length;
    const shown = chips.slice(0, narrow ? 6 : 15);
    for (const c of chips) c.el.hidden = !shown.includes(c);
    if (!n) return; // not laid out yet: layout() assigns everything
    const per = rings.map(() => []);
    for (const c of shown) if (!reset && c.ring != null && c.ring < n) per[c.ring].push(c);
    for (const c of shown) {
      if (!reset && c.ring != null && c.ring < n) continue;
      const r = per.reduce((best, l, i) => (l.length < per[best].length ? i : best), 0);
      c.ring = r; per[r].push(c);
      if (reset) c.offset = null;
    }
    per.forEach((list, r) => list.forEach((c, k) => {
      c.target = (k / list.length) * TAU + r * 0.9;
      if (c.offset == null) c.offset = c.target;
      if (!c.hw) { c.hw = c.el.offsetWidth / 2; c.hh = c.el.offsetHeight / 2; }
    }));
  }

  function draw(dt) {
    const want = hovered || lit || reduce ? 0 : 1;
    speed += (want - speed) * (dt ? 1 - Math.exp(-dt * (want ? 3 : 9)) : 1); // stops fast, starts gently
    if (speed < 0.002 && !want) speed = 0;
    rings.forEach((r, i) => { angle[i] += r.dir * (TAU / r.period) * dt * speed; });
    const glide = dt ? 1 - Math.exp(-dt * 4) : 1;
    for (const c of chips) {
      if (c.el.hidden || !rings[c.ring]) continue;
      let d = c.target - c.offset;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      c.offset += d * glide;
      const r = rings[c.ring], th = angle[c.ring] + c.offset;
      // Clamped so a chip never leaves the screen: near the sides its path flattens instead.
      const x = Math.min(W - c.hw - 6, Math.max(c.hw + 6, cx + r.rx * Math.cos(th))), y = cy + r.ry * Math.sin(th);
      const depth = (Math.sin(th) + 1) / 2; // 0 at the top (far), 1 at the bottom (near)
      const on = c === hovered || c.origin === lit;
      const l = x - c.hw, rt = x + c.hw, t = y - c.hh, b = y + c.hh;
      const back = !on && (depth < 0.22 || clear.some((q) => l < q.r && rt > q.l && t < q.b && b > q.t));
      const s = on ? 1.06 : 0.82 + 0.18 * depth;
      const o = on ? 1 : (0.45 + 0.55 * depth) * (back ? 0.55 : 1);
      c.el.style.transform = `translate3d(${l.toFixed(1)}px, ${t.toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
      c.el.style.opacity = o.toFixed(3);
      if (back !== c.back) { c.back = back; c.el.classList.toggle('is-back', back); }
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
    el.dataset.kind = site.kind || 'demo';
    el.setAttribute('aria-label', `Check ${site.label} on Sitebound`);
    const face = document.createElement('span');
    face.className = 'orb-face';
    const dot = document.createElement('span');
    dot.className = 'orb-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = (site.label.replace(/^www\./, '')[0] || '?').toUpperCase();
    dot.style.setProperty('--h', hueOf(site.label));
    face.append(dot, document.createTextNode(site.label));
    el.append(face);
    const c = { origin: site.origin, el, face };
    el.addEventListener('click', () => onPick(site.origin));
    el.addEventListener('pointerenter', () => { hovered = c; poke(); });
    el.addEventListener('pointerleave', () => { if (hovered === c) { hovered = null; poke(); } });
    el.addEventListener('focus', () => { hovered = c; poke(); });
    el.addEventListener('blur', () => { if (hovered === c) { hovered = null; poke(); } });
    face.addEventListener('animationend', () => face.classList.remove('is-new'));
    return c;
  }

  function setSites(list, pop = true) {
    const seen = new Set();
    const next = [];
    for (const s of list) {
      if (!s?.origin || seen.has(s.origin)) continue;
      seen.add(s.origin);
      let c = chips.find((x) => x.origin === s.origin);
      if (!c) {
        c = make(s);
        if (pop && !reduce) c.face.classList.add('is-new');
      }
      next.push(c);
    }
    for (const c of chips) if (!seen.has(c.origin)) c.el.remove();
    chips = next;
    for (const c of chips) host.append(c.el); // DOM order is list order, so Tab follows the list
    assign(false);
    poke();
  }

  const ro = new ResizeObserver(() => layout());
  const io = new IntersectionObserver((e) => { visible = e[e.length - 1].isIntersecting; kick(); });
  const onVis = () => { last = 0; kick(); };
  document.addEventListener('visibilitychange', onVis);

  setSites(sites, false);
  ro.observe(host);
  io.observe(host);
  document.fonts?.ready.then(() => { for (const c of chips) c.hw = 0; layout(); });

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
