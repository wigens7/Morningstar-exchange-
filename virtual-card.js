'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let topUpFee = null, readyId, busy = false, clearTimer, pollTimer, fundKey = null, fundAmount = null, billingText = '';
  const text = (message) => { $('message').textContent = message; };
  const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n; };
  const STATUS = { active: 'Aktif', frozen: 'Jele', terminated: 'Fèmen', pending: 'An atant' };
  const money = (v) => (v === null || v === undefined ? '—' : '$' + v);
  async function api(path, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 35000);
    try {
      const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
        cache: 'no-store', signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {},
        body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401) { location.assign('/'); throw new Error('Konekte ankò.'); }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.error || 'Demann lan pa disponib. Rechaje estati a.'), { code: data.code });
      return data;
    } finally { clearTimeout(timer); }
  }
  function hideSecret() {
    clearTimeout(clearTimer); $('secret').replaceChildren();
    $('secret').hidden = true; $('hide-secret').hidden = true;
  }
  function line(parent, label, value) {
    const row = el('div', 'row'); row.append(el('span', '', label), el('strong', '', value)); parent.append(row);
  }
  function badge(status) {
    const b = el('span', 'badge b-' + String(status || 'pending').toLowerCase(), STATUS[status] || status || '—'); return b;
  }
  function openPanel(name) {
    const same = $('pn-' + name) && !$('pn-' + name).hidden;
    for (const n of ['fund', 'history', 'billing', 'details']) $('pn-' + n).hidden = same || n !== name;
    document.querySelectorAll('.act').forEach((b) => b.setAttribute('aria-pressed', String(!same && b.dataset.panel === name)));
    if (name !== 'details' || same) hideSecret();
  }
  function renderHero(d) {
    const hero = $('hero'); hero.replaceChildren();
    const art = el('div', 'payment-card');
    const top = el('div', 'ctop'); top.append(el('span', '', 'MORNINGSTAR'), el('span', '', (d.card.brand || 'virtual').toUpperCase()));
    const chip = el('div', 'chip'), num = el('div', 'cnum', '•••• •••• •••• ' + (d.card.last4 || '••••'));
    const bot = el('div', 'cbot');
    for (const [k, v] of [['Ekspirasyon', d.card.expiry || '—'], ['Estati', STATUS[d.card.status] || d.card.status || '—']]) {
      const sp = el('span', '', k); sp.append(el('strong', '', v)); bot.append(sp);
    }
    art.append(top, chip, num, bot);
    const bal = el('div', 'balance'); bal.append(el('small', '', 'Balans kat la'), el('strong', '', money(d.card.balanceUSD)));
    const meta = el('div', 'row'); meta.append(badge(d.card.status), el('span', 'small', d.live ? 'Done dirèk nan ' + d.provider : 'Dènye done sove (' + d.provider + ' pa reponn)'));
    hero.append(art, bal, meta);
  }
  function renderTopups(list) {
    const box = $('topups'); box.replaceChildren();
    if (!list.length) { box.append(el('p', 'muted small', 'Poko gen rechaj.')); return; }
    for (const t of list) {
      const row = el('div', 'tx'), left = el('div'), sub = el('small', '', new Date(t.createdAt).toLocaleString());
      const label = { DONE: 'Fini', FAILED: 'Echwe, lajan tounen', PENDING: 'An verifikasyon' }[t.state] || t.state;
      left.append(el('span', '', 'Rechaj · ' + label), sub); row.append(left, el('strong', '', '+$' + t.amountUSD + (Number(t.feeUSD) ? ' (frè $' + t.feeUSD + ')' : ''))); box.append(row);
    }
  }
  function renderHistory(d) {
    const box = $('history'); box.replaceChildren();
    $('mycard-note').textContent = d.historyAvailable ? 'Tranzaksyon sou kat la, dirèkteman nan ' + d.provider + '.' : '';
    if (!d.historyAvailable) { box.append(el('p', 'muted', 'Istwa a pa disponib kounye a. Eseye ankò pita.')); return; }
    if (!d.history.length) { box.append(el('p', 'muted', 'Poko gen tranzaksyon sou kat la.')); return; }
    for (const t of d.history) {
      const row = el('div', 'tx'), left = el('div'), when = t.date && !Number.isNaN(Date.parse(t.date)) ? new Date(t.date).toLocaleString() : t.date;
      left.append(el('span', '', t.description || t.type || 'Tranzaksyon'), el('small', '', [when, t.status].filter(Boolean).join(' · ')));
      row.append(left, el('strong', '', t.amount ? (/^[\d.]+$/.test(t.amount) ? '$' + t.amount : t.amount) : '')); box.append(row);
    }
  }
  async function loadCard() {
    try {
      const d = await api('/api/virtual-cards/orders/card');
      $('wallet').hidden = !d.hasCard; if (!d.hasCard) return;
      renderHero(d);
      $('avail').textContent = '$' + d.availableUSD;
      topUpFee = d.topUpFeeUSD; feeNote();
      renderTopups(d.topups || []); renderHistory(d);
      const b = d.billingAddress, box = $('billing'); box.replaceChildren();
      line(box, 'Address', b.address); line(box, 'City', b.city); line(box, 'State', b.state);
      line(box, 'Country', b.country); line(box, 'Postal Code', b.postalCode);
      billingText = [b.address, b.city, b.state, b.country, b.postalCode].join(', ');
      const info = $('info'); info.replaceChildren();
      line(info, 'Founisè', d.provider); line(info, 'Mak', (d.card.brand || '').toUpperCase() || '—');
      line(info, 'Referans', d.card.reference || '—');
      line(info, 'Kreye', d.card.createdAt ? new Date(d.card.createdAt).toLocaleString() : '—');
      if ((d.topups || []).some((t) => t.state === 'PENDING')) { clearTimeout(pollTimer); pollTimer = setTimeout(loadCard, 8000); }
    } catch { $('wallet').hidden = true; }
  }
  async function load() {
    clearTimeout(pollTimer);
    try {
      const data = await api('/api/virtual-cards/orders');
      $('orders').replaceChildren(); readyId = undefined;
      const open = data.orders.find((o) => o.state !== 'FAILED');
      if (data.creationFeeUSD) $('fee').textContent = '$' + data.creationFeeUSD + ' USD';
      if (data.initialFundingUSD) $('buy-funding').textContent = '$' + data.initialFundingUSD + ' USD';
      $('nocard').hidden = Boolean(open);
      $('buy').hidden = !data.enabled || !data.cardholderApproved || data.creationPriceConfigured === false || Boolean(open);
      if (open) text(open.state === 'READY' ? 'Kat ou pare. Balans USD ou: $' + data.availableUSD + '.' : open.message);
      else if (!data.enabled) text('Kreasyon kat la poko aktive pou kliyan yo. Admin dwe finalize aktivasyon an.');
      else if (!data.cardholderApproved) text('Ou poko gen yon Customer ID apwouve. Fini verifikasyon (KYC) ou anvan ou kreye kat.');
      else if (data.creationPriceConfigured === false) text('Admin dwe fikse frè kreasyon kat la anvan ou ka fè yon demann.');
      else text('Ou pare. Balans USD ou: $' + data.availableUSD + '. Peze Kreye kat.');
      for (const order of data.orders) {
        if (order.state === 'READY' && order.card) { readyId = order.id; continue; }
        const panel = el('section', 'panel'); panel.append(el('h2', '', order.state === 'FAILED' ? 'Demann anile' : 'Demann kat'));
        line(panel, 'Frè kreasyon', '$' + order.creationFeeUSD);
        line(panel, 'Premye montan sou kat', '$' + order.initialFundingUSD);
        line(panel, order.state === 'FAILED' ? 'Total anile' : 'Total otorize', '$' + order.totalUSD);
        panel.append(el('p', '', order.message), el('p', 'muted small', 'Referans Morningstar: ' + order.id)); $('orders').append(panel);
      }
      if (readyId) void loadCard(); else $('wallet').hidden = true;
      if (open?.state === 'PENDING') pollTimer = setTimeout(load, 5000);
    } catch (e) { text(e.name === 'AbortError' ? 'Verifikasyon an pran tan. Rechaje estati a; pa repete acha a.' : e.message); }
  }
  $('create').addEventListener('click', async () => {
    if (busy) return;
    busy = true; $('create').disabled = true;
    try {
      const result = await api('/api/virtual-cards/create', {});
      text(result.message); await load();
    } catch (e) {
      await load();
      text(e.name === 'AbortError' ? 'Rezilta a poko klè. Pa repete demann lan; rechaje estati a oswa kontakte admin.' : e.message);
    } finally { busy = false; $('create').disabled = false; }
  });
  document.querySelectorAll('.act').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.panel)));
  document.querySelectorAll('#quick button').forEach((b) => b.addEventListener('click', () => { $('amount').value = Number(b.dataset.amt).toFixed(2); feeNote(); }));
  function feeNote() {
    const n = Number($('amount').value), note = $('fee-note');
    if (topUpFee === null) return;
    note.textContent = 'Minimòm rechaj: $5.00. Frè rechaj: $' + topUpFee + (n >= 5 && n <= 500 ? '. Total ki soti nan balans USD ou: $' + (n + Number(topUpFee)).toFixed(2) + '.' : ' pou chak rechaj.');
  }
  $('amount').addEventListener('input', feeNote);
  function fundNotice(kind, msg) { const n = $('fund-msg'); n.hidden = false; n.className = 'notice ' + kind; n.textContent = msg; }
  $('fund').addEventListener('click', async () => {
    if (busy) return;
    const amount = $('amount').value.trim();
    const n = Number(amount);
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(amount) || n < 5 || n > 500) { fundNotice('err', 'Antre yon montan ant $5.00 ak $500.00.'); return; }
    if (fundAmount !== amount) { fundKey = crypto.randomUUID(); fundAmount = amount; }   // same click retried = same key = never twice
    busy = true; $('fund').disabled = true; $('fund-msg').hidden = true;
    try {
      const t = await api('/api/virtual-cards/topup', { amountUSD: Number(amount).toFixed(2), requestKey: fundKey });
      fundKey = null; fundAmount = null; $('amount').value = ''; feeNote();
      fundNotice(t.state === 'DONE' ? 'ok' : '', t.state === 'DONE' ? 'Rechaj la fini. $' + t.amountUSD + ' antre sou kat la (frè $' + t.feeUSD + ').' :
        'Rechaj la an verifikasyon. Lajan an sekirize; pa repete rechaj la. Balans lan ap mete ajou poukont li.');
    } catch (e) {
      if (e.name !== 'AbortError') { fundKey = null; fundAmount = null; }
      fundNotice('err', e.name === 'AbortError' ? 'Rezilta a poko klè. Pa repete; rechaje paj la pou wè estati a.' : e.message);
    } finally { busy = false; $('fund').disabled = false; await Promise.all([loadCard(), load()]); }
  });
  $('copy-billing').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(billingText); $('copy-msg').hidden = false; setTimeout(() => { $('copy-msg').hidden = true; }, 2500); } catch { /* clipboard unavailable */ }
  });
  $('refresh').addEventListener('click', () => { hideSecret(); void load(); });
  $('reveal').addEventListener('click', async () => {
    if (busy || !readyId) return;
    busy = true; $('reveal').disabled = true;
    hideSecret();
    try {
      const detail = await api('/api/virtual-cards/orders/' + encodeURIComponent(readyId) + '/reveal', {});
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
