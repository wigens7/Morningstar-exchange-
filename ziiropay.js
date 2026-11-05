'use strict';

// Official reference: https://ziiropay.readme.io/reference/get-main-balance
// This first stage is deliberately read-only. No card issuance, KYC upload,
// wallet debit/credit, webhook acceptance or provider write is implemented here.
const BALANCE_URL = 'https://www.ziiropay.com/api/wallet/balance/USD';
const MAX_RESPONSE_BYTES = 8192;

function createZiiroPayClient(options = {}) {
  const apiKey = String(options.apiKey ?? process.env.ZIIROPAY_API_KEY ?? '').trim();
  const webhookSecret = String(options.webhookSecret ?? process.env.ZIIROPAY_WEBHOOK_SECRET ?? '').trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 12000;
  const now = options.now ?? Date.now;
  let inflight = null, cached = null;

  function readiness() {
    return {
      apiKeyConfigured: Boolean(apiKey),
      webhookSecretConfigured: Boolean(webhookSecret),
      connectionVerified: Boolean(cached && cached.expiresAt > now() && cached.result.connected),
      cardOperationsEnabled: false,
      webhookVerificationReady: false,
      stage: 'read_only_connection_check'
    };
  }

  async function probe() {
    const checkedAt = new Date(now()).toISOString();
    const failure = (code, httpStatus = null) => ({ connected: false, code, httpStatus, checkedAt });
    if (!apiKey || typeof fetchImpl !== 'function') return failure('ZIIROPAY_NOT_CONFIGURED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader;
    try {
      // The reference specifies public_key in the query. It never goes to the
      // browser. Do not log this URL, upstream errors, response bodies or balance.
      const url = new URL(BALANCE_URL);
      url.searchParams.set('public_key', apiKey);
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) {
        if (response.body) await response.body.cancel().catch(() => {});
        const code = response.status === 401 || response.status === 403
          ? 'ZIIROPAY_AUTH_REJECTED' : response.status === 429
            ? 'ZIIROPAY_RATE_LIMITED' : 'ZIIROPAY_HTTP_ERROR';
        return failure(code, response.status);
      }
      if (!/application\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) {
        if (response.body) await response.body.cancel().catch(() => {});
        return failure('ZIIROPAY_UNEXPECTED_RESPONSE', response.status);
      }
      if (!response.body) return failure('ZIIROPAY_UNEXPECTED_RESPONSE', response.status);
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          return failure('ZIIROPAY_RESPONSE_TOO_LARGE', response.status);
        }
        chunks.push(Buffer.from(value));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return failure('ZIIROPAY_UNEXPECTED_RESPONSE', response.status); }
      // A 200, redirect/login page or success:true alone is not authentication
      // proof. Validate the exact documented balance shape, then discard it.
      if (!body || Array.isArray(body) || body.success === false ||
          typeof body.balance !== 'string' || !/^\d{1,15}(?:\.\d{1,8})?$/.test(body.balance)) {
        return failure('ZIIROPAY_UNEXPECTED_RESPONSE', response.status);
      }
      return { connected: true, code: 'ZIIROPAY_CONNECTION_VERIFIED', httpStatus: response.status, checkedAt };
    } catch {
      // Never propagate provider text, URL, key, balance or exception cause.
      return failure(controller.signal.aborted ? 'ZIIROPAY_TIMEOUT' : 'ZIIROPAY_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      if (reader) reader.releaseLock();
    }
  }

  async function checkConnection() {
    if (cached && cached.expiresAt > now()) return { ...cached.result, cached: true };
    if (!inflight) inflight = probe().then((result) => {
      cached = { result, expiresAt: now() + 60000 };
      return result;
    }).finally(() => { inflight = null; });
    return { ...await inflight, cached: false };
  }
  return { readiness, checkConnection };
}

function mountZiiroPayDiagnostics(app, { adminOnly, rateLimit, client = createZiiroPayClient(), issuanceEnabled = false }) {
  // No public or customer endpoint exposes configuration or merchant balances.
  app.get('/api/admin/virtual-cards/readiness', adminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(issuanceEnabled ? { ...client.readiness(), cardOperationsEnabled: true, cardIssuanceEnabled: true,
      cardFundingEnabled: false, cardWithdrawalEnabled: false, stage: 'card_issuance_opt_in' } : client.readiness());
  });
  app.post('/api/admin/virtual-cards/connection-test', adminOnly, (req, res, next) => {
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'Demann lan pa otorize.' });
    }
    next();
  }, rateLimit(5, 15 * 60 * 1000), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await client.checkConnection();
      res.status(result.connected ? 200 : 503).json(result);
    } catch {
      res.status(503).json({ connected: false, code: 'ZIIROPAY_CHECK_FAILED' });
    }
  });
}

async function runZiiroPayStartupCheck(client, options = {}) {
  // Explicit deployment opt-in only; off by default. This enables an approved
  // read-only verification inside Railway without extracting credentials.
  if ((options.enabled ?? process.env.ZIIROPAY_CONNECTION_CHECK_ON_BOOT) !== 'true') return null;
  const log = options.log ?? console.info;
  try {
    const result = await client.checkConnection();
    const codes = new Set([
      'ZIIROPAY_CONNECTION_VERIFIED', 'ZIIROPAY_NOT_CONFIGURED', 'ZIIROPAY_AUTH_REJECTED',
      'ZIIROPAY_RATE_LIMITED', 'ZIIROPAY_HTTP_ERROR', 'ZIIROPAY_UNEXPECTED_RESPONSE',
      'ZIIROPAY_RESPONSE_TOO_LARGE', 'ZIIROPAY_TIMEOUT', 'ZIIROPAY_NETWORK_ERROR'
    ]);
    const code = codes.has(result.code) ? result.code : 'ZIIROPAY_CHECK_FAILED';
    log('[ziiropay] connection-check ' + code);
    return { code };
  } catch {
    log('[ziiropay] connection-check ZIIROPAY_CHECK_FAILED');
    return { code: 'ZIIROPAY_CHECK_FAILED' };
  }
}

module.exports = { createZiiroPayClient, mountZiiroPayDiagnostics, runZiiroPayStartupCheck };
