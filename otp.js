'use strict';

const crypto = require('node:crypto');

const PURPOSES = new Set(['signup', 'email_verification', 'password_change', 'password_reset']);
const DEFAULTS = Object.freeze({
  ttlMs: 10 * 60 * 1000,
  cooldownMs: 60 * 1000,
  windowMs: 15 * 60 * 1000,
  maxRequests: 3,
  maxAttempts: 5
});

function digest(secret, userId, purpose, code) {
  return crypto.createHmac('sha256', secret)
    .update(`${userId}:${purpose}:${code}`)
    .digest('hex');
}

function equalDigest(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function issueOtp(user, purpose, secret, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const now = Number(config.now ?? Date.now());
  if (!user || !user.id || !PURPOSES.has(purpose) || typeof secret !== 'string' || !secret) {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }

  user.emailOtpLimits = user.emailOtpLimits || {};
  const recent = (user.emailOtpLimits[purpose] || []).filter((at) => now - at < config.windowMs);
  const last = recent[recent.length - 1];
  if (last !== undefined && now - last < config.cooldownMs) return { ok: false, reason: 'COOLDOWN' };
  if (recent.length >= config.maxRequests) return { ok: false, reason: 'RATE_LIMIT' };

  const randomInt = config.randomInt || crypto.randomInt;
  const value = randomInt(0, 1_000_000);
  const code = String(value).padStart(6, '0');
  const id = (config.randomUUID || crypto.randomUUID)();
  user.emailOtpLimits[purpose] = [...recent, now];
  user.emailOtpChallenges = user.emailOtpChallenges || {};
  user.emailOtpChallenges[purpose] = {
    id,
    digest: digest(secret, user.id, purpose, code),
    expiresAt: now + config.ttlMs,
    attempts: 0,
    sentAt: now
  };
  return { ok: true, code, id, expiresAt: now + config.ttlMs };
}

function verifyOtp(user, purpose, code, secret, options = {}) {
  const maxAttempts = Number(options.maxAttempts || DEFAULTS.maxAttempts);
  const now = Number(options.now ?? Date.now());
  if (!user || !PURPOSES.has(purpose) || typeof secret !== 'string' || !secret) {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }
  const challenge = user.emailOtpChallenges && user.emailOtpChallenges[purpose];
  if (!challenge) return { ok: false, reason: 'MISSING' };
  if (challenge.expiresAt <= now) {
    delete user.emailOtpChallenges[purpose];
    return { ok: false, reason: 'EXPIRED' };
  }
  if (challenge.attempts >= maxAttempts) return { ok: false, reason: 'LOCKED' };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) ||
      !equalDigest(challenge.digest, digest(secret, user.id, purpose, code))) {
    challenge.attempts += 1;
    return { ok: false, reason: challenge.attempts >= maxAttempts ? 'LOCKED' : 'INVALID' };
  }
  delete user.emailOtpChallenges[purpose];
  return { ok: true, id: challenge.id };
}

module.exports = { issueOtp, verifyOtp, DEFAULTS };
