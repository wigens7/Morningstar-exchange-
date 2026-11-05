'use strict';

// Official contracts: submit-card-kyc and get-kyc-status on ziiropay.readme.io.
// Never log request URLs: the documented query contains credentials and PII.
const BASE = 'https://www.ziiropay.com/api/bitvcard/';
const FIELDS = ['first_name', 'last_name', 'id_number', 'email', 'phone_number',
  'date_of_birth', 'dial_code', 'id_front_image', 'line1', 'state', 'postal_code',
  'city', 'country', 'id_type', 'occupation', 'employment_status', 'account_purpose',
  'annual_salary', 'expected_monthly_volume', 'place_of_birth'];

function createKycProvider(options = {}) {
  const apiKey = String(options.apiKey ?? process.env.ZIIROPAY_API_KEY ?? '').trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 12000;
  async function request(endpoint, method, fields) {
    if (!apiKey) return { ok: false, code: 'PROVIDER_NOT_CONFIGURED' };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let reader;
    try {
      const url = new URL(endpoint, BASE);
      url.searchParams.set('public_key', apiKey);
      for (const [k, v] of Object.entries(fields)) url.searchParams.set(k, v);
      // No mode parameter means live according to the KYC submission contract.
      // Sandbox lookup semantics are undocumented: this adapter is live-only
      // and its caller must explicitly gate activation; tests use fake fetch.
      const r = await fetchImpl(url.toString(), {
        method, headers: { Accept: 'application/json' }, signal: abort.signal,
        redirect: 'error', cache: 'no-store'
      });
      if (!r.ok || !/application\/(?:[\w.-]+\+)?json\b/i.test(r.headers.get('content-type') || '') || !r.body) {
        if (r.body) await r.body.cancel().catch(() => {});
        return { ok: false, code: 'PROVIDER_UNVERIFIED' };
      }
      reader = r.body.getReader();
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16384) { await reader.cancel().catch(() => {}); return { ok: false, code: 'PROVIDER_UNVERIFIED' }; }
        chunks.push(Buffer.from(part.value));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.success === false) return { ok: false, code: 'PROVIDER_UNVERIFIED' };
      // A successful POST is NOT KYC approval; never use its customer_id.
      if (method === 'POST') return { ok: true, code: 'SUBMISSION_RESPONSE_RECEIVED' };
      const d = body.data;
      if (body.success !== true || !d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, code: 'PROVIDER_UNVERIFIED' };
      if (d.status !== 'approved') return { ok: true, approved: false, code: 'NOT_APPROVED' };
      const names = ['first_name', 'last_name', 'email', 'phone_number', 'dial_code', 'country', 'customer_id'];
      if (names.some((k) => typeof d[k] !== 'string' || !d[k].trim() || d[k].length > 254) ||
          !/^[A-Za-z0-9_-]{6,128}$/.test(d.customer_id) || !/^\d{6,15}$/.test(d.phone_number) ||
          !/^\+[1-9]\d{0,3}$/.test(d.dial_code) || !/^[A-Z]{3}$/.test(d.country)) return { ok: false, code: 'PROVIDER_UNVERIFIED' };
      return { ok: true, approved: true, identity: Object.fromEntries(names.map((k) => [k, d[k]])) };
    } catch {
      return { ok: false, code: abort.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNVERIFIED' };
    } finally {
      clearTimeout(timer);
      if (reader) reader.releaseLock();
    }
  }
  return {
    configured: Boolean(apiKey),
    submit(payload) {
      if (Object.keys(payload).some((k) => !FIELDS.includes(k)) || FIELDS.some((k) => typeof payload[k] !== 'string' || !payload[k])) {
        return Promise.resolve({ ok: false, code: 'INVALID_PROVIDER_PAYLOAD' });
      }
      return request('cardkyc', 'POST', payload);
    },
    lookup(email) { return request('cardkycstatus', 'GET', { email }); }
  };
}

module.exports = { createKycProvider, FIELDS };
