// A site's logo tile: a letter mark at once, replaced by the site's own file (under logos/) if it loads. Nothing is
// requested from the site itself or from an icon service, so a visit is never revealed to a third party.
const hueOf = (s) => { let h = 7; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0; return 150 + (h % 140); }; // green to violet

export function makeLogo(site) {
  const el = document.createElement('span');
  el.className = 'orb-logo';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--h', hueOf(site.domain));
  el.textContent = (site.domain.replace(/^www\./, '')[0] || '?').toUpperCase();
  if (site.logo && /^logos\/[\w-][\w.-]*$/.test(site.logo)) {
    const img = new Image(16, 16);
    img.alt = ''; img.decoding = 'async';
    img.onload = () => { if (img.naturalWidth > 1) el.classList.add('has-img'); else img.remove(); };
    img.onerror = () => img.remove();
    img.src = site.logo;
    el.append(img);
  }
  return el;
}
