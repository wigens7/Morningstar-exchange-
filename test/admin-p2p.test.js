'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('admin P2P script is present and wired to the page route', () => {
  const asset = path.join(root, 'admin-p2p.js');
  assert.ok(fs.existsSync(asset), 'admin P2P asset must exist in the app root');
  const page = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const source = fs.readFileSync(asset, 'utf8');
  assert.ok(page.includes('<script src="/admin-p2p.js"></script>'));
  assert.ok(server.includes("app.get('/admin-p2p.js', page('admin-p2p.js'))"));
  assert.ok(source.includes('window.loadP2P = async function'));
});
