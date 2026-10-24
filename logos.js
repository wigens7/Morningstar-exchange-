// Logo metòd peman yo.
// 1) Si w mete yon vrè logo nan dosye "logos/" (egz. logos/moncash.svg, logos/paypal.svg), sit la itilize l otomatikman.
// 2) Sinon, li montre yon ti badj SVG ak koulè ak premye lèt metòd la (pa vrè logo a).
(function () {
  const B = {
    MonCash: ['#E4002B', 'M'], NatCash: ['#0067B1', 'N'], PayPal: ['#003087', 'P'], Zelle: ['#6D1ED4', 'Z'],
    Meru: ['#1F2937', 'M'], CashApp: ['#00D632', '$'], USDT: ['#26A17B', '₮'], Wise: ['#9FE870', 'W'], Binance: ['#F0B90B', 'B']
  };
  const DARK_TEXT = ['Wise', 'CashApp', 'Binance'];
  function badge(n, s) {
    const [c, l] = B[n] || ['#4B5563', (n || '?')[0]];
    const fg = DARK_TEXT.includes(n) ? '#111' : '#fff';
    return `<svg class="lg" viewBox="0 0 40 40" width="${s}" height="${s}" role="img" aria-label="${n}" style="display:inline-block;flex-shrink:0"><rect width="40" height="40" rx="11" fill="${c}"/><text x="20" y="27.5" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-weight="800" font-size="21" fill="${fg}">${l}</text></svg>`;
  }
  window.logo = (n, s = 28) =>
    `<img class="lg" src="/logos/${String(n).toLowerCase()}.svg" width="${s}" height="${s}" alt="${n}" data-n="${n}" data-s="${s}" onerror="__lg(this)" style="display:inline-block;border-radius:.6rem;object-fit:contain">`;
  window.__lg = (el) => { el.outerHTML = badge(el.dataset.n, el.dataset.s); };
})();
