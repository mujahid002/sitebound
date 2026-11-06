// Why we are building it, How it works: the swap story, the 3-D Secure-style loop, the tiles, the count-up and the drawn connectors.
// Everything is in index.html and its end state is the default. This file only adds `why-ready` to <html> (which makes
// the CSS hold each scene at its start) and `is-play` to a scene when it is mostly on screen. Each scene plays once.
// Reduced motion or no IntersectionObserver: nothing is added, so the page shows the finished state.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!reduced && 'IntersectionObserver' in window) {
  const root = document.documentElement;
  const scenes = [...document.querySelectorAll('.why-head, .ba-side, .tile, .rf-in, .hf')];

  // Count-up numbers: the real value stays in the markup (and in the sr-only text); this animates the visible copy.
  const fmt = (el, v) => v.toFixed(Number(el.dataset.dec || 0));
  const counters = [...document.querySelectorAll('.pt-v')];   // the three loss figures in the references
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function count(scene) {
    const els = counters.filter((el) => scene.contains(el));
    const t0 = performance.now();
    const frame = (now) => {
      const k = Math.min(1, (now - t0) / 700);
      for (const el of els) el.textContent = fmt(el, Number(el.dataset.to) * ease(k));
      if (k < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  root.classList.add('why-ready');
  for (const el of counters) el.textContent = fmt(el, 0);

  // A scene starts when about half of it is in view (or half the screen, for a scene taller than the screen).
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (e.intersectionRatio < 0.5 && e.intersectionRect.height < innerHeight * 0.45) continue;
      e.target.classList.add('is-play');
      io.unobserve(e.target);
      if (e.target.classList.contains('rf-in')) count(e.target);
    }
  }, { threshold: [0.25, 0.5, 0.75] });
  scenes.forEach((s) => io.observe(s));

  // Replay: the one place a scene runs again, and only when the visitor asks for it.
  const ba = document.querySelector('.ba');
  document.querySelector('[data-replay]')?.addEventListener('click', () => {
    const sides = ba.querySelectorAll('.ba-side');
    sides.forEach((s) => s.classList.remove('is-play'));
    ba.classList.add('is-reset');   // animation: none, so the next frame starts the scene from its beginning
    void ba.offsetWidth;
    ba.classList.remove('is-reset');
    void ba.offsetWidth;
    sides.forEach((s) => s.classList.add('is-play'));
  });

  // Card 02 loops, so it runs only while it is on screen and the tab is visible, and the visitor can pause or replay it.
  const cx = document.getElementById('cx');
  const pause = document.getElementById('cx-pause');
  if (cx) {
    let seen = false;
    const sync = () => cx.classList.toggle('is-live', seen && !document.hidden);
    new IntersectionObserver((entries) => { seen = entries.at(-1).isIntersecting; sync(); }, { threshold: 0.4 }).observe(cx);
    document.addEventListener('visibilitychange', sync);
    const label = () => {
      const still = cx.classList.contains('is-still');
      pause.setAttribute('aria-pressed', String(still));
      pause.setAttribute('aria-label', still ? 'Play animation' : 'Pause animation');
      pause.querySelector('use')?.setAttribute('href', still ? '#wi-play' : '#wi-pause');
    };
    pause?.addEventListener('click', () => { cx.classList.toggle('is-still'); label(); });
    document.querySelector('[data-cx-replay]')?.addEventListener('click', () => {
      cx.classList.add('is-reset');   // animation: none, so the next frame starts the loop from its beginning
      void cx.offsetWidth;
      cx.classList.remove('is-reset', 'is-still');
      label();
    });
  }
}
