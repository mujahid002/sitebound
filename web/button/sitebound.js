// <sitebound-pay amount="12.00" order="A123"></sitebound-pay>
// Opens the Sitebound frame (served next to this script) in a modal. The shop page never holds an
// address: the frame signs for the site the browser reports, and the contract pays that site's payout.
// Fires `sitebound:paid` with detail { orderId, txHash, paymentId } once the payment is on-chain.
(() => {
  const FRAME = new URL('../frame/index.html', document.currentScript.src);
  const CSS = `
    :host { display: inline-block; }
    button.pay {
      display: inline-flex; align-items: center; gap: 10px; height: 48px; padding: 0 26px;
      border: 0; border-radius: 999px; background: #0b7a5a; color: #fff; cursor: pointer;
      font: 600 1rem/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      transition: transform .2s cubic-bezier(.22,1,.36,1), box-shadow .2s;
    }
    button.pay:hover { box-shadow: 0 6px 20px rgba(11,122,90,.28); transform: translateY(-1px); }
    button.pay:active { transform: scale(.98); }
    button.pay:focus-visible { outline: 3px solid #0b7a5a; outline-offset: 3px; }
    button.pay svg { width: 18px; height: 18px; }
    dialog { padding: 0; border: 0; border-radius: 20px; background: transparent; overflow: hidden;
      width: min(400px, calc(100vw - 24px)); box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 18px 60px rgba(0,0,0,.25); }
    dialog::backdrop { background: rgba(13,15,17,.45); backdrop-filter: blur(2px); }
    iframe { display: block; width: 100%; height: min(560px, calc(100vh - 48px)); height: min(560px, calc(100dvh - 48px)); border: 0; }
  `;
  const MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="8" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="16" r="5" fill="currentColor"/></svg>';

  class SiteboundPay extends HTMLElement {
    static observedAttributes = ['amount'];

    connectedCallback() {
      // Moving the element in the page disconnects and reconnects it: listen again, or close and paid are lost.
      if (this.shadowRoot) return addEventListener('message', this.onMessage);
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><button class="pay" part="button" type="button">${MARK}<span></span></button><dialog aria-label="Sitebound checkout"></dialog>`;
      this.dialog = root.querySelector('dialog');
      root.querySelector('button').onclick = () => this.open();
      this.dialog.onclose = () => this.dialog.replaceChildren();
      this.onMessage = (e) => this.message(e);
      addEventListener('message', this.onMessage);
      this.attributeChangedCallback();
    }

    disconnectedCallback() {
      removeEventListener('message', this.onMessage);
    }

    attributeChangedCallback() {
      const label = this.shadowRoot?.querySelector('span');
      if (label) label.textContent = `Pay ${this.getAttribute('amount') ?? ''} USDT`;
    }

    open() {
      const src = new URL(FRAME);
      src.searchParams.set('amount', this.getAttribute('amount') ?? '');
      src.searchParams.set('order', this.getAttribute('order') ?? '');
      // Optional: "<expiry>.<signature>" from the merchant's backend, for sites with a quote signer.
      if (this.hasAttribute('quote')) src.searchParams.set('quote', this.getAttribute('quote'));
      this.frame = document.createElement('iframe');
      this.frame.title = 'Sitebound checkout';
      this.frame.allow = 'publickey-credentials-get *; publickey-credentials-create *';
      this.frame.src = src;
      this.dialog.replaceChildren(this.frame);
      this.dialog.showModal();
    }

    message(e) {
      if (e.origin !== FRAME.origin || !this.frame || e.source !== this.frame.contentWindow) return;
      const { type, orderId, txHash, paymentId } = e.data ?? {};
      if (type === 'sitebound:close') this.dialog.close();
      if (type === 'sitebound:paid') {
        this.dispatchEvent(new CustomEvent('sitebound:paid', { detail: { orderId, txHash, paymentId }, bubbles: true, composed: true }));
      }
    }
  }

  customElements.get('sitebound-pay') || customElements.define('sitebound-pay', SiteboundPay);
})();
