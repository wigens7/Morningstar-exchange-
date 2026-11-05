'use strict';
// Loaded explicitly by local tests only; never imports a real provider client.
const fs = require('node:fs');
let submitted;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://www.ziiropay.com') throw new Error('Test blocks external traffic');
  const countsFile = process.env.MOCK_KYC_CALLS_FILE;
  const counts = fs.existsSync(countsFile) ? JSON.parse(fs.readFileSync(countsFile, 'utf8')) : { submissions: 0, lookups: 0 };
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/api/bitvcard/cardkyc' && options.method === 'POST') {
    counts.submissions++;
    submitted = Object.fromEntries(url.searchParams);
    fs.writeFileSync(countsFile, JSON.stringify(counts));
    return json({ success: true, customer_id: 'must-not-bind-post-id' });
  }
  if (url.pathname === '/api/bitvcard/cardkycstatus' && options.method === 'GET') {
    counts.lookups++;
    fs.writeFileSync(countsFile, JSON.stringify(counts));
    if (!submitted) return json({ success: false });
    return json({ success: true, data: {
      ...Object.fromEntries(['first_name', 'last_name', 'email', 'phone_number', 'dial_code', 'country'].map((k) => [k, submitted[k]])),
      status: 'approved', customer_id: 'verified-provider-customer'
    } });
  }
  throw new Error('Test blocks unexpected provider endpoint');
};
