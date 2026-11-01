'use strict';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorCode(body, status) {
  const candidate = body && (
    body.name ||
    body.code ||
    (body.error && (body.error.name || body.error.code))
  );
  return typeof candidate === 'string' && /^[a-z0-9_-]{1,64}$/i.test(candidate)
    ? candidate
    : `HTTP_${Number(status) || 0}`;
}

function createResendClient(options = {}) {
  const apiKey = options.apiKey ?? process.env.RESEND_API_KEY ?? '';
  const from = options.from ?? process.env.RESEND_FROM_EMAIL ?? '';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    configured: Boolean(apiKey.trim() && from.trim() && typeof fetchImpl === 'function'),

    async send({ to, subject, html, text, idempotencyKey } = {}) {
      const recipient = Array.isArray(to) ? to : [to];
      if (!recipient.length || recipient.some((value) => typeof value !== 'string' || !EMAIL_RE.test(value))) {
        return { ok: false, code: 'INVALID_RECIPIENT' };
      }
      if (typeof subject !== 'string' || !subject.trim() || (!html && !text)) {
        return { ok: false, code: 'INVALID_EMAIL_PAYLOAD' };
      }
      if (idempotencyKey !== undefined &&
          (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 256)) {
        return { ok: false, code: 'INVALID_IDEMPOTENCY_KEY' };
      }
      if (!apiKey.trim() || !from.trim() || typeof fetchImpl !== 'function') {
        return { ok: false, code: 'RESEND_NOT_CONFIGURED' };
      }

      const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      };
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

      let response;
      try {
        response = await fetchImpl(RESEND_EMAILS_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            from,
            to: recipient,
            subject: subject.trim(),
            ...(html ? { html } : {}),
            ...(text ? { text } : {})
          })
        });
      } catch {
        return { ok: false, code: 'NETWORK_ERROR' };
      }

      let body = {};
      try { body = await response.json(); } catch { /* provider response may have no JSON body */ }
      if (!response.ok) {
        return { ok: false, code: errorCode(body, response.status), status: response.status };
      }
      return {
        ok: true,
        id: typeof body.id === 'string' ? body.id : null,
        status: response.status
      };
    }
  };
}

module.exports = { createResendClient, RESEND_EMAILS_URL };
