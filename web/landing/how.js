// How it works: one clock drives the whole picture (the rail, the nodes, the rows, the typing, the caption and the three steps).
// The markup in index.html is already the finished state. This file adds .is-js, then sets each state from the time `t`.
// Reduced motion: it only shows the finished picture (and lets the three steps open each stage), no loop and no Play button.
// With motion it loops, but only while the picture is on screen and the tab is visible, and the visitor can pause it.
const root = document.getElementById('hw');
if (root) {
  const q = (s, r = root) => [...r.querySelectorAll(s)];
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');

  // The three stages, in ms. Times inside the markup (data-t, data-d) are relative to the start of the pane's stage.
  const START = [0, 6200, 11600];
  const LEN = [6200, 5400, 8200];
  const END = START[2] + LEN[2];

  // Which node is the current one, and when. A node stays lit once it has been reached.
  const NODE_AT = [[0, 0], [2600, 1], [4800, 2], [6200, 0], [11600 + 400, 3], [11600 + 3300, 2], [11600 + 5500, 4]];

  // The one-line caption above the picture.
  const CAPS = [
    [0, 'Wallet created in your browser'], [600, 'Add one DNS TXT record'], [2600, 'Relayer checks the record'], [4800, 'Site registered on Whitechain'],
    [6200, 'Paste one tag on your page'], [6200 + 3700, 'No address anywhere in it'],
    [11600, 'Buyer clicks pay'], [11600 + 500, 'Frame shows the site and amount'], [11600 + 1200, 'Touch ID signs this payment'],
    [11600 + 2400, 'Contract checks the signature'], [11600 + 3300, 'Pays only the registered wallet'],
    [11600 + 4300, 'USDT goes straight to that wallet'], [11600 + 5600, 'Paid. No gas for the buyer'],
  ];

  // A packet on the rail: x is a fraction of the rail (site 0, DNS .25, registry .5, buyer .75, wallet 1).
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const leg = (t, a, b) => ease(Math.min(1, Math.max(0, (t - a) / (b - a))));
  const SIG = START[2] + 2400, SIG_END = START[2] + 3300;
  const PAY = START[2] + 4300, PAY_END = START[2] + 5500;

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Colours for the tag as it types: tag names, attribute names, values. Raw text in, safe html out.
  const paint = (s) => {
    let out = '', i = 0;
    for (const m of s.matchAll(/(<\/?[\w-]*)|\b(amount|order)\b|("[^"]*"?)/g)) {
      out += esc(s.slice(i, m.index));
      out += `<span class="${m[1] ? 'c-t' : m[2] ? 'c-a' : 'c-s'}">${esc(m[0])}</span>`;
      i = m.index + m[0].length;
    }
    return out + esc(s.slice(i));
  };

  root.classList.add('is-js');
  const stageOf = (el) => Number(el.closest('.hw-pane').dataset.p);
  const rows = q('[data-t]').filter((el) => !el.classList.contains('ty')).map((el) => ({
    el, on: START[stageOf(el)] + Number(el.dataset.t), done: el.dataset.d == null ? null : START[stageOf(el)] + Number(el.dataset.d),
    end: el.dataset.e == null ? null : START[stageOf(el)] + Number(el.dataset.e),
  }));
  const typed = q('.ty').map((el) => {
    const full = el.dataset.full, code = !!el.closest('.hw-code');
    el.innerHTML = '<span class="ty-v"></span><span class="ty-g"></span>';
    return { el, v: el.firstChild, g: el.lastChild, full, code, at: START[stageOf(el)] + Number(el.dataset.t), n: -1 };
  });
  // The waiting label for the Touch ID button, which only shows while the picture is playing.
  const go = root.querySelector('.hw-go');
  if (go) go.insertAdjacentHTML('beforeend', '<span class="hw-go-m">Waiting for Touch ID…</span><span class="hw-go-c">Touch ID confirmed</span>');

  const nodes = q('.hw-node');
  const segs = q('.hw-seg');
  const pks = q('.hw-pk');
  const steps = q('.hw-step');
  const panes = q('.hw-pane');
  const capEl = root.querySelector('.hw-cap-t');
  const playBtn = root.querySelector('.hw-play');
  let capNow = -1;

  const render = (t) => {
    const stage = t >= START[2] ? 2 : t >= START[1] ? 1 : 0;

    steps.forEach((b, i) => {
      b.classList.toggle('is-cur', i === stage);
      if (i === stage) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.style.setProperty('--p', i < stage ? 1 : i > stage ? 0 : Math.min(1, (t - START[i]) / LEN[i]).toFixed(3));
    });
    panes.forEach((p, i) => p.classList.toggle('is-cur', i === stage));

    // nodes
    const lit = new Set();
    let act = 0;
    for (const [at, n] of NODE_AT) if (t >= at) { lit.add(n); act = n; }
    nodes.forEach((el, i) => { el.classList.toggle('is-lit', lit.has(i)); el.classList.toggle('is-act', i === act); });

    // rail: the packets and the lines they leave behind
    const a = leg(t, 1500, 2600) * 0.25 + leg(t, 3600, 4800) * 0.25;
    const sg = leg(t, SIG, SIG_END), pay = leg(t, PAY, PAY_END);
    segs[0].style.setProperty('--k', (a / 0.5).toFixed(3));
    segs[1].style.setProperty('--k', sg.toFixed(3));
    segs[2].style.setProperty('--k', pay.toFixed(3));
    const on = (x, y) => (t >= x && t <= y ? 1 : 0);
    pks[0].style.setProperty('--x', a.toFixed(3));
    pks[0].style.setProperty('--o', on(1500, 4800));
    pks[1].style.setProperty('--x', (0.75 - 0.25 * sg).toFixed(3));
    pks[1].style.setProperty('--o', on(SIG, SIG_END));
    pks[2].style.setProperty('--x', (0.75 + 0.25 * pay).toFixed(3));
    pks[2].style.setProperty('--o', on(PAY, PAY_END));

    // rows
    for (const r of rows) {
      r.el.classList.toggle('is-on', t >= r.on);
      if (r.done != null) r.el.classList.toggle('is-done', t >= r.done);
      if (r.end != null) r.el.classList.toggle('is-end', t >= r.end);
    }
    // typing
    for (const y of typed) {
      const n = Math.max(0, Math.min(y.full.length, Math.floor((t - y.at) / 38)));
      y.el.classList.toggle('is-typing', t >= y.at && n < y.full.length);
      if (n === y.n) continue;
      y.n = n;
      const head = y.full.slice(0, n);
      if (y.code) y.v.innerHTML = paint(head); else y.v.textContent = head;
      y.g.textContent = y.full.slice(n);
    }
    // caption
    let c = 0;
    CAPS.forEach(([at], i) => { if (t >= at) c = i; });
    if (c !== capNow) {
      capNow = c;
      capEl.textContent = CAPS[c][1];
      capEl.classList.remove('is-new'); void capEl.offsetWidth; capEl.classList.add('is-new');
    }
  };

  // The clock
  let t = 0, last = 0, raf = 0, playing = true, seen = false;
  const running = () => playing && seen && !document.hidden && !reducedMq.matches;
  const frame = (now) => {
    raf = 0;
    if (!running()) { last = 0; return; }
    if (last) t += Math.min(now - last, 100);
    last = now;
    if (t >= END) t = 0;
    render(t);
    raf = requestAnimationFrame(frame);
  };
  const sync = () => {
    const run = running();
    root.classList.toggle('is-running', run);
    root.classList.toggle('is-paused', !playing);
    root.classList.toggle('is-static', reducedMq.matches);
    playBtn.setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
    if (run && !raf) { last = 0; raf = requestAnimationFrame(frame); }
  };
  const still = () => reducedMq.matches || !playing;

  // Open a stage: its start while playing, its finished picture when nothing is moving.
  const open = (i) => {
    t = still() ? (i === 2 ? END : START[i] + LEN[i] - 1) : START[i];
    last = 0;
    render(t);
  };
  steps.forEach((b, i) => b.addEventListener('click', () => open(i)));
  playBtn.addEventListener('click', () => {
    playing = !playing;
    if (playing && t >= END - 1) t = 0;
    sync();
  });

  new IntersectionObserver((entries) => { seen = entries.at(-1).isIntersecting; sync(); }, { threshold: 0.3 }).observe(root);
  document.addEventListener('visibilitychange', sync);
  reducedMq.addEventListener('change', () => { t = reducedMq.matches ? END : 0; render(t); sync(); });

  t = reducedMq.matches ? END : 0;
  render(t);
  sync();
}
