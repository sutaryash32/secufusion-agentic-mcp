// Resolves the runtime bundle (config JSON, rules, schemas) for both layouts:
//   repo layout:    <repo>/scripts/lib/paths.mjs   -> bundle at <repo>/engines/anthropic/skills/review
//   plugin layout:  <skill>/bin/lib/paths.mjs      -> bundle at <skill>
// The bundle is produced by scripts/build-anthropic.mjs and is committed.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function bundleDir() {
  const pluginLayout = resolve(scriptsDir, '..');
  if (existsSync(join(pluginLayout, 'config', 'review.json'))) return pluginLayout;
  const repoLayout = resolve(scriptsDir, '..', 'engines', 'anthropic', 'skills', 'review');
  if (existsSync(join(repoLayout, 'config', 'review.json'))) return repoLayout;
  throw new Error('sfn-code-reviewer bundle not found — run `npm run build` in sfn-code-reviewer.');
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadConfig(dir = bundleDir()) {
  return {
    review: readJson(join(dir, 'config', 'review.json')),
    repos: readJson(join(dir, 'config', 'repos.json')),
    suppressions: readJson(join(dir, 'rules', 'suppressions.json')).suppressions ?? [],
    rulesDir: join(dir, 'rules'),
    schemasDir: join(dir, 'schemas'),
  };
}
