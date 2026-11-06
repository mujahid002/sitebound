// Owned by the "proof" designer: animations for the trust band and Try it.
// 1. The proof tiles count up once, when they scroll into view (600 ms, ease-out). The final numbers are already in the
//    HTML, so with reduced motion, no IntersectionObserver or no JS, the page shows the real values.
// 2. The checkout mock in Try it runs its CSS loop only while it is on screen, from its first frame, and has a Pause button.

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canObserve = 'IntersectionObserver' in window;

const DURATION = 600;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function countUp(el) {
  const end = Number(el.dataset.count);
  if (!Number.isFinite(end) || end < 2) return; // 0 and 1 have nothing to count through
  const t0 = performance.now();
  el.textContent = '0';
  const step = (now) => {
    const t = Math.min(1, (now - t0) / DURATION);
    el.textContent = String(Math.round(end * easeOut(t)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

if (!reduced && canObserve) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      // Tiles reveal in a stagger (main.js sets --i); start each count with its tile.
      const delay = Number(getComputedStyle(e.target).getPropertyValue('--i') || 0) * 60;
      const num = e.target.querySelector('[data-count]');
      if (num) setTimeout(() => countUp(num), delay + 120);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const tile of document.querySelectorAll('.v-tile')) io.observe(tile);
}

const mock = document.getElementById('mock');
const pause = document.getElementById('mock-pause');
if (mock && !reduced && canObserve) {
  const live = new IntersectionObserver((entries) => {
    for (const e of entries) mock.classList.toggle('is-live', e.isIntersecting);
  }, { threshold: 0.45 });
  live.observe(mock);
}
if (mock && pause) {
  pause.addEventListener('click', () => {
    const still = mock.classList.toggle('is-still');
    pause.setAttribute('aria-pressed', String(still));
    pause.setAttribute('aria-label', still ? 'Play animation' : 'Pause animation');
    pause.querySelector('use')?.setAttribute('href', still ? '#wi-play' : '#wi-pause');
  });
}
