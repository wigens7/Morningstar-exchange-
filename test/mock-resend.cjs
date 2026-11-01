'use strict';

const fs = require('node:fs');
const realFetch = global.fetch;

global.fetch = async (url, options) => {
  if (String(url) !== 'https://api.resend.com/emails') return realFetch(url, options);
  if (process.env.MOCK_RESEND_FAIL === '1') {
    return { ok: false, status: 503, json: async () => ({ name: 'test_provider_error' }) };
  }
  if (process.env.RESEND_CAPTURE_FILE) {
    fs.appendFileSync(process.env.RESEND_CAPTURE_FILE, JSON.stringify(JSON.parse(options.body)) + '\n');
  }
  return { ok: true, status: 200, json: async () => ({ id: 'mock-email-id' }) };
};
