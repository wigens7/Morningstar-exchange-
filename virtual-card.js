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
    $('reveal-pin').value = '';
  }
  function line(parent, label, value, cls = 'row') {
    const row = document.createElement('div'); row.className = cls;
    const key = document.createElement('span'), val = document.createElement('strong');
    key.textContent = label; val.textContent = value; row.append(key, val); parent.append(row);
  }
  const STATUS = { active: 'Aktif', frozen: 'Jele', terminated: 'Fèmen', pending: 'An atant' };
  async function loadCard() {
    try {
      const d = await api('/api/virtual-cards/orders/card');
      $('mycard').hidden = !d.hasCard; if (!d.hasCard) return;
      const rows = $('mycard-rows'); rows.replaceChildren();
      const st = document.createElement('span'); st.className = 'badge b-' + d.card.status; st.textContent = STATUS[d.card.status] || d.card.status || '—';
      const sr = document.createElement('div'); sr.className = 'row'; const k = document.createElement('span'); k.textContent = 'Estati';
      sr.append(k, st); rows.append(sr);
      line(rows, 'Balans', d.card.balanceUSD !== null ? '$' + d.card.balanceUSD + ' USD' : '—');
      line(rows, '4 dènye chif', d.card.last4 ? '•••• ' + d.card.last4 : '—');
      line(rows, 'Ekspirasyon', d.card.expiry || '—');
      line(rows, 'Mak', (d.card.brand || '').toUpperCase() || '—');
      line(rows, 'Founisè', d.provider);
      line(rows, 'Referans', d.card.reference || '—');
      line(rows, 'Kreye', d.card.createdAt ? new Date(d.card.createdAt).toLocaleString() : '—');
      $('mycard-note').textContent = d.live ? 'Done dirèk nan ZiiroPay.' : 'ZiiroPay pa reponn kounye a; sa yo se dènye done sove yo.';
      const box = $('history'); box.replaceChildren();
      if (!d.historyAvailable) { box.textContent = 'Istwa a pa disponib kounye a. Eseye ankò pita.'; return; }
      if (!d.history.length) { box.textContent = 'Poko gen tranzaksyon sou kat la.'; return; }
      for (const t of d.history) {
        const row = document.createElement('div'); row.className = 'tx';
        const left = document.createElement('div'), title = document.createElement('span'), sub = document.createElement('small');
        title.textContent = t.description || t.type || 'Tranzaksyon';
        sub.textContent = [t.date && !Number.isNaN(Date.parse(t.date)) ? new Date(t.date).toLocaleString() : t.date, t.status].filter(Boolean).join(' · ');
        left.append(title, sub); const amt = document.createElement('strong');
        amt.textContent = t.amount ? (/^[\d.]+$/.test(t.amount) ? '$' + t.amount : t.amount) : '';
        row.append(left, amt); box.append(row);
      }
    } catch { $('mycard').hidden = true; }
  }
  async function load() {
    clearTimeout(pollTimer);
    try {
      const data = await api('/api/virtual-cards/orders');
      $('orders').replaceChildren(); readyId = undefined;
      const open = data.orders.find((o) => o.state !== 'FAILED');
      if (data.creationFeeUSD) $('fee').textContent = '$' + data.creationFeeUSD + ' USD';
      $('nocard').hidden = Boolean(open);
      $('buy').hidden = !data.enabled || !data.cardholderApproved || data.creationPriceConfigured === false || Boolean(open);
      if (open) text(open.message);
      else if (!data.enabled) text('Kreasyon kat la poko aktive pou kliyan yo. Admin dwe finalize aktivasyon an.');
      else if (!data.cardholderApproved) text('Ou poko gen yon Customer ID apwouve. Fini verifikasyon (KYC) ou anvan ou kreye kat.');
      else if (data.creationPriceConfigured === false) text('Admin dwe fikse frè kreasyon kat la anvan ou ka fè yon demann.');
      else text('Ou pare. Balans USD ou: $' + data.availableUSD + '. Peze Kreye kat.');
      for (const order of data.orders) {
        const panel = document.createElement('section'); panel.className = 'panel';
        const h = document.createElement('h2'); h.textContent = order.state === 'READY' ? 'Kat ou pare' : 'Demann kat';
        panel.append(h);
        let art;
        if (order.card && order.state === 'READY') {
          art = document.createElement('div'); art.className = 'payment-card'; readyId = order.id;
          const top = document.createElement('div'); top.className = 'ctop';
          const b1 = document.createElement('span'), b2 = document.createElement('span');
          b1.textContent = 'MORNINGSTAR'; b2.textContent = order.card.brand.toUpperCase(); top.append(b1, b2);
          const chip = document.createElement('div'); chip.className = 'chip';
          const num = document.createElement('div'); num.className = 'cnum'; num.textContent = '•••• •••• •••• ' + order.card.last4;
          const bot = document.createElement('div'); bot.className = 'cbot';
          for (const [k, v] of [['Ekspirasyon', order.card.expiry], ['Balans', '$' + order.card.balanceUSD]]) {
            const sp = document.createElement('span'), st = document.createElement('strong');
            st.textContent = v; sp.append(k, st); bot.append(sp);
          }
          art.append(top, chip, num, bot); $('orders').append(art);
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
      if (readyId) void loadCard(); else $('mycard').hidden = true;
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
