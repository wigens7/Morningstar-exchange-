'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let quote, requestKey, readyId, busy = false, clearTimer, pollTimer;
  const text = (message) => { $('message').textContent = message; };
  async function api(path, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 35000);
    try {
      const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
        cache: 'no-store', signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {},
        body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401) { location.assign('/'); throw new Error('Konekte ankò.'); }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Demann lan pa disponib. Rechaje estati a.');
      return data;
    } finally { clearTimeout(timer); }
  }
  function hideSecret() {
    clearTimeout(clearTimer); $('secret').replaceChildren();
    $('secret').hidden = true; $('hide-secret').hidden = true;
    $('reveal-pin').value = ''; $('pin').value = '';
  }
  function line(parent, label, value, cls = 'row') {
    const row = document.createElement('div'); row.className = cls;
    const key = document.createElement('span'), val = document.createElement('strong');
    key.textContent = label; val.textContent = value; row.append(key, val); parent.append(row);
  }
  function invalidateQuote() {
    quote = undefined; requestKey = undefined; $('offer').hidden = true; $('consent').checked = false; $('pin').value = '';
  }
  async function load() {
    clearTimeout(pollTimer);
    try {
      const data = await api('/api/virtual-cards/orders');
      $('orders').replaceChildren(); readyId = undefined;
      const open = data.orders.find((o) => o.state !== 'FAILED');
      $('buy').hidden = !data.enabled || !data.cardholderApproved || data.creationPriceConfigured === false || Boolean(open);
      if (open) text(open.message);
      else if (!data.enabled) text('Kreasyon kat la poko aktive pou kliyan yo. Admin dwe finalize aktivasyon an.');
      else if (!data.cardholderApproved) text('Admin dwe asosye yon Customer ID founisè a apwouve ak kont ou anvan ou kreye kat.');
      else if (data.creationPriceConfigured === false) text('Admin dwe fikse frè kreasyon kat la anvan ou ka fè yon demann.');
      else text('Cardholder ou pare. Chwazi premye montan ou vle sou kat la epi verifye pri total la.');
      for (const order of data.orders) {
        const panel = document.createElement('section'); panel.className = 'panel';
        const h = document.createElement('h2'); h.textContent = order.state === 'READY' ? 'Kat ou pare' : 'Demann kat';
        panel.append(h);
        if (order.card && order.state === 'READY') {
          panel.classList.add('payment-card'); readyId = order.id;
          line(panel, order.card.brand.toUpperCase(), '•••• ' + order.card.last4, 'row last');
          line(panel, 'Ekspirasyon', order.card.expiry);
          line(panel, 'Balans nan dènye verifikasyon an', '$' + order.card.balanceUSD);
          const checked = document.createElement('p'); checked.className = 'muted';
          checked.textContent = 'Balans sa a se yon foto nan moman verifikasyon an; li pa yon balans an tan reyèl.' +
            (order.card.checkedAt ? ' Verifye: ' + new Date(order.card.checkedAt).toLocaleString() + '.' : ''); panel.append(checked);
        }
        line(panel, 'Frè kreasyon', '$' + order.creationFeeUSD);
        line(panel, 'Premye montan sou kat', '$' + order.initialFundingUSD);
        line(panel, order.state === 'READY' ? 'Total peye' : order.state === 'FAILED' ? 'Total anile' : 'Total otorize', '$' + order.totalUSD);
        const status = document.createElement('p'); status.textContent = order.message; panel.append(status);
        const ref = document.createElement('p'); ref.className = 'muted';
        ref.textContent = 'Referans Morningstar: ' + order.id; panel.append(ref); $('orders').append(panel);
      }
      $('reveal-box').hidden = !readyId;
      if (open?.state === 'PENDING') pollTimer = setTimeout(load, 5000);
    } catch (e) { text(e.name === 'AbortError' ? 'Verifikasyon an pran tan. Rechaje estati a; pa repete acha a.' : e.message); }
  }
  $('funding').addEventListener('input', invalidateQuote);
  $('quote').addEventListener('click', async () => {
    if (busy) return; busy = true; $('quote').disabled = true; $('funding').disabled = true; invalidateQuote();
    try {
      quote = await api('/api/virtual-cards/quote', { initialFundingUSD: $('funding').value.trim() });
      requestKey = crypto.randomUUID();
      for (const [id, key] of [['fee', 'creationFeeUSD'], ['initial', 'initialFundingUSD'], ['total', 'totalUSD']]) $(id).textContent = '$' + quote[key] + ' USD';
      $('offer').hidden = false; text('Verifye montan total la. Antre PIN ou sèlman si ou dakò avèk acha sa a.');
    } catch (e) { text(e.message); }
    finally { busy = false; $('quote').disabled = false; $('funding').disabled = false; }
  });
  $('create').addEventListener('click', async () => {
    if (busy) return;
    if (!quote || !$('consent').checked || !/^\d{6}$/.test($('pin').value)) {
      text('Kalkile pri a, konfime montan an epi antre PIN 6 chif ou.'); return;
    }
    busy = true; $('create').disabled = true; $('quote').disabled = true; $('funding').disabled = true;
    const pin = $('pin').value; $('pin').value = ''; hideSecret();
    try {
      const result = await api('/api/virtual-cards/orders', { quoteId: quote.id, requestKey,
        acceptedTotalUSD: quote.totalUSD, consent: true, pin });
      text(result.message); invalidateQuote(); await load();
    } catch (e) {
      invalidateQuote(); await load();
      text(e.name === 'AbortError' ? 'Rezilta a poko klè. Pa repete acha a; rechaje estati a oswa kontakte admin.' : e.message);
    } finally { busy = false; $('create').disabled = false; $('quote').disabled = false; $('funding').disabled = false; }
  });
  $('refresh').addEventListener('click', () => { hideSecret(); void load(); });
  $('reveal').addEventListener('click', async () => {
    if (busy || !readyId || !/^\d{6}$/.test($('reveal-pin').value)) { text('Antre PIN 6 chif ou pou wè detay kat ou.'); return; }
    busy = true; $('reveal').disabled = true;
    const pin = $('reveal-pin').value; hideSecret();
    try {
      const detail = await api('/api/virtual-cards/orders/' + encodeURIComponent(readyId) + '/reveal', { pin });
      if (document.hidden || !document.hasFocus()) { hideSecret(); return; }
      line($('secret'), 'Nimewo kat', detail.number); line($('secret'), 'CVV', detail.cvv);
      line($('secret'), 'Ekspirasyon', detail.expiry);
      $('secret').hidden = false; $('hide-secret').hidden = false;
      clearTimer = setTimeout(hideSecret, 30000);
    } catch (e) { text(e.message); hideSecret(); }
    finally { busy = false; $('reveal').disabled = false; }
  });
  $('hide-secret').addEventListener('click', hideSecret);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hideSecret(); });
  window.addEventListener('blur', hideSecret);
  window.addEventListener('pagehide', () => { hideSecret(); clearTimeout(pollTimer); });
  void load();
})();
