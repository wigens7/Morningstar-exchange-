'use strict';

// One specifically approved sandbox-only KYC request. No customer/profile access,
// no card/money calls, no status lookup in the undocumented sandbox namespace.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FIELDS } = require('./ziiropay-kyc');
const URL_KYC = 'https://www.ziiropay.com/api/bitvcard/cardkyc';
const SAFE_KEYS = ['success', 'message', 'name', 'data', 'response', 'errors', 'error', 'status', 'code', 'customer_id', 'reference'];
// Valid generated 320x200 PNG reading TEST ONLY; not an identity document.
const TEST_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAACXklEQVR42u3cwRGDIBRFUfqvx9bc2wIID/16zmSVSQhRbhYZtJ1AWc0hAAEDAgYEDAIGBAwIGBAwCBgQMCBgEDAgYEDAgIBBwICAAQEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMAgYEDAgYEDAIGBAwIGBAwCBgQMCAgEHAgIABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIABAYOAAQEDAgYBAwIGBAwIGAQMCBgQMAgYEDAgYEDAIOBnHa3dfiTGmRkzPZ+dx7znvaOfNTNOej4CFrCABSxgAQtYwAIWsIAF/Jawd56Y9Al+agElwpsJXsACFrCABSxgAQtYwAIWsIAFLGABr/+OFaMVsIAFLGABC1jAAhawgAUs4N7Xr9oskdh08aWAE89X/6EUsIAFLGABC1jAAhawgAUs4Ep/YpnnfHijF3sIWMACFrCABWyeAhawMAQsYAELWMACFrB5CljAAjZPAQtYGAIWsIBHFk36ZnQVF9bbbmqX3oQjYAELWMACFrCABSxgAQtYwICAAQEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDAIGBAwIGBAwCBgQMCAgAEBg4ABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIABAYOAAQEDAgYBAwIGBAwIGAQMCBgQMCBgEDAgYEDAIGBAwICAAQGDgAEBAwIGBAwCBgQMCBgEDAgYEDAgYBAwIGBAwPBnF8oq5NNC51h3AAAAAElFTkSuQmCC';

function typeOf(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}
function shapeOf(body) {
  const result = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return result;
  for (const k of SAFE_KEYS) {
    if (!Object.hasOwn(body, k)) continue;
    result[k] = typeOf(body[k]);
    if (['data', 'response'].includes(k) && body[k] && typeof body[k] === 'object' && !Array.isArray(body[k])) {
      for (const nested of SAFE_KEYS) if (Object.hasOwn(body[k], nested)) result[k + '.' + nested] = typeOf(body[k][nested]);
    }
  }
  return result;
}

function fixture() {
  return {
    first_name: 'Sandbox', last_name: 'TestOnly',
    id_number: 'TESTONLY-NOT-A-REAL-DOCUMENT',
    email: 'morningstar-sandbox-' + crypto.randomUUID() + '@example.test',
    // Reserved North American fictional number, not a customer phone.
    phone_number: '12025550123', dial_code: '+1', country: 'USA',
    date_of_birth: '1990-01-01', id_front_image: TEST_IMAGE,
    line1: 'TEST ONLY - NOT A REAL RESIDENCE', state: 'Delaware',
    postal_code: '19801', city: 'Wilmington', id_type: 'passport',
    occupation: 'office_worker', employment_status: 'employed',
    account_purpose: 'Sandbox integration test only', annual_salary: '1000',
    expected_monthly_volume: '100', place_of_birth: 'Sandbox test fixture'
  };
}

