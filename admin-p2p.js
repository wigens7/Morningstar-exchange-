// Konsòl admin P2P. Itilize api(), $ ak esc() ki nan admin.html.
(function () {
  const ALL = [['orders', 'Lòd'], ['disputes', 'Dispit'], ['escrows', 'Escrow'], ['ledger', 'Ledger'], ['audit', 'Odit'], ['alerts', 'Alèt'], ['reports', 'Rapò'], ['ads', 'Anons'], ['jobs', 'Travay']];
  const STAFF_ONLY_HIDDEN = ['ledger', 'audit']; // support pa wè done finansye yo
  let sub = 'orders', role = 'admin';
  const m6 = (n) => (Number(n) / 1e6).toFixed(6);
  const dt = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
  const short = (id) => String(id || '').slice(0, 8);
  const COL = { COMPLETED: 'text-emerald-400', CANCELLED: 'text-gray-400', EXPIRED: 'text-gray-400', DISPUTED: 'text-red-400', UNDER_REVIEW: 'text-red-400', PAYMENT_MARKED: 'text-sky-300', WAITING_PAYMENT: 'text-amber-400' };
  const st = (s) => `<span class="${COL[s] || 'text-gray-300'} text-xs font-bold">${esc(s)}</span>`;
  const card = (inner, extra = '') => `<div class="card rounded-2xl p-3.5 text-sm ${extra}">${inner}</div>`;
  const empty = '<p class="text-gray-400">Pa gen anyen.</p>';

  window.loadP2P = async function (r) {
    if (r) role = r;
    const tabs = ALL.filter(([k]) => role === 'admin' || !STAFF_ONLY_HIDDEN.includes(k));
    if (!tabs.some(([k]) => k === sub)) sub = 'orders';
    $('list').innerHTML = `<div class="flex gap-2 overflow-x-auto pb-1 mb-1">${tabs.map(([k, l]) => `<button class="b tab ${k === sub ? 'on' : ''}" onclick="p2pGo('${k}')">${l}</button>`).join('')}</div>
      ${role === 'admin' ? `<div class="flex gap-2 mb-1"><button class="b bg-sky-600 text-white" onclick="p2pReconcile()">Reconciliation</button><button class="b tab" onclick="p2pRunJobs()">Kouri travay yo kounye a</button></div><div id="p2p-recon"></div>` : ''}
      <div id="p2p-body" class="space-y-2"><p class="text-gray-400">Chajman...</p></div>`;
    await ({ orders: pOrders, disputes: pDisputes, escrows: pEscrows, ledger: pLedger, audit: pAudit, alerts: pAlerts, reports: pReports, ads: pAds, jobs: pJobs })[sub]();
  };
  window.p2pGo = (k) => { sub = k; loadP2P(); };
  const body = (h) => { $('p2p-body').innerHTML = h || empty; };

  window.p2pReconcile = async () => {
    const r = await api('/api/p2p/admin/reconcile', {});
    $('p2p-recon').innerHTML = card(r.clean ? '<span class="text-emerald-400 font-bold">✔ Pa gen okenn diferans.</span> Balans, escrow ak ledger koresponn.'
      : `<p class="font-bold ${r.ok ? 'text-amber-400' : 'text-red-400'} mb-1">${r.ok ? 'Avètisman' : 'PWOBLÈM KRITIK'}: ${r.issues.length}</p>${r.issues.map((i) => `<p class="text-xs"><b class="${i.severity === 'CRITICAL' ? 'text-red-400' : 'text-amber-400'}">${esc(i.code)}</b> ${esc(JSON.stringify(i.detail))}</p>`).join('')}`, 'mb-2');
  };
  window.p2pRunJobs = async () => { await api('/api/p2p/admin/run-jobs', {}); await p2pReconcile(); loadP2P(); };

  async function pOrders() {
    const rows = await api('/api/p2p/admin/orders?limit=100');
    body(rows.map((o) => card(`<div class="flex justify-between"><span class="font-semibold">${esc(short(o.id))} · ${esc(o.crypto)} USDT</span>${st(o.status)}</div>
      <p class="text-xs text-gray-400">${esc(o.buyer)} (achtè) ↔ ${esc(o.seller)} (vandè) · ${esc(o.fiatAmount)} ${esc(o.fiat)} · ${esc(o.method)}</p>
      <p class="text-[11px] text-gray-500">${dt(o.createdAt)} · escrow: ${esc(o.escrow || '—')}${o.providerVerified ? ' · pwovizè ✔' : ''}${o.lateClaim ? ' · reklamasyon an reta' : ''}</p>`, 'cursor-pointer" onclick="p2pOrder(\'' + o.id + '\')')).join(''));
  }
  async function pDisputes() {
    const rows = await api('/api/p2p/admin/disputes');
    body(rows.map((d) => card(`<div class="flex justify-between"><span class="font-semibold">Dispit #${d.id} · lòd ${esc(short(d.order_id))}</span><span class="text-xs font-bold ${d.status === 'RESOLVED' ? 'text-emerald-400' : 'text-red-400'}">${esc(d.status)}</span></div>
      <p class="text-xs text-gray-300 mt-1">${esc(d.reason)}</p><p class="text-[11px] text-gray-500">${dt(d.opened_at)} · ${esc(m6(d.crypto_micro))} USDT${d.late_claim ? ' · reklamasyon an reta' : ''}${d.resolution ? ' · ' + esc(d.resolution) : ''}</p>`, 'cursor-pointer" onclick="p2pOrder(\'' + d.order_id + '\')')).join(''));
  }
  async function pEscrows() {
    const rows = await api('/api/p2p/admin/escrows');
    body(rows.map((e) => card(`<div class="flex justify-between"><span>Lòd ${esc(short(e.order_id))}</span><b>${esc(m6(e.amount))} USDT</b></div><p class="text-[11px] text-gray-500">vandè ${esc(short(e.seller_id))} · ${esc(e.status)} · ${dt(e.updated_at)}</p>`)).join(''));
  }
  async function pLedger() {
    const rows = await api('/api/p2p/admin/ledger?limit=100');
    body(rows.map((t) => card(`<div class="flex justify-between"><span class="font-semibold text-xs">#${t.id} · ${esc(t.type)}</span><span class="text-[11px] text-gray-500">${dt(t.created_at)}</span></div>
      ${t.entries.map((e) => `<p class="text-xs"><b class="${e.dir === 'DEBIT' ? 'text-red-300' : 'text-emerald-300'}">${e.dir}</b> ${esc(e.kind)}:${esc(short(e.owner))} <span class="float-right">${esc(m6(e.amount))}</span></p>`).join('')}
      <p class="text-[10px] text-gray-600 break-all">${esc(t.ref)}</p>`)).join(''));
  }
  async function pAudit() {
    const rows = await api('/api/p2p/admin/audit?limit=150');
    body(rows.map((a) => card(`<div class="flex justify-between"><b class="text-xs">${esc(a.action)}</b><span class="text-[11px] text-gray-500">${dt(a.ts)}</span></div><p class="text-[11px] text-gray-400">${esc(a.role || '')} ${esc(short(a.actor))} → ${esc(a.entity || '')} ${esc(short(a.entity_id))}${a.ip ? ' · ' + esc(a.ip) : ''}</p>${a.details ? `<p class="text-[11px] text-gray-500 break-all">${esc(a.details)}</p>` : ''}`)).join(''));
  }
  async function pAlerts() {
    const rows = await api('/api/p2p/admin/alerts');
    body(rows.map((a) => card(`<div class="flex justify-between"><b class="text-xs ${/RECONC|MISMATCH|JOB/.test(a.kind) ? 'text-red-400' : 'text-amber-400'}">${esc(a.kind)}</b><span class="text-[11px] text-gray-500">${dt(a.ts)}</span></div><p class="text-[11px] text-gray-400">itilizatè ${esc(short(a.user_id))}</p><p class="text-[11px] text-gray-500 break-all">${esc(a.details)}</p>`)).join(''));
  }
  async function pReports() {
    const rows = await api('/api/p2p/admin/reports');
    body(rows.map((r) => card(`<div class="flex justify-between"><b class="text-xs">${esc(r.target_type)} ${esc(short(r.target_id))}</b><span class="text-[11px] text-gray-500">${dt(r.ts)}</span></div><p class="text-xs text-gray-300">${esc(r.reason)}</p>`)).join(''));
  }
  async function pAds() {
    const rows = await api('/api/p2p/admin/ads');
    body(rows.map((a) => card(`<div class="flex justify-between"><span class="font-semibold">${a.type === 'SELL' ? 'Vann' : 'Achte'} · ${esc(a.price)} ${esc(a.fiat)}</span><span class="text-xs font-bold ${a.status === 'ACTIVE' ? 'text-emerald-400' : 'text-gray-400'}">${esc(a.status)}</span></div>
      <p class="text-xs text-gray-400">${esc(a.advertiser)}${a.realName && a.realName !== a.advertiser ? ' (reyèl: ' + esc(a.realName) + ')' : ''} · rete ${esc(a.available)} USDT · ${esc(a.methods.join(', '))}</p>
      ${role === 'admin' && a.status !== 'SUSPENDED' && a.status !== 'CLOSED' ? `<button class="b bg-red-600 text-white mt-2" onclick="p2pSuspend('${a.id}')">Sispann anons lan</button>` : ''}
      ${role === 'admin' ? `<button class="b tab mt-2 ml-1" onclick="p2pResetMerchant('${a.userId}')">Reyinisyalize non machann</button>` : ''}`)).join(''));
  }
  window.p2pSuspend = async (id) => {
    const reason = prompt('Rezon pou sispann anons lan (omwen 10 karaktè):'); if (!reason) return;
    try { await api(`/api/p2p/admin/ads/${id}/suspend`, { reason }); loadP2P(); } catch (e) { /* api() montre erè a */ }
  };
  window.p2pResetMerchant = async (uid) => {
    const reason = prompt('Rezon pou efase non biznis machann sa a (omwen 10 karaktè). Anons li yo ap poze:'); if (!reason) return;
    try { await api(`/api/p2p/admin/merchants/${uid}/reset`, { reason }); loadP2P(); } catch (e) { /* api() montre erè a */ }
  };
  async function pJobs() {
    const rows = await api('/api/p2p/admin/jobs');
    body(rows.map((j) => card(`<div class="flex justify-between"><b class="text-xs">${esc(j.name)}</b><span class="text-xs font-bold ${j.ok === 1 ? 'text-emerald-400' : j.ok === 0 ? 'text-red-400' : 'text-gray-400'}">${j.ok === 1 ? 'OK' : j.ok === 0 ? 'ECHWE' : '...'}</span></div><p class="text-[11px] text-gray-500">${dt(j.started_at)} · trete: ${j.processed ?? 0}</p>${j.error ? `<p class="text-[11px] text-red-400">${esc(j.error)}</p>` : ''}`)).join(''));
  }

  // ----- detay yon lòd / dispit -----
  window.p2pOrder = async (id) => {
    const o = await api('/api/p2p/admin/orders/' + id);
    const d = o.dispute;
    let box = document.getElementById('p2p-modal');
    if (!box) { box = document.createElement('div'); box.id = 'p2p-modal'; box.className = 'modal'; box.onclick = (e) => { if (e.target === box) box.classList.add('hidden'); }; document.body.appendChild(box); }
    const canResolve = role === 'admin' && d && d.status === 'UNDER_REVIEW';
    box.innerHTML = `<div class="sheet" style="max-height:92vh;overflow-y:auto"><div class="flex justify-between items-center mb-2"><h2 class="font-bold">Lòd ${esc(short(o.id))}</h2><button onclick="this.closest('.modal').classList.add('hidden')" class="text-gray-400 text-2xl leading-none">&times;</button></div>
      <p>${st(o.status)} <span class="text-xs text-gray-400">escrow: ${esc(o.escrow || '—')}</span></p>
      <div class="text-xs text-gray-300 mt-2 space-y-0.5"><p>Achtè: ${esc(o.buyer)}${o.buyerReal !== o.buyer ? ' [reyèl: ' + esc(o.buyerReal) + ']' : ''} (${esc(short(o.buyerId))}) · Vandè: ${esc(o.seller)}${o.sellerReal !== o.seller ? ' [reyèl: ' + esc(o.sellerReal) + ']' : ''} (${esc(short(o.sellerId))})</p>
        <p>${esc(o.crypto)} USDT ↔ ${esc(o.fiatAmount)} ${esc(o.fiat)} (${esc(o.price)}) · ${esc(o.method)} · ref ${esc(o.payRef)}</p>
        <p>Kont vandè: ${esc(o.sellerPay.account)} (${esc(o.sellerPay.name)})</p><p>Referans achtè: ${esc(o.paymentNote || '—')} ${o.providerVerified ? '· <b class="text-emerald-400">pwovizè ✔</b>' : ''}</p></div>
      ${d ? `<div class="mt-3 p-3 rounded-xl border border-red-500/30"><p class="text-xs font-bold text-red-300">Dispit #${d.id} · ${esc(d.status)}</p><p class="text-xs mt-1">${esc(d.reason)}</p>
        ${d.status === 'OPEN' ? `<button class="b bg-sky-600 text-white mt-2" onclick="p2pTake(${d.id},'${o.id}')">Pran dispit la</button>` : ''}
        ${canResolve ? `<label class="block text-xs mt-3 mb-1">Desizyon (aksyon finansye — obligatwa gen rezon)</label>
          <select id="p2p-dec" class="inp"><option value="RELEASE_TO_BUYER">Lage USDT bay achtè a</option><option value="RETURN_TO_SELLER">Retounen USDT bay vandè a</option></select>
          <textarea id="p2p-why" rows="2" class="inp mt-2" placeholder="Rezon (omwen 10 karaktè): ki prèv ou tcheke?"></textarea>
          <button class="b bg-red-600 text-white mt-2" onclick="p2pResolve(${d.id},'${o.id}')">Konfime desizyon an</button>` : ''}
        ${d.status === 'RESOLVED' ? `<p class="text-xs mt-2 text-emerald-300">${esc(d.resolution)} — ${esc(d.resolution_reason)}</p>` : ''}</div>` : ''}
      ${o.evidence.length ? `<p class="text-xs font-semibold mt-3 mb-1">Prèv</p><div class="flex gap-2 flex-wrap">${o.evidence.map((e) => `<a href="/api/p2p/evidence/${e.id}" target="_blank"><img src="/api/p2p/evidence/${e.id}" class="w-20 h-20 object-cover rounded-lg" alt=""><span class="text-[10px] text-gray-500">${e.by === 'BUYER' ? 'Achtè' : 'Vandè'}</span></a>`).join('')}</div>` : ''}
      <p class="text-xs font-semibold mt-3 mb-1">Chat</p><div class="space-y-1 max-h-48 overflow-y-auto text-xs">${o.messages.map((m) => `<p class="${m.role === 'STAFF' ? 'text-red-300' : m.role === 'SYSTEM' ? 'text-gray-500' : 'text-gray-200'}"><b>${esc(m.from)}</b>: ${esc(m.body)}</p>`).join('')}</div>
      ${d && d.status !== 'RESOLVED' ? `<div class="flex gap-2 mt-2"><input id="p2p-msg" class="inp" placeholder="Mesaj bay patisipan yo..." maxlength="1000"><button class="b bg-sky-600 text-white" onclick="p2pMsg('${o.id}')">Voye</button></div>` : ''}
      <details class="mt-3 text-xs text-gray-400"><summary class="cursor-pointer">Istwa lòd la</summary>${o.events.map((e) => `<p>${dt(e.ts)} · ${esc(e.actor_role || '')} · ${esc(e.action)}${e.to_status ? ' → ' + esc(e.to_status) : ''}</p>`).join('')}</details></div>`;
    box.classList.remove('hidden');
  };
  window.p2pTake = async (did, oid) => { await api(`/api/p2p/admin/disputes/${did}/take`, {}); p2pOrder(oid); };
  window.p2pResolve = async (did, oid) => {
    const dec = $('p2p-dec').value, why = $('p2p-why').value.trim();
    if (why.length < 10) return alert('Ekri yon rezon (omwen 10 karaktè).');
    if (!confirm(`Konfime: ${dec === 'RELEASE_TO_BUYER' ? 'LAGE USDT bay achtè a' : 'RETOUNEN USDT bay vandè a'}?\nAksyon sa a pa ka defèt.`)) return;
    await api(`/api/p2p/admin/disputes/${did}/resolve`, { decision: dec, reason: why });
    p2pOrder(oid); if (sub === 'disputes') loadP2P();
  };
  window.p2pMsg = async (oid) => { const t = $('p2p-msg').value.trim(); if (!t) return; await api(`/api/p2p/admin/orders/${oid}/messages`, { body: t }); p2pOrder(oid); };
})();
