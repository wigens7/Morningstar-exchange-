'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
const source = html.slice(html.indexOf('let depNet ='), html.indexOf('async function doDep()'));
const escSource = html.match(/^const esc = .*$/m)[0];
function render(entry, commands = '') {
  const body = { innerHTML: '' };
  const context = vm.createContext({
    depInfos: [entry], depM: null,
    $: (id) => id === 'dep-body' ? body : null,
    logo: () => '<span></span>',
    t: (key) => key,
  });
  vm.runInContext(escSource + '\n' + source + `\ndepPick(${JSON.stringify(entry.method)});` + commands, context);
  return body.innerHTML;
}
test('dashboard inline JavaScript parses after deposit presentation changes', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) assert.doesNotThrow(() => new vm.Script(match[1]));
  }
});
test('account, beneficiary and instructions use the same semantic label/value component', () => {
  const out = render({ method: 'MonCash', currency: 'HTG', account: '50937000000', name: 'Nadia Pierre', note: 'Verifye enfòmasyon yo anvan ou peye.' });
  assert.equal((out.match(/class="dep-detail"/g) || []).length, 3);
  assert.equal((out.match(/<dt class="dep-label">/g) || []).length, 3);
  assert.equal((out.match(/<dd class="dep-value">/g) || []).length, 3);
  assert.equal((out.match(/class="dep-copy"/g) || []).length, 3);
  assert.ok(!out.includes('break-all'));
  for (const id of ['d-amount', 'd-ref']) assert.ok(out.includes(`for="${id}"`));
  assert.ok(out.includes('id="d-ack"'));
  assert.ok(out.includes('onclick="doDep()"'));
});
test('deposit details and copy attributes escape untrusted values without dropping text', () => {
  const malicious = `"><img src=x onerror="alert(1)"> & '`;
  const out = render({ method: 'MonCash', currency: 'HTG', account: malicious, name: malicious, note: malicious });
  assert.ok(!out.includes('<img src=x'));
  assert.ok(out.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(out.includes('data-copy="&quot;&gt;&lt;img'));
});
test('no-QR and missing optional-field behavior is preserved', () => {
  const out = render({ method: 'MonCash', currency: 'HTG', account: '12345678', name: '', note: '' });
  assert.equal((out.match(/class="dep-detail"/g) || []).length, 1);
  assert.ok(!out.includes('class="dep-modes"'));
  assert.ok(!out.includes('depQrError'));
});
test('QR mode keeps notes in the same detail component and requires a deposit declaration', () => {
  const out = render({ method: 'MonCash', currency: 'HTG', account: '12345678', name: 'Nadia Pierre', note: 'Verifye kont lan.', qr: { account: '/api/deposit-qr/MonCash/account/test.png' } }, `depSet('view','qr');`);
  assert.ok(out.includes('class="dep-qr-card"'));
  assert.ok(out.includes('class="dep-qr-image"'));
  assert.ok(out.includes('class="dep-detail"'));
  assert.ok(out.includes('id="d-ack"'));
  assert.ok(out.includes('aria-pressed="true"'));
  assert.ok(out.includes('id="dep-declaration-title"'));
});
test('deposit text colors meet WCAG AA normal-text contrast on their actual surfaces', () => {
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = html.match(new RegExp('(?:^|\\n)' + escaped + '\\{([^}]+)\\}'));
    assert.ok(match, 'Missing CSS rule: ' + selector);
    return match[1];
  };
  const property = (selector, name) => {
    const match = rule(selector).match(new RegExp('(?:^|;)' + name + ':(#[a-f0-9]{6})(?:;|$)', 'i'));
    assert.ok(match, 'Missing ' + name + ': ' + selector);
    return match[1];
  };
  const luminance = (hex) => {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const pairs = [
    ['.dep-label', '.dep-details'], ['.dep-value', '.dep-details'], ['.dep-copy', '.dep-details'],
    ['.dep-mode', '.dep-modes'], ['.dep-mode.is-active', '.dep-mode.is-active'],
    ['.dep-field-label', '#m-dep .sheet'], ['.dep-form-help', '#m-dep .sheet'],
    ['.dep-currency', '#m-dep .sheet'], ['.dep-ack', '.dep-ack'], ['.dep-change', '.dep-change']
  ];
  for (const [fg, bg] of pairs) {
    const a = luminance(property(fg, 'color')), b = luminance(property(bg, 'background'));
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    assert.ok(ratio >= 4.5, fg + ': contrast ' + ratio.toFixed(2));
  }
});
