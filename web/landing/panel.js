// The detail panel: a small non-modal card docked at the bottom of the screen. It explains one real site (how it takes
// crypto today and what changes with Sitebound). It never blocks the page: the orbit keeps moving,
// the search box stays usable. Closes with Esc, the close button, a click outside it, or scrolling the hero away.
// Focus goes into the card on open and comes back to whatever opened it.
import { WITH_SITEBOUND, CHECKED } from './sites.js';
import { makeLogo } from './logo.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; } };

export function mountPanel(root, { hero, onToggle = () => {} }) {
  let opener = null, current = null;
  const isOpen = () => root.classList.contains('is-open');

  function closeBtn() {
    const b = el('button', 'panel-x');
    b.type = 'button';
    b.setAttribute('aria-label', 'Close');
    b.innerHTML = CLOSE;
    b.addEventListener('click', () => hide());
    return b;
  }

  // The template from the copy: {site}, then "Today" (with its source) beside "With Sitebound on Whitechain".
  function body(site) {
    const who = el('div', 'panel-who');
    const title = el('h2', 'panel-title', site.domain);
    title.id = 'panel-title';
    who.append(makeLogo(site), title);
    const bar = el('div', 'panel-bar');
    bar.append(who, closeBtn());

    const now = el('section', 'panel-col');
    const text = el('p', null, `${site.today} `);
    const url = safeUrl(site.proof);
    if (url) {
      const a = el('a', 'panel-link', 'Source');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      text.append(a);
    }
    now.append(el('h3', null, `Today: how ${site.domain} takes crypto`), text, el('p', 'panel-note', CHECKED));

    const then = el('section', 'panel-col');
    const ul = el('ul');
    for (const line of WITH_SITEBOUND(site.domain)) ul.append(el('li', null, line));
    then.append(el('h3', null, 'With Sitebound on Whitechain'), ul);

    const cols = el('div', 'panel-cols');
    cols.append(now, then);
    return [bar, cols];
  }

  function show(site, from) {
    if (isOpen() && current === site) return hide();
    root.replaceChildren(...body(site));
    root.scrollTop = 0;
    if (opener && opener !== from) opener.setAttribute('aria-expanded', 'false');
    opener = from || null;
    current = site;
    opener?.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    onToggle(true, site);
    root.focus({ preventScroll: true });
  }

  function hide({ restore = true } = {}) {
    if (!isOpen()) return;
    const had = root.contains(document.activeElement);
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    opener?.setAttribute('aria-expanded', 'false');
    // Give focus back to the opener, unless it has faded out of the orbit (hidden) or was a mouse click elsewhere.
    if (restore && had && opener?.isConnected && getComputedStyle(opener).visibility !== 'hidden') opener.focus({ preventScroll: true });
    else if (restore && had) document.getElementById('site')?.focus({ preventScroll: true });
    opener = null; current = null;
    onToggle(false, null);
  }

  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); hide(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) hide(); });
  // Outside click closes. A press on an orbit chip is left to the chip's own click, which swaps or toggles the panel.
  document.addEventListener('pointerdown', (e) => {
    if (!isOpen() || root.contains(e.target) || e.target.closest('[aria-haspopup="dialog"], .orb-chip')) return;
    hide({ restore: false });
  });
  // The panel belongs to the hero: once the hero has mostly scrolled away, so does the panel.
  let tick = 0;
  addEventListener('scroll', () => {
    if (!isOpen() || tick) return;
    tick = requestAnimationFrame(() => { tick = 0; if (hero.getBoundingClientRect().bottom < innerHeight * 0.3) hide({ restore: false }); });
  }, { passive: true });

  return {
    openSite: (site, from) => show(site, from),
    close: (o) => hide(o),
    isOpen,
  };
}
