// Small shared components for the onboarding and dashboard pages.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { copyText, short, addrUrl, txUrl } from './lib.js';

export const html = htm.bind(h);

export function Brand() {
  return html`<a class="brand-link" href="../landing/index.html" aria-label="Sitebound home">
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="26" height="26" rx="8" fill="none" stroke="currentColor" stroke-width="3"/>
      <circle class="mark-dot" cx="16" cy="16" r="5"/>
    </svg>
    <span>Sitebound</span>
  </a>`;
}

export function Icon({ name }) {
  const paths = {
    check: html`<path d="M5 12.5l4.5 4.5L19 7.5" />`,
    globe: html`<circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="3.8" ry="9" /><path d="M3 12h18" />`,
    copy: html`<rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />`,
    out: html`<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" />`,
    warn: html`<path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" />`,
    info: html`<circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />`,
  };
  return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

export const Spinner = () => html`<span class="spin" aria-hidden="true"></span>`;

// kind: info | warn | error | ok. Errors are announced at once, the rest politely.
export function Notice({ kind = 'info', title, children, ...rest }) {
  return html`<div class=${'notice ' + kind} role=${kind === 'error' ? 'alert' : 'status'} ...${rest}>
    <${Icon} name=${kind === 'info' || kind === 'ok' ? 'info' : 'warn'} />
    <div>${title ? html`<strong>${title}</strong>` : null}${children}</div>
  </div>`;
}

export function CopyButton({ text, label = 'Copy', what }) {
  const [done, setDone] = useState(false);
  const t = useRef();
  useEffect(() => () => clearTimeout(t.current), []);
  const click = async () => {
    if (await copyText(text)) {
      setDone(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setDone(false), 1800);
    }
  };
  return html`<button type="button" class=${'btn ghost sm' + (done ? ' done' : '')} onClick=${click}
      aria-label=${(done ? 'Copied ' : label + ' ') + (what || '')}>
    <${Icon} name=${done ? 'check' : 'copy'} /><span aria-live="polite">${done ? 'Copied' : label}</span>
  </button>`;
}

export function ExLink({ href, children, label }) {
  if (!href) return children;
  return html`<a class="exlink" href=${href} target="_blank" rel="noopener noreferrer" aria-label=${label}>${children}<${Icon} name="out" /></a>`;
}
export const TxLink = ({ cfg, hash, children }) =>
  html`<${ExLink} href=${txUrl(cfg, hash)} label=${'View transaction ' + short(hash) + ' on the explorer'}>${children || short(hash)}<//>`;
export const AddrLink = ({ cfg, address, full }) =>
  html`<${ExLink} href=${addrUrl(cfg, address)} label=${'View ' + address + ' on the explorer'}>${full ? address : short(address)}<//>`;

// Re-render every `ms` so countdowns move.
export function useTick(ms = 1000, on = true) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms, on]);
}

// The shared "not deployed / no config / bad site" full-page state.
export function Empty({ title, children, action }) {
  return html`<section class="empty" aria-live="polite">
    <div class="empty-mark" aria-hidden="true"><${Icon} name="globe" /></div>
    <h2>${title}</h2>
    <p>${children}</p>
    ${action}
  </section>`;
}
