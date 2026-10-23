#!/usr/bin/env node
// Refresh the templates from the upstream n8n collection.
//
//   npm run sync            # fetch the commit pinned in sources.json, convert, index, validate
//   npm run sync -- --latest   # move the pin to upstream's current main first
//
// The upstream checkout lives in .cache/upstream (git-ignored).

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcesPath = path.join(root, 'sources.json');
const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
const dir = path.join(root, '.cache', 'upstream');
const latest = process.argv.includes('--latest');

const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });
const out = (cmd, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

if (!fs.existsSync(path.join(dir, '.git'))) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  sh(`git clone --quiet ${sources.upstream.repo}.git ${JSON.stringify(dir)}`);
} else {
  sh('git fetch --quiet origin', dir);
}

let commit = sources.upstream.commit;
if (latest) {
  commit = out('git rev-parse origin/HEAD', dir);
  sources.upstream.commit = commit;
  sources.upstream.fetchedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + '\n');
  console.log(`pinned upstream to ${commit}`);
}
sh(`git checkout --quiet ${commit}`, dir);

sh(`node scripts/convert-n8n.mjs --upstream ${JSON.stringify(dir)}`);
// Re-derive unimplemented flags for actions the new templates use (offline, from the pinned registry lock).
sh('node scripts/connector-catalog.mjs');
sh('node scripts/build-index.mjs');
sh('node scripts/validate.mjs');
