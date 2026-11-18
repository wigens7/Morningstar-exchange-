'use strict';

const { usdToCents } = require('./virtual-card-setup');
const BASE = 'https://www.ziiropay.com/api/bitvcard/';
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(id);
const safeName = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && !/[\x00-\x1f<>]/.test(v);

function createCardProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.ZIIROPAY_API_KEY ?? '';
  const mode = options.mode ?? process.env.ZIIROPAY_CARD_MODE ?? 'sandbox';
  const fetchImpl = options.fetchImpl || fetch;
  // Redacted shape of every provider answer, so a card stuck in pending can be explained from the logs.
  // Never logs the key, card number/CVV, emails or long digit runs; message text is truncated.
  function diagnose(endpoint, method, status, body) {
    try {
      const text = (v) => (typeof v === 'string' ? v : '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
        .replace(/\d{6,}/g, '<n>').slice(0, 160);
      const d = body.response?.card_detail;
      console.info('[ziiropay-card] ' + method + ' ' + endpoint + ' http=' + status + ' success=' + body.success +
        ' status=' + text(String(body.status ?? '')) + ' keys=' + Object.keys(body).slice(0, 12).join(',') +
        (body.response && typeof body.response === 'object' ? ' response_keys=' + Object.keys(body.response).slice(0, 12).join(',') : '') +
        (d ? ' card_status=' + text(String(d.card_status ?? '')) + ' detail_keys=' + Object.keys(d).slice(0, 20).join(',') : '') +
        ' msg=' + text(body.message ?? body.error ?? body.response?.message ?? ''));
    } catch { /* diagnostics never affect the result */ }
  }
  async function request(endpoint, method, fields) {
    if (!apiKey || !['sandbox', 'live'].includes(mode)) return { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    let reader;
    try {
      const url = new URL(endpoint, BASE);
      url.searchParams.set('public_key', apiKey);
      if (mode === 'sandbox') url.searchParams.set('mode', 'sandbox');
      // Provider's test-mode convention: sandbox is explicit, live omits mode.
      // No client controls mode, key, name or customer_id.
      for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
      const r = await fetchImpl(url.toString(), { method, redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!r.body || !/application\/(?:[\w.-]+\+)?json\b/i.test(r.headers.get('content-type') || '')) {
        if (r.body) await r.body.cancel().catch(() => {});
        return { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' };
      }
      reader = r.body.getReader();
      const chunks = []; let length = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > 32768) return { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' };
        chunks.push(Buffer.from(part.value));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' };
      diagnose(endpoint, method, r.status, body);
      const hasCardHint = [body.card_id, body.cardId, body.data?.card_id, body.response?.card_id,
        body.response?.card_detail?.card_id].some(validId) || Boolean(body.response?.card_detail) ||
        ['active', 'complete', 'completed', 'success'].includes(body.status);
      const validationRejected = r.status === 422 && body.errors && typeof body.errors === 'object' &&
        !Array.isArray(body.errors) && Object.keys(body.errors).length > 0;
      // Provider definitively said "no card" because its own balance is too low: keep the order
      // pending so an admin can top up and Retry. Never a refund, never an ambiguous review.
      const lowFunds = method === 'POST' && body.success === false && !hasCardHint && r.status < 500 &&
        (r.status === 402 ||
          /insufficient|not enough|low balance|funds?\b/i.test(JSON.stringify(body) || ''));
      if (lowFunds) return { ok: false, awaitingFunds: true, code: 'CARD_PROVIDER_FUNDS' };
      if (method === 'POST' && (validationRejected || [401, 403].includes(r.status)) &&
          body.success === false && !hasCardHint) {
        return { ok: false, rejected: true, code: 'CARD_PROVIDER_REJECTED' };
      }
      if (!r.ok || body.success !== true) return { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' };
      return { ok: true, body };
    } catch {
      return { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' };
    } finally {
      clearTimeout(timer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  function detail(body, cardId, sensitive = false) {
    const d = body?.response?.card_detail;
    if (mode === 'live' && ([body?.mode, body?.response?.mode, d?.mode, d?.environment].some((v) =>
      ['sandbox', 'test'].includes(String(v).toLowerCase())) || body?.livemode === false || d?.livemode === false)) {
      return { ok: false, code: 'CARD_DETAILS_UNVERIFIED' };
    }
    if (!d || d.card_id !== cardId || !validId(d.customer_id) ||
        !safeName(d.card_holder_name) || !safeName(d.customer_email) ||
        !/^\d{4}$/.test(d.last4) || !/^(?:0[1-9]|1[0-2])\/20\d{2}$/.test(d.expiry) ||
        typeof d.balance !== 'string' || usdToCents(d.balance) === null ||
        typeof d.reference !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(d.reference) ||
        typeof d.created_at !== 'string' || !Number.isFinite(Date.parse(d.created_at)) ||
        d.card_type !== 'virtual' || !['visa', 'mastercard'].includes(String(d.card_brand).toLowerCase()) ||
        !['active', 'pending', 'frozen', 'terminated'].includes(d.card_status)) return { ok: false, code: 'CARD_DETAILS_UNVERIFIED' };
    const card = { cardId, customerId: d.customer_id, holder: d.card_holder_name, email: d.customer_email,
      last4: d.last4, expiry: d.expiry, brand: d.card_brand.toLowerCase(), status: d.card_status,
      balanceCents: usdToCents(d.balance), reference: d.reference, createdAt: d.created_at };
    if (sensitive) {
      if (typeof d.card_number !== 'string' || !/^\d{12,19}$/.test(d.card_number) ||
          d.card_number.slice(-4) !== card.last4 || typeof d.cvv !== 'string' || !/^\d{3,4}$/.test(d.cvv)) {
        return { ok: false, code: 'CARD_REVEAL_UNAVAILABLE' };
      }
      card.number = d.card_number; card.cvv = d.cvv;
    }
    // All other fields, including tokenized URLs, are discarded.
    return { ok: true, card };
  }
  return {
    configured: Boolean(apiKey) && ['sandbox', 'live'].includes(mode),
    mode,
    async create({ customerId, name, fundingCents }) {
      if (!validId(customerId) || !safeName(name) || !Number.isSafeInteger(fundingCents) || fundingCents < 0 ||
          fundingCents > 99999999) return { ok: false, rejected: true, code: 'INVALID_CARD_REQUEST' };
      const result = await request('create-nfc-card', 'POST', {
        customer_id: customerId, name, amount: (fundingCents / 100).toFixed(2)
      });
      if (!result.ok) return result;
      // Creation response schema is not published. These are candidate hints
      // only, NEVER proof of success. Independent documented GET must verify it.
      const b = result.body;
      const ids = [...new Set([b.card_id, b.cardId, b.data?.card_id, b.response?.card_id,
        b.response?.card_detail?.card_id].filter(validId))];
      return ids.length === 1 ? { ok: true, candidateId: ids[0] } : { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' };
    },
    // Card history (GET nfc-card-transactions). The answer schema is not published, so every field is read
    // defensively, kept as short plain text/number, and anything that looks like a card number is dropped.
    async history(cardId) {
      if (!validId(cardId)) return { ok: false, code: 'INVALID_CARD_ID' };
      const result = await request('nfc-card-transactions', 'GET', { card_id: cardId });
      if (!result.ok) return { ok: false, code: 'CARD_HISTORY_UNAVAILABLE' };
      const b = result.body, r = b.response;
      const list = [r?.transactions, r?.history, r?.data, r?.card_transactions, r, b.data?.transactions, b.data, b.transactions]
        .find(Array.isArray);
      const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/\d{13,19}/g, '').trim().slice(0, 80);
      const items = (list || []).slice(0, 50).filter((t) => t && typeof t === 'object').map((t) => ({
        id: str(t.id ?? t.reference ?? t.transaction_id),
        date: str(t.created_at ?? t.date ?? t.timestamp ?? t.transaction_date),
        type: str(t.type ?? t.action ?? t.event ?? t.transaction_type),
        description: str(t.description ?? t.narrative ?? t.merchant ?? t.merchant_name ?? t.reason),
        amount: str(t.amount ?? t.centAmount ?? ''), status: str(t.status), currency: str(t.currency ?? 'USD') }));
      return { ok: true, items, known: Array.isArray(list) };
    },
    async details(cardId, sensitive = false) {
      if (!validId(cardId)) return { ok: false, code: 'INVALID_CARD_ID' };
      const result = await request('fetch-nfccard-detail', 'GET', { card_id: cardId });
      return result.ok ? detail(result.body, cardId, sensitive) : { ok: false, code: 'CARD_DETAILS_UNVERIFIED' };
    }
  };
}

module.exports = { createCardProvider, validId };
