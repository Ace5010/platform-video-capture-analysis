// Private one-call child. The CLI owns authentication; no credentials cross
// into Python or reports. Discard its private reasoning and raw media echoes.
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let rawInput = '';
for await (const chunk of process.stdin) rawInput += chunk;
const input = JSON.parse(rawInput);
const { cli, taskDir, model, prompt, systemPrompt, videoPath, sha256 } = input;
if (!['minimax-m3', 'minimax-m3.1-flash'].includes(model)) throw new Error('Unsupported analysis model');
const marker = `OBSERVE_FULL_VIDEO_${sha256 || 'text-integration'}`;
const manifestPath = join(taskDir, `buddy-${model}.manifest.json`);
const auditPath = join(taskDir, `buddy-${model}.wire.jsonl`);
const systemPath = join(taskDir, `buddy-${model}.system.txt`);
await writeFile(systemPath, systemPrompt, { mode: 0o600 });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(CODEBUDDY_API_|ANTHROPIC_|OPENAI_)/.test(key) || ['CODEBUDDY_BASE_URL', 'CODEBUDDY_MODEL', 'NODE_OPTIONS', 'OBSERVE_BUDDY_VIDEO_MANIFEST', 'OBSERVE_BUDDY_VIDEO_URL'].includes(key)) delete env[key];
}
Object.assign(env, {
  CODEBUDDY_INTERNET_ENVIRONMENT: 'internal', CODEBUDDY_MAX_RETRIES: '0',
  CODEBUDDY_RETRY_WATCHDOG: 'false', CODEBUDDY_MODEL_401_MAX_RETRIES: '0',
});
const args = [];
{
  await writeFile(auditPath, '', { mode: 0o600 });
  await writeFile(manifestPath, JSON.stringify({ marker, videoPath, sha256, auditPath, model }), { mode: 0o600 });
  env.OBSERVE_BUDDY_VIDEO_MANIFEST = manifestPath;
  args.push('--require', join(import.meta.dirname, 'codebuddy-video-wire.cjs'));
}
args.push(cli, '-p', '--agent', 'cli', '--output-format', 'json', '--model', model,
  '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
  '--permission-mode', 'dontAsk', '--max-turns', '1', '--system-prompt-file', systemPath);
const started = Date.now();
const child = spawn(process.execPath, args, { env, cwd: taskDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
const terminate = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
};
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) terminate(); });
child.stderr.resume(); // upstream diagnostic strings can contain credentials
child.stdin.on('error', () => {});
child.stdin.end(prompt + '\n' + marker);
const exitCode = await new Promise((ok, fail) => { child.once('close', ok); child.once('error', fail); });
let events = [];
try { const parsed = JSON.parse(stdout); events = Array.isArray(parsed) ? parsed : [parsed]; } catch { /* unknown outcome is preserved below */ }
const final = events.findLast(e => e.type === 'result');
const records = events.filter(e => e.role === 'assistant' && e.providerData?.rawUsage).map(e => ({
  requestId: e.providerData.conversationRequestId, model: e.providerData.model,
  usage: e.providerData.rawUsage,
}));
let wire = [];
try { wire = (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { /* absent wire is a failure */ }
console.log(JSON.stringify({ exitCode, elapsedSeconds: (Date.now() - started) / 1000,
  complete: Boolean(exitCode === 0 && final && final.subtype === 'success' && !final.is_error && !final.terminal_reason),
  result: final?.structured_output || final?.result || null, records, wire,
  errorCodes: [...new Set(wire.flatMap(e => e.codes || []))],
}));
