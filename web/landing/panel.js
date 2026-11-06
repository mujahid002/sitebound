// The detail panel: a small non-modal card docked at the bottom of the screen. It explains one real site (what it does
// today and what changes with Sitebound), or the "Try it" example. It never blocks the page: the orbit keeps moving,
// the search box stays usable. Closes with Esc, the close button, a click outside it, or scrolling the hero away.
// Focus goes into the card on open and comes back to whatever opened it.
import { WITH_SITEBOUND } from './sites.js';
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

  function siteBody(site, WITH) {
    const who = el('div', 'panel-who');
    const name = el('div', 'panel-name');
    const title = el('h2', 'panel-title', site.domain);
    title.id = 'panel-title';
    name.append(title);
    name.append(el('p', 'panel-what', [site.what, 'Not a Sitebound customer'].filter(Boolean).join(' \u00b7 ')));
    who.append(makeLogo(site), name);
    const bar = el('div', 'panel-bar');
    bar.append(who, closeBtn());

    const cols = el('div', 'panel-cols');
    const now = el('section', 'panel-col');
    now.append(el('h3', null, `Today: how ${site.domain} takes crypto`), el('p', null, site.today || 'Not checked yet.'));
    const url = safeUrl(site.proof);
    if (url) {
      const a = el('a', 'panel-link', 'See the proof');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      now.append(a);
    }
    const then = el('section', 'panel-col is-with');
    const ul = el('ul');
    for (const line of WITH) ul.append(el('li', null, line));
    then.append(el('h3', null, 'With Sitebound on Whitechain'), ul);
    cols.append(now, then);

    return [bar, cols];
  }

  function tryBody(t) {
    const bar = el('div', 'panel-bar');
    const name = el('div', 'panel-name');
    name.append(el('p', 'panel-what', t.eyebrow));
    const title = el('h2', 'panel-title', t.title);
    title.id = 'panel-title';
    name.append(title);
    bar.append(name, closeBtn());
    const p = el('p', 'panel-lede', t.text);
    const cta = el('a', 'btn panel-cta', t.cta);
    cta.href = t.href; cta.target = '_blank'; cta.rel = 'noopener noreferrer';
    return [bar, p, cta];
  }

  function show(kind, data, from) {
    if (isOpen() && current === data) return hide();
    root.replaceChildren(...(kind === 'site' ? siteBody(data, WITH_SITEBOUND) : tryBody(data)));
    root.classList.toggle('is-site', kind === 'site');
    root.scrollTop = 0;
    if (opener && opener !== from) opener.setAttribute('aria-expanded', 'false');
    opener = from || null;
    current = data;
    opener?.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    onToggle(true, kind === 'site' ? data : null);
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
    openSite: (site, from) => show('site', site, from),
    openTry: (t, from) => show('try', t, from),
    close: (o) => hide(o),
    isOpen,
  };
}
