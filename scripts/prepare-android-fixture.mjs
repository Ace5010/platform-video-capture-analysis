import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
// Share synthetic test data only. Never read a running host, database or credentials.
const source = await readFile(new URL('./preview-workspace-fixture.mjs', import.meta.url), 'utf8');
const definitions = source.slice(source.indexOf('const capturedAt'), source.indexOf('function browserFixture'));
const fixture = new Function(`${definitions}\nreturn data;`)();
const destination = path.resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
await writeFile(path.join(destination, 'fixture.json'), JSON.stringify(fixture));
// Only the separate test APK contains a synthetic website. The production app
// loads HTTPS resources from its configured website instead of shipping a copy.
await cp(new URL('../dist/client/', import.meta.url), path.join(destination, 'web'), { recursive: true });
