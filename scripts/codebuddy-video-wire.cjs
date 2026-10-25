'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloader must use CommonJS. */
// Process-local bridge for CodeBuddy's text CLI. Keep its login, model routing,
// TLS destination and billing headers; replace only our one-time attachment
// marker in the outgoing JSON with a complete native video_url content part.
// Never print or persist headers, credentials, source URLs, or inline video.
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const manifestPath = process.env.OBSERVE_BUDDY_VIDEO_MANIFEST;
if (manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const originalRequest = https.request;
  const trusted = new Set(['www.codebuddy.cn', 'copilot.tencent.com']);
  const audit = value => fs.appendFileSync(manifest.auditPath, JSON.stringify(value) + '\n', { mode: 0o600 });
  let submitted = 0;
  https.request = function (...args) {
    const req = originalRequest.apply(this, args);
    const host = String(req.getHeader('host') || '').split(':')[0].toLowerCase();
    if (!trusted.has(host)) {
      if (req.path.split('?')[0] === '/v2/chat/completions') req.destroy(new Error('Untrusted video model destination'));
      return req;
    }
    const write = req.write.bind(req), end = req.end.bind(req);
    const chunks = [];
    let bytes = 0;
    req.write = function (chunk, encoding, callback) {
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      bytes += data.length;
      if (bytes > 64 * 1024 * 1024) { req.destroy(new Error('CodeBuddy request exceeded bridge size limit')); return false; }
      chunks.push(data);
      if (callback) process.nextTick(callback);
      return true;
    };
    req.end = function (chunk, encoding, callback) {
      if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      if (chunk != null) req.write(chunk, encoding);
      let body = Buffer.concat(chunks);
      try {
        const compressed = req.getHeader('content-encoding') === 'gzip';
        const raw = compressed ? zlib.gunzipSync(body) : body;
        if (req.path.split('?')[0] === '/v2/chat/completions' && !raw.includes(Buffer.from(manifest.marker))) {
          throw new Error('Attachment marker missing from model request; submission stopped');
        }
        if (raw.includes(Buffer.from(manifest.marker))) {
          const request = JSON.parse(raw.toString('utf8'));
          if (manifest.model && request.model !== manifest.model) throw new Error('Unexpected model in video request');
          if (submitted) throw new Error('Automatic resubmission of full video is disabled');
          let replacements = 0;
          const video = manifest.videoPath ? fs.readFileSync(manifest.videoPath) : null;
          const sha256 = video ? crypto.createHash('sha256').update(video).digest('hex') : null;
          if (video && sha256 !== manifest.sha256) throw new Error('Video hash changed before submission');
          for (const message of request.messages || []) {
            if (message.role !== 'user') continue;
            const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
            if (!Array.isArray(parts)) continue;
            message.content = parts.flatMap(part => {
              if (part.type !== 'text' || !part.text?.includes(manifest.marker)) return [part];
              const pieces = part.text.split(manifest.marker);
              if (pieces.length !== 2) throw new Error('Video attachment marker is ambiguous');
              replacements++;
              return [
                { type: 'text', text: pieces[0] },
                ...(video ? [{ type: 'video_url', video_url: { url: process.env.OBSERVE_BUDDY_VIDEO_URL || 'data:video/mp4;base64,' + video.toString('base64') } }] : []),
                { type: 'text', text: pieces[1] || '请分析以上完整视频。' },
              ];
            });
          }
          if (replacements !== 1) throw new Error('Full video attachment could not be inserted exactly once');
          const changed = Buffer.from(JSON.stringify(request));
          if (changed.length > 64 * 1024 * 1024) throw new Error('Native video request exceeded 64 MiB bridge limit');
          body = compressed ? zlib.gzipSync(changed) : changed;
          req.removeHeader('content-length');
          req.setHeader('content-length', body.length);
          audit({ type: video ? 'video_request' : 'text_request', host, path: req.path.split('?')[0], model: request.model,
            videoBytes: video?.length || 0, videoSha256: sha256, wireBytes: body.length,
            contentTypes: request.messages.flatMap(m => Array.isArray(m.content) ? m.content.map(p => p.type) : ['text']) });
          submitted++;
          req.once('response', response => {
            const status = response.statusCode;
            if (status >= 200 && status < 300) { audit({ type: 'video_response', status }); return; }
            let errorBody = '';
            response.on('data', data => { if (errorBody.length < 65536) errorBody += data; });
            response.once('end', () => {
              const codes = [];
              const collect = obj => {
                if (!obj || typeof obj !== 'object') return;
                for (const [key, value] of Object.entries(obj)) {
                  if (/^(code|error_code|errorCode|status_code)$/.test(key) && /^\d{4,5}$/.test(String(value))) codes.push(Number(value));
                  else if (value && typeof value === 'object') collect(value);
                }
              };
              try { collect(JSON.parse(errorBody)); } catch { /* Never log opaque provider bodies. */ }
              audit({ type: 'video_response', status, codes: [...new Set(codes)] });
            });
          });
        }
      } catch (error) {
        audit({ type: 'bridge_error', message: error.message });
        req.destroy(error);
        return req;
      }
      if (body.length) write(body);
      return end(callback);
    };
    return req;
  };
}
