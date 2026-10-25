// Explicit real, billable, one-video acceptance. Never run from npm test.
// Reuses the existing transcript; keeps all results and charges in SQLite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--run-real' || !/^\d{10,25}$/.test(process.argv[3] || '')) {
  throw new Error('Explicit --run-real VIDEO_ID required; this invokes the logged-in model');
}
const id = process.argv[3];
const project = fileURLToPath(new URL('..', import.meta.url));
const python = join(project, '.venv/Scripts/python.exe');
const token = randomBytes(32).toString('base64url');
const csrf = createHash('sha256').update(`${token}douyin-monitor-csrf-v1`).digest('hex');
const metadata = JSON.parse(execFileSync(python, ['-c', `
import hashlib,json,os,sys
sys.path.insert(0,os.environ['OBSERVE_PROJECT'])
from host_service.config import HostConfig
from host_service.database import Database
db=Database(HostConfig.from_env());v=db.get_video(os.environ['OBSERVE_VIDEO'])
assert v and v.get('transcriptStatus')=='ready', 'Select an existing completed transcript'
assert not v.get('analysis'), 'Select a video without an existing paid analysis'
db.create_session(hashlib.sha256(os.environ['OBSERVE_TOKEN'].encode()).hexdigest(),hashlib.sha256(os.environ['OBSERVE_CSRF'].encode()).hexdigest(),'127.0.0.1',3600)
print(json.dumps({k:v.get(k) for k in ['id','accountId','title','durationSeconds']}))
`], { encoding: 'utf8', env: { ...process.env, OBSERVE_PROJECT: project, OBSERVE_VIDEO: id, OBSERVE_TOKEN: token, OBSERVE_CSRF: csrf } }));
const headers = { Origin: 'http://localhost:3000', Cookie: `douyin_monitor_session=${token}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
const api = async (path, options = {}) => {
  const response = await fetch(`http://127.0.0.1:43129${path}`, { headers, ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(`Host ${response.status}: ${result.error || 'request failed'}`);
  return result;
};
const config = await api('/api/qwen/status');
assert.equal(config.analysisProvider, 'codebuddy');
assert.equal(config.model, 'minimax-m3');
const started = Date.now();
const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ type: 'analyze_video', payload: { videoId: id, accountId: metadata.accountId } }) });
const jobId = created.job.id;
console.log(JSON.stringify({ jobId, video: metadata, provider: config.analysisProvider, fallback: config.fallbackModel }));
let job, lastStage;
do {
  job = (await api(`/api/jobs/${jobId}`)).job;
  const stage = job.progress?.stage || job.status;
  if (stage !== lastStage) { console.log(JSON.stringify({ jobId, status: job.status, stage, elapsedSeconds: Math.round((Date.now() - started) / 1000) })); lastStage = stage; }
  if (['succeeded', 'failed', 'cancelled', 'expired'].includes(job.status)) break;
  await new Promise(ok => setTimeout(ok, 3000));
} while (Date.now() - started < 20 * 60 * 1000);
await new Promise(ok => setTimeout(ok, 300));
const persisted = JSON.parse(execFileSync(python, ['-c', `
import json,sqlite3,pathlib,os
c=sqlite3.connect(pathlib.Path('data/host-service/monitor.sqlite3').resolve().as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
r=c.execute('select status,usage_json,analysis_json,error from analysis_runs where job_id=?',(os.environ['OBSERVE_JOB'],)).fetchone()
v=json.loads(c.execute('select data_json from videos where id=?',(os.environ['OBSERVE_VIDEO'],)).fetchone()[0])
print(json.dumps({'status':r['status'] if r else None,'usage':json.loads(r['usage_json'] or '{}') if r else None,'analysisFields':list(json.loads(r['analysis_json'] or '{}')) if r else [],'overview':(v.get('analysis') or {}).get('contentAnalysis',{}).get('quickOverview'),'error':r['error'] if r else None,'videoStatus':v.get('analysisStatus'),'transcriptStatus':v.get('transcriptStatus')}))
`], { cwd: project, encoding: 'utf8', env: { ...process.env, OBSERVE_JOB: jobId, OBSERVE_VIDEO: id } }));
const prefix = 'job-' + jobId.replace(/[^a-z0-9]/gi, '').slice(0, 16) + '-';
const remaining = (await readdir(join(project, 'data/host-service/tmp'))).filter(name => name.startsWith(prefix));
const report = { checkedAt: new Date().toISOString(), jobId, video: metadata,
  elapsedSeconds: (Date.now() - started) / 1000, jobStatus: job.status, ...persisted, remainingTaskDirectories: remaining };
const folder = join(project, 'artifacts/codebuddy-video');
await mkdir(folder, { recursive: true });
await writeFile(join(folder, `live-${jobId}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.equal(job.status, 'succeeded');
assert.equal(report.status, 'succeeded');
assert.equal(report.videoStatus, 'ready');
assert.equal(report.usage.analysisInput.inputMode, 'complete_video');
assert.equal(report.usage.analysisInput.transcriptReused, true);
assert.equal(report.usage.usageComplete, true);
assert.ok(report.usage.credits >= 0);
assert.ok(report.analysisFields.includes('contentAnalysis') && report.analysisFields.includes('shotTimeline'));
assert.equal(remaining.length, 0);
// Preserve encrypted settings and the account/video/snapshot data around restart.
const before = JSON.parse(await readFile(join(folder, 'before-restart.json'), 'utf8'));
for (const [name, hash] of Object.entries(before.encryptedFileHashes)) {
  assert.equal(createHash('sha256').update(await readFile(join(project, 'data/host-service', name))).digest('hex'), hash);
}
console.log('Real acceptance passed: queue, complete native video, saved transcript reuse, persisted result/credits, encrypted settings and temporary media cleanup.');
