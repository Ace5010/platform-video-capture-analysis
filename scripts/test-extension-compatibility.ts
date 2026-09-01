import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  isAnalysisExtensionCompatible,
  MINIMUM_ANALYSIS_EXTENSION_VERSION,
  semverAtLeast,
} from '../lib/extension-compatibility.ts';

assert.equal(MINIMUM_ANALYSIS_EXTENSION_VERSION, '0.8.0');
assert.equal(isAnalysisExtensionCompatible('0.7.0', ['analyze_video']), false);
assert.equal(isAnalysisExtensionCompatible('0.8.0', ['analyze_video']), true);
assert.equal(isAnalysisExtensionCompatible('0.8.0', []), false);
assert.equal(isAnalysisExtensionCompatible('0.9.0', ['analyze_video']), true);
assert.equal(isAnalysisExtensionCompatible('0.8.0-beta.1', ['analyze_video']), false);
assert.equal(isAnalysisExtensionCompatible('not-a-version', ['analyze_video']), false);
assert.equal(semverAtLeast('0.8.1', '0.8.0'), true);

const manifest = JSON.parse(await readFile(new URL('../chrome-extension/manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const hostInit = await readFile(new URL('../host_service/__init__.py', import.meta.url), 'utf8');
assert.equal(manifest.version, MINIMUM_ANALYSIS_EXTENSION_VERSION);
assert.equal(packageJson.version, manifest.version);
assert.equal(packageLock.version, manifest.version);
assert.equal(packageLock.packages?.['']?.version, manifest.version);
assert.match(hostInit, new RegExp(`__version__\\s*=\\s*["']${manifest.version.replaceAll('.', '\\.')}`));

console.log('Extension compatibility validation passed: analysis requires semver >=0.8.0 and analyze_video.');