async function sandboxRequest({ apiKey, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  const result = { mode: 'sandbox', requestCount: 1, httpStatus: null, successFlag: null, shape: {}, validationFields: [] };
  try {
    const url = new URL(URL_KYC);
    url.searchParams.set('public_key', apiKey);
    for (const [k, value] of Object.entries(fixture())) url.searchParams.set(k, value);
    // Cannot be overridden by any customer, environment mode, request or fixture.
    url.searchParams.set('mode', 'sandbox');
    const response = await fetchImpl(url.toString(), {
      method: 'POST', headers: { Accept: 'application/json' },
      redirect: 'error', cache: 'no-store', signal: controller.signal
    });
    result.httpStatus = response.status;
    if (!/application\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') || '') || !response.body) {
      if (response.body) await response.body.cancel().catch(() => {});
      return { ...result, code: response.status === 414 ? 'SANDBOX_URI_TOO_LONG' : 'SANDBOX_NON_JSON_RESPONSE' };
    }
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32768) { await reader.cancel().catch(() => {}); return { ...result, code: 'SANDBOX_RESPONSE_TOO_LARGE' }; }
      chunks.push(Buffer.from(part.value));
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return { ...result, code: 'SANDBOX_INVALID_JSON' }; }
    result.shape = shapeOf(body);
    result.successFlag = typeof body?.success === 'boolean' ? body.success : null;
    if (body?.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
      result.validationFields = FIELDS.filter((field) => Object.hasOwn(body.errors, field));
    }
    // No upstream text, URL, ID, key or arbitrary field name is returned/logged.
    let code;
    if ([401, 403].includes(response.status)) code = 'SANDBOX_AUTH_REJECTED';
    else if (response.status === 414) code = 'SANDBOX_URI_TOO_LONG';
    else if (response.status === 429) code = 'SANDBOX_RATE_LIMITED';
    else if (response.status >= 500) code = 'SANDBOX_UPSTREAM_ERROR';
    else if (result.validationFields.length) code = 'SANDBOX_VALIDATION_REJECTED';
    else if (!response.ok || body?.success === false) code = 'SANDBOX_REQUEST_REJECTED';
    else if (body?.success === true) code = 'SANDBOX_RESPONSE_SUCCESS_NOT_KYC_APPROVAL';
    else code = 'SANDBOX_RESPONSE_RECEIVED_UNVERIFIED';
    return { ...result, code };
  } catch {
    return { ...result, code: controller.signal.aborted ? 'SANDBOX_TIMEOUT_NO_RETRY' : 'SANDBOX_NETWORK_ERROR_NO_RETRY' };
  } finally {
    clearTimeout(timer);
    if (reader) reader.releaseLock();
  }
}

async function runSandboxKycProbe(options = {}) {
  if ((options.enabled ?? process.env.ZIIROPAY_SANDBOX_KYC_PROBE) !== 'approved-v1') return null;
  const log = options.log ?? console.info;
  const report = (result) => {
    try { log('[ziiropay-sandbox] ' + JSON.stringify(result)); } catch {}
    return result;
  };
  const dataDir = options.dataDir;
  const apiKey = String(options.apiKey ?? process.env.ZIIROPAY_API_KEY ?? '').trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!dataDir || !path.isAbsolute(dataDir)) return report({ code: 'SANDBOX_PERSISTENT_STORAGE_REQUIRED', requestCount: 0 });
  if (!apiKey || typeof fetchImpl !== 'function') return report({ code: 'SANDBOX_NOT_CONFIGURED', requestCount: 0 });
  const dir = path.join(dataDir, 'ziiropay-sandbox');
  const file = path.join(dir, 'kyc-attempt-v1.json');
  let fd, marked = false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') return report({ code: 'SANDBOX_ALREADY_ATTEMPTED_NO_RETRY', requestCount: 0 });
      throw e;
    }
    fs.writeFileSync(fd, JSON.stringify({ version: 1, phase: 'STARTED', mode: 'sandbox', startedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    const directory = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    marked = true;
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    // Even an incomplete marker is never removed or retried automatically.
    return report({ code: 'SANDBOX_STORAGE_ERROR_NO_REQUEST', requestCount: 0 });
  }
  if (!marked) return null;
  const result = await sandboxRequest({ apiKey, fetchImpl, timeoutMs: options.timeoutMs ?? 15000 });
  const record = { version: 1, phase: 'FINISHED', ...result, finishedAt: new Date().toISOString() };
  let temp;
  try {
    temp = file + '.tmp';
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const directory = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { if (temp) fs.unlinkSync(temp); } catch {}
    return report({ ...result, markerResultSaved: false });
  }
  return report({ ...result, markerResultSaved: true });
}

module.exports = { runSandboxKycProbe, shapeOf };
