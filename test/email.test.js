'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResendClient } = require('../resend');
const { issueOtp, verifyOtp } = require('../otp');
const { noticeEmail, otpEmail } = require('../email-templates');
const { createService } = require('../p2p/service');

test('Resend client uses server credentials, text/html and an idempotency key', async () => {
  let request;
  const client = createResendClient({
    apiKey: 'test-only-key',
    from: 'Morningstar Exchange <noreply@morningstarechanj.com>',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ id: 'email-test-id' }) };
    }
  });

  const result = await client.send({
    to: 'customer@example.com',
    subject: 'Security code',
    html: '<p>Code</p>',
    text: 'Code',
    idempotencyKey: 'otp:signup:user-1:challenge-1'
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, 'email-test-id');
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-only-key');
  assert.equal(request.options.headers['Idempotency-Key'], 'otp:signup:user-1:challenge-1');
  assert.equal(request.body.from, 'Morningstar Exchange <noreply@morningstarechanj.com>');
  assert.deepEqual(request.body.to, ['customer@example.com']);
  assert.equal(request.body.text, 'Code');
});

test('Resend failures return sanitized codes and never expose response text', async () => {
  const client = createResendClient({
    apiKey: 'test-only-key',
    from: 'Morningstar Exchange <noreply@morningstarechanj.com>',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ name: 'restricted_api_key', message: 'private provider response' })
    })
  });
  const result = await client.send({ to: 'customer@example.com', subject: 'Test', text: 'Test' });
  assert.deepEqual(result, { ok: false, code: 'restricted_api_key', status: 403 });
  assert.equal(JSON.stringify(result).includes('private provider response'), false);
});

test('Resend client fails closed when variables are missing and does not call fetch', async () => {
  let called = false;
  const client = createResendClient({ apiKey: '', from: '', fetchImpl: async () => { called = true; } });
  const result = await client.send({ to: 'customer@example.com', subject: 'Test', text: 'Test' });
  assert.deepEqual(result, { ok: false, code: 'RESEND_NOT_CONFIGURED' });
  assert.equal(called, false);
});

test('Resend client handles network errors without exposing exception details', async () => {
  const client = createResendClient({
    apiKey: 'test-only-key',
    from: 'Morningstar Exchange <noreply@morningstarechanj.com>',
    fetchImpl: async () => { throw new Error('private request details'); }
  });
  const result = await client.send({ to: 'customer@example.com', subject: 'Test', text: 'Test' });
  assert.deepEqual(result, { ok: false, code: 'NETWORK_ERROR' });
});

test('OTP storage is hashed, expires, and can only be consumed once', () => {
  const user = { id: 'user-1' };
  const secret = 'test-secret';
  const issued = issueOtp(user, 'signup', secret, {
    now: 1_000,
    randomInt: () => 42,
    randomUUID: () => 'challenge-1'
  });
  assert.equal(issued.ok, true);
  assert.equal(issued.code, '000042');
  assert.notEqual(user.emailOtpChallenges.signup.digest, issued.code);

  assert.deepEqual(verifyOtp(user, 'signup', issued.code, secret, { now: 2_000 }), {
    ok: true,
    id: 'challenge-1'
  });
  assert.deepEqual(verifyOtp(user, 'signup', issued.code, secret, { now: 2_001 }), {
    ok: false,
    reason: 'MISSING'
  });
});

test('OTP expiry and failed attempts are enforced', () => {
  const user = { id: 'user-2' };
  const secret = 'test-secret';
  const issued = issueOtp(user, 'password_change', secret, {
    now: 1_000,
    randomInt: () => 7,
    randomUUID: () => 'challenge-2'
  });
  assert.equal(verifyOtp(user, 'password_change', issued.code, secret, { now: 601_001 }).reason, 'EXPIRED');

  issueOtp(user, 'password_change', secret, {
    now: 700_000,
    randomInt: () => 8,
    randomUUID: () => 'challenge-3'
  });
  for (let i = 0; i < 4; i++) {
    assert.equal(verifyOtp(user, 'password_change', '999999', secret, { now: 700_001 }).reason, 'INVALID');
  }
  assert.equal(verifyOtp(user, 'password_change', '999999', secret, { now: 700_002 }).reason, 'LOCKED');
  assert.equal(verifyOtp(user, 'password_change', '000008', secret, { now: 700_003 }).reason, 'LOCKED');
});

test('OTP cooldown and rolling request limit are enforced', () => {
  const user = { id: 'user-3' };
  const secret = 'test-secret';
  const deterministic = {
    randomInt: () => 123,
    randomUUID: () => 'challenge'
  };
  assert.equal(issueOtp(user, 'email_verification', secret, { now: 0, ...deterministic }).ok, true);
  assert.equal(issueOtp(user, 'email_verification', secret, { now: 30_000, ...deterministic }).reason, 'COOLDOWN');
  assert.equal(issueOtp(user, 'email_verification', secret, { now: 61_000, ...deterministic }).ok, true);
  assert.equal(issueOtp(user, 'email_verification', secret, { now: 122_000, ...deterministic }).ok, true);
  assert.equal(issueOtp(user, 'email_verification', secret, { now: 183_000, ...deterministic }).reason, 'RATE_LIMIT');
});

test('email templates escape content and include plain-text and brand footer', () => {
  const otp = otpEmail({ code: '123456', purpose: 'signup', locale: 'ht' });
  assert.match(otp.subject, /Morningstar|imèl/iu);
  assert.match(otp.html, /Morningstar Exchange/);
  assert.match(otp.text, /123456/);

  const notice = noticeEmail({
    title: '<unsafe title>',
    summary: '<script>alert(1)</script>',
    details: [{ label: 'Order', value: '<img src=x>' }],
    locale: 'ht',
    occurredAt: '2026-11-01T00:00:00.000Z'
  });
  assert.equal(notice.html.includes('<script>alert(1)</script>'), false);
  assert.equal(notice.html.includes('<img src=x>'), false);
  assert.match(notice.html, /&lt;unsafe title&gt;/);
  assert.match(notice.text, /Morningstar Exchange/);
});

test('P2P email outbox deduplicates events and retries independently', () => {
  let now = 10_000;
  const service = createService({ now: () => now });
  try {
    const recipients = [{ type: 'user', id: 'buyer-1' }, { type: 'admin' }];
    assert.equal(service.enqueueNotification('event-1', 'P2P_ORDER_CREATED', recipients, { orderRef: '12345678' }), 2);
    assert.equal(service.enqueueNotification('event-1', 'P2P_ORDER_CREATED', recipients, { orderRef: '12345678' }), 0);
    assert.equal(service.pendingEmailNotifications().length, 2);

    const job = service.pendingEmailNotifications()[0];
    const retried = service.retryEmailNotification(job.id, 'NETWORK_ERROR');
    assert.equal(retried.updated, true);
    assert.equal(retried.failed, false);
    assert.equal(service.pendingEmailNotifications().length, 1);

    now += 31_000;
    assert.equal(service.pendingEmailNotifications().length, 2);
    assert.equal(service.markEmailNotificationSent(job.id), true);
    assert.equal(service.markEmailNotificationSent(job.id), false);
    assert.equal(service.pendingEmailNotifications().length, 1);
  } finally {
    service.close();
  }
});
