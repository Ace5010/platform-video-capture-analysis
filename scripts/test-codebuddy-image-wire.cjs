'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- tests the CLI preloader. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const https = require('node:https');
const original = https.request;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-image-wire-'));
const auditPath = path.join(directory, 'audit.jsonl');
const manifestPath = path.join(directory, 'manifest.json');
const images = [1, 2].map(n => {
  const data = Buffer.from(`complete-image-${n}`), file = path.join(directory, `image-${n}`);
  fs.writeFileSync(file, data);
  return { marker: `TEST_IMAGE_${n}`, path: file, mime: n === 1 ? 'image/png' : 'image/gif',
    sha256: crypto.createHash('sha256').update(data).digest('hex') };
});
fs.writeFileSync(manifestPath, JSON.stringify({ model: 'fixture', images, auditPath }));
const shim = require.resolve('./codebuddy-image-wire.cjs');
function install() {
  https.request = options => {
    const req = new EventEmitter();
    const headers = { host: 'copilot.tencent.com', authorization: 'private-token', ...options.headers };
    req.path = '/v2/chat/completions'; req.sent = [];
    req.getHeader = key => headers[key]; req.setHeader = (key, value) => { headers[key] = value; };
    req.removeHeader = key => { delete headers[key]; };
    req.write = data => { req.sent.push(data); return true; };
    req.end = callback => { req.ended = true; callback?.(); return req; };
    req.destroy = error => { req.error = error; };
    req.headers = headers; return req;
  };
  process.env.OBSERVE_BUDDY_IMAGE_MANIFEST = manifestPath;
  delete require.cache[shim]; require(shim);
}
const payload = text => ({ model: 'fixture', messages: [{ role: 'system', content: 'unchanged' },
  { role: 'user', content: text }] });
try {
  for (const compressed of [false, true]) {
    install();
    const req = https.request({ headers: compressed ? { 'content-encoding': 'gzip' } : {} });
    const input = Buffer.from(JSON.stringify(payload('message m0001 TEST_IMAGE_1\nmessage m0002 TEST_IMAGE_2')));
    req.end(compressed ? zlib.gzipSync(input) : input);
    assert.equal(req.error, undefined); assert.equal(req.ended, true);
    const body = Buffer.concat(req.sent);
    const sent = JSON.parse((compressed ? zlib.gunzipSync(body) : body).toString());
    assert.equal(sent.messages[0].content, 'unchanged');
    const parts = sent.messages[1].content.filter(p => p.type === 'image_url');
    assert.equal(parts.length, 2);
    for (const [index, part] of parts.entries()) {
      assert.equal(Buffer.from(part.image_url.url.split(',')[1], 'base64').toString(), `complete-image-${index + 1}`);
    }
    assert.equal(req.headers.authorization, 'private-token');
    req.emit('response', { statusCode: 200 });
    const retry = https.request({}); retry.end(input);
    assert.match(retry.error.message, /resubmission/); assert.equal(retry.sent.length, 0);
  }
  for (const text of ['only TEST_IMAGE_1', 'TEST_IMAGE_1 TEST_IMAGE_1 TEST_IMAGE_2']) {
    install(); const req = https.request({}); req.end(JSON.stringify(payload(text)));
    assert.ok(req.error); assert.equal(req.sent.length, 0);
  }
  install(); const wrong = https.request({ headers: { host: 'example.invalid' } });
  assert.match(wrong.error.message, /Untrusted/);
  fs.writeFileSync(images[0].path, 'changed');
  install(); const changed = https.request({}); changed.end(JSON.stringify(payload('TEST_IMAGE_1 TEST_IMAGE_2')));
  assert.match(changed.error.message, /changed/); assert.equal(changed.sent.length, 0);
  const audit = fs.readFileSync(auditPath, 'utf8');
  assert.ok(!audit.includes('private-token')); assert.ok(!audit.includes('base64,'));
  assert.ok(!audit.includes(directory));
  process.stdout.write('CodeBuddy image wire: complete bytes, associations, gzip, integrity, no silent omission/retry passed.\n');
} finally {
  https.request = original; delete process.env.OBSERVE_BUDDY_IMAGE_MANIFEST;
  fs.rmSync(directory, { recursive: true, force: true });
}
