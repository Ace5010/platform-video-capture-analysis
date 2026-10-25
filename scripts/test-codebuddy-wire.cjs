'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Tests the CommonJS preload boundary without network. */
// Simulate HTTPS at the actual process-local bridge boundary. Zero network.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const https = require('node:https');
const realRequest = https.request;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-buddy-wire-'));
const video = Buffer.from('the complete source bytes including the final byte!');
const videoPath = path.join(directory, 'video.mp4');
fs.writeFileSync(videoPath, video);
const sha256 = crypto.createHash('sha256').update(video).digest('hex');
const auditPath = path.join(directory, 'audit.jsonl');
const manifestPath = path.join(directory, 'manifest.json');
const marker = 'OBSERVE_TEST_ATTACHMENT';
fs.writeFileSync(manifestPath, JSON.stringify({ marker, videoPath, sha256, auditPath, model: 'minimax-m3' }));
const shim = require.resolve('./codebuddy-video-wire.cjs');

function install() {
  https.request = options => {
    const req = new EventEmitter();
    const headers = { host: 'copilot.tencent.com', authorization: 'private-test-token', ...options.headers };
    req.path = '/v2/chat/completions';
    req.sent = [];
    req.getHeader = key => headers[key];
    req.setHeader = (key, value) => { headers[key] = value; };
    req.removeHeader = key => { delete headers[key]; };
    req.write = chunk => { req.sent.push(chunk); return true; };
    req.end = callback => { req.ended = true; callback?.(); return req; };
    req.destroy = error => { req.error = error; };
    req.headers = headers;
    return req;
  };
  process.env.OBSERVE_BUDDY_VIDEO_MANIFEST = manifestPath;
  delete require.cache[shim];
  require(shim);
}
try {
  for (const compressed of [false, true]) {
    install();
    const original = { model: 'minimax-m3', messages: [{ role: 'user', content: '请分析\n' + marker }], stream: true };
    const raw = Buffer.from(JSON.stringify(original));
    const req = https.request({ headers: compressed ? { 'content-encoding': 'gzip' } : {} });
    req.write(compressed ? zlib.gzipSync(raw) : raw);
    req.end();
    assert.ok(!req.error, req.error?.message);
    const sent = Buffer.concat(req.sent);
    const request = JSON.parse(compressed ? zlib.gunzipSync(sent) : sent);
    const part = request.messages[0].content.find(p => p.type === 'video_url');
    assert.deepEqual(Buffer.from(part.video_url.url.split(',')[1], 'base64'), video);
    assert.equal(req.headers.authorization, 'private-test-token');
    assert.equal(req.headers['content-length'], sent.length);
    const response = new EventEmitter(); response.statusCode = 429;
    req.emit('response', response); response.emit('data', Buffer.from('{"error":{"code":14019}}')); response.emit('end');
    const repeated = https.request({}); repeated.end(raw);
    assert.match(repeated.error.message, /resubmission/);
    assert.equal(repeated.sent.length, 0);
  }
  install();
  const missing = https.request({}); missing.end(JSON.stringify({ messages: [] }));
  assert.match(missing.error.message, /marker missing/);
  assert.equal(missing.sent.length, 0);
  const audit = fs.readFileSync(auditPath, 'utf8');
  assert.ok(audit.includes('14019') && audit.includes(sha256));
  assert.ok(!audit.includes('private-test-token') && !audit.includes(video.toString('base64')));
  console.log('CodeBuddy wire passed: full source bytes, gzip/length, unchanged auth, explicit quota response, no duplicate submit, missing input rejection and redacted audit.');
} finally {
  https.request = realRequest;
  delete process.env.OBSERVE_BUDDY_VIDEO_MANIFEST;
  // The path is the exact directory returned by mkdtemp above.
  fs.rmSync(directory, { recursive: true, force: true });
}
