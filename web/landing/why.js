// Why we are building it, How it works: the swap story, the count-up and the drawn connectors.
// Everything is in index.html and its end state is the default. This file only adds `why-ready` to <html> (which makes
// the CSS hold each scene at its start) and `is-play` to a scene when it is mostly on screen. Each scene plays once.
// Reduced motion or no IntersectionObserver: nothing is added, so the page shows the finished state.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!reduced && 'IntersectionObserver' in window) {
  const root = document.documentElement;
  const scenes = [...document.querySelectorAll('.ba-side, .hf, .pt')];

  // Count-up numbers: the real value stays in the markup (and in the sr-only text); this animates the visible copy.
  const fmt = (el, v) => v.toFixed(Number(el.dataset.dec || 0));
  const counters = [...document.querySelectorAll('.pt-v')];
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
      if (e.target.classList.contains('pt')) count(e.target);
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
}
