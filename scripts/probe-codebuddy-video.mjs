// One explicitly requested live capability probe. No automatic retries, tools,
// session persistence, credentials, or inline media are written to the report.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const runtime = resolve(process.env.OBSERVE_WECHAT_RUNTIME_ROOT || join(project, '..', 'WeChat-Reader'));
const cli = join(runtime, 'buddy-runtime/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy');
const model = process.argv[2] || 'minimax-m3';
const source = process.argv[3];
const wire = process.argv.includes('--native-wire');
const media = source ? await readFile(resolve(source)) : Buffer.from(await (await fetch(
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  { signal: AbortSignal.timeout(30000) },
)).arrayBuffer());
if (!media.length || media.length > 8 * 1024 * 1024) throw new Error('Probe requires a complete video below 8 MiB');
let input = {
  type: 'user', message: { role: 'user', content: [
    { type: 'text', text: '请实际查看附件中的完整视频。仅返回 JSON：{"videoSeen":true或false,"observations":"用中文描述实际看到的主体、颜色、动物、动作和场景变化","limitation":"无法读取时说明原因"}。不要根据文件名猜测，不要调用工具。' },
    { type: 'document', source: { type: 'base64', media_type: 'video/mp4', data: media.toString('base64') } },
  ] },
};
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(CODEBUDDY_API_|ANTHROPIC_|OPENAI_)/.test(key) || ['CODEBUDDY_BASE_URL', 'CODEBUDDY_MODEL', 'NODE_OPTIONS'].includes(key)) delete env[key];
}
Object.assign(env, { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal', CODEBUDDY_MAX_RETRIES: '0', CODEBUDDY_RETRY_WATCHDOG: 'false' });
const args = [cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--agent', 'cli',
  '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
  '--no-session-persistence', '--permission-mode', 'dontAsk', '--max-turns', '1',
  '--system-prompt', '你是视频输入能力验证器。诚实报告实际接收到的视觉信息，仅返回要求的 JSON。'];
let temp, auditPath;
if (wire) {
  temp = await mkdtemp(join(tmpdir(), 'observe-buddy-video-'));
  const videoPath = join(temp, 'input.mp4');
  auditPath = join(temp, 'wire.jsonl');
  const marker = 'OBSERVE_FULL_VIDEO_' + createHash('sha256').update(String(Date.now())).digest('hex');
  await writeFile(videoPath, media);
  const manifestPath = join(temp, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ marker, videoPath, auditPath, sha256: createHash('sha256').update(media).digest('hex') }));
  env.OBSERVE_BUDDY_VIDEO_MANIFEST = manifestPath;
  if (process.argv.includes('--video-url')) env.OBSERVE_BUDDY_VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
  const shim = join(project, 'scripts/codebuddy-video-wire.cjs');
  args.unshift('--require', shim);
  const inputAt = args.indexOf('--input-format');
  args.splice(inputAt, 2);
  args[args.indexOf('--output-format') + 1] = 'json';
  input = input.message.content[0].text + '\n' + marker;
}
const started = Date.now();
const child = spawn(process.execPath, args, { env, cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4 * 1024 * 1024) child.kill(); });
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
const timer = setTimeout(() => child.kill(), 240000);
child.stdin.on('error', () => {});
child.stdin.end(wire ? input : JSON.stringify(input) + '\n');
const exitCode = await new Promise((ok, fail) => { child.once('close', ok); child.once('error', fail); });
clearTimeout(timer);
let events;
try { const parsed = JSON.parse(stdout); events = Array.isArray(parsed) ? parsed : [parsed]; }
catch { events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
const results = events.filter(e => e.type === 'result');
const usage = events.filter(e => e.role === 'assistant' || e.type === 'assistant').flatMap(e => {
  const p = e.providerData || e.message?.providerData;
  return p?.rawUsage ? [{ model: p.model, usage: p.rawUsage }] : [];
});
const sanitize = value => String(value).replace(/data:[^\s"']+/g, '[inline media omitted]')
  .replace(/(?:https?|oss):\/\/[^\s"'<>]+/g, '[URL omitted]')
  .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._~+/-]+/gi, '[credential omitted]');
const report = {
  checkedAt: new Date().toISOString(), model, videoBytes: media.length,
  videoSha256: createHash('sha256').update(media).digest('hex'),
  carrier: wire ? process.argv.includes('--video-url') ? 'native video_url with public complete-source URL' : 'native video_url complete bytes through process-local transport bridge' : 'stream-json document source with video/mp4 MIME and full base64 bytes',
  elapsedSeconds: (Date.now() - started) / 1000, exitCode,
  results: results.map(e => ({ ...e, session_id: undefined })), usage,
  eventTypes: [...new Set(events.map(e => e.type))], stderr: sanitize(stderr),
};
if (auditPath) {
  try { report.wireAudit = (await readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse); }
  catch { report.wireAudit = []; }
}
const folder = join(project, 'artifacts/codebuddy-video');
await mkdir(folder, { recursive: true });
const path = join(folder, `probe-${model}-${Date.now()}.json`);
await writeFile(path, sanitize(JSON.stringify(report, null, 2)));
if (temp) await rm(temp, { recursive: true, force: true });
console.log(JSON.stringify({ path, ...report }, null, 2));
