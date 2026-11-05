'use strict';

const { usdToCents } = require('./virtual-card-setup');
const BASE = 'https://www.ziiropay.com/api/bitvcard/';
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(id);
const safeName = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && !/[\x00-\x1f<>]/.test(v);

function createCardProvider(options = {}) {
  const apiKey = options.apiKey ?? process.env.ZIIROPAY_API_KEY ?? '';
  const mode = options.mode ?? process.env.ZIIROPAY_CARD_MODE ?? 'sandbox';
  const fetchImpl = options.fetchImpl || fetch;
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
      const hasCardHint = [body.card_id, body.cardId, body.data?.card_id, body.response?.card_id,
        body.response?.card_detail?.card_id].some(validId) || Boolean(body.response?.card_detail) ||
        ['active', 'complete', 'completed', 'success'].includes(body.status);
      const validationRejected = r.status === 422 && body.errors && typeof body.errors === 'object' &&
        !Array.isArray(body.errors) && Object.keys(body.errors).length > 0;
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
        !['active', 'frozen', 'terminated'].includes(d.card_status)) return { ok: false, code: 'CARD_DETAILS_UNVERIFIED' };
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
    async details(cardId, sensitive = false) {
      if (!validId(cardId)) return { ok: false, code: 'INVALID_CARD_ID' };
      const result = await request('fetch-nfccard-detail', 'GET', { card_id: cardId });
      return result.ok ? detail(result.body, cardId, sensitive) : { ok: false, code: 'CARD_DETAILS_UNVERIFIED' };
    }
  };
}

module.exports = { createCardProvider, validId };
