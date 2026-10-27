'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- isolated CLI preloader. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');
const zlib = require('node:zlib');

function attachImages(request, manifest) {
  if (request.model !== manifest.model) throw new Error('Unexpected image model');
  const evidence = [];
  for (const asset of manifest.images) {
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(asset.mime)) throw new Error('Unsupported image type');
    const data = fs.readFileSync(asset.path);
    if (crypto.createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error('Image changed before submission');
    let count = 0;
    for (const message of request.messages || []) {
      if (message.role !== 'user') continue;
      const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      if (!Array.isArray(parts)) continue;
      message.content = parts.flatMap(part => {
        if (part.type !== 'text' || !part.text?.includes(asset.marker)) return [part];
        const pieces = part.text.split(asset.marker);
        if (pieces.length !== 2) throw new Error('Ambiguous image marker');
        count++;
        return [{ type: 'text', text: pieces[0] },
          { type: 'image_url', image_url: { url: `data:${asset.mime};base64,${data.toString('base64')}` } },
          { type: 'text', text: pieces[1] || '\n' }];
      });
    }
    if (count !== 1) throw new Error('Required image missing from request');
    evidence.push({ sha256: asset.sha256, bytes: data.length });
  }
  const body = Buffer.from(JSON.stringify(request));
  if (body.length > 64 * 1024 * 1024) throw new Error('Image request exceeds input budget');
  return { body, evidence };
}

module.exports = { attachImages };

if (process.env.OBSERVE_BUDDY_IMAGE_MANIFEST) {
  const manifest = JSON.parse(fs.readFileSync(process.env.OBSERVE_BUDDY_IMAGE_MANIFEST, 'utf8'));
  const original = https.request;
  const trusted = new Set(['www.codebuddy.cn', 'copilot.tencent.com']);
  let submitted = false;
  const audit = value => fs.appendFileSync(manifest.auditPath, JSON.stringify(value) + '\n', { mode: 0o600 });
  https.request = function (...args) {
    const req = original.apply(this, args);
    const endpoint = req.path.split('?')[0] === '/v2/chat/completions';
    if (!endpoint) return req;
    if (!trusted.has(String(req.getHeader('host') || '').split(':')[0].toLowerCase())) {
      req.destroy(new Error('Untrusted image destination')); return req;
    }
    const write = req.write.bind(req), end = req.end.bind(req);
    const chunks = [];
    let size = 0;
    req.write = function (chunk, encoding, callback) {
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      size += data.length;
      if (size > 64 * 1024 * 1024) { req.destroy(new Error('Image input budget exceeded')); return false; }
      chunks.push(data);
      if (callback) process.nextTick(callback);
      return true;
    };
    req.end = function (chunk, encoding, callback) {
      if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      if (chunk != null) req.write(chunk, encoding);
      try {
        if (submitted) throw new Error('Automatic image resubmission disabled');
        const compressed = req.getHeader('content-encoding') === 'gzip';
        const incoming = Buffer.concat(chunks);
        const request = JSON.parse((compressed ? zlib.gunzipSync(incoming) : incoming).toString('utf8'));
        const attached = attachImages(request, manifest);
        const body = compressed ? zlib.gzipSync(attached.body) : attached.body;
        req.removeHeader('content-length'); req.setHeader('content-length', body.length);
        audit({ type: 'image_request', model: request.model, images: attached.evidence, wireBytes: body.length });
        submitted = true;
        req.once('response', response => audit({ type: 'image_response', status: response.statusCode }));
        write(body); return end(callback);
      } catch (error) {
        audit({ type: 'image_blocked', reason: error.message }); req.destroy(error); return req;
      }
    };
    return req;
  };
}
