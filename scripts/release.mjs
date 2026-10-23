#!/usr/bin/env node
// Build a versioned release bundle and a CHANGELOG entry. Creates no git tag,
// commit or GitHub release: it only writes files for a person to review.
//
//   node scripts/release.mjs --version 1.1.0 [--since <git-ref>] [--date YYYY-MM-DD] [--dry-run]
//
//   dist/templates-<version>.json         index + every template, one file a consumer can pin
//   dist/templates-<version>.json.sha256  checksum of the bundle
//   CHANGELOG.md                           new entry on top, from the templates.json diff
//                                          against <since> (default: HEAD)
//   package.json                           "version" set to <version>
//
// Run `npm run index && npm run validate` first; the release refuses a stale index.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, TIERS, listTemplates, readJson } from './lib/catalog-fs.mjs';

const args = process.argv.slice(2);
const value = (f) => {
  const i = args.indexOf(f);
  return i === -1 ? undefined : args[i + 1];
};
const dryRun = args.includes('--dry-run');
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = value('--version') || pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a semver version: ${version}`);
  process.exit(2);
}
const since = value('--since') || 'HEAD';
const date = value('--date') || new Date().toISOString().slice(0, 10);

const index = readJson('templates.json');
const onDisk = listTemplates();
if (index.count !== onDisk.length || index.templates.some((t) => !onDisk.includes(t.path))) {
  console.error('templates.json does not match the files on disk; run `npm run index` first');
  process.exit(1);
}

// Previous index for the changelog diff (read-only git access).
let previous = null;
try {
  previous = JSON.parse(execFileSync('git', ['show', `${since}:templates.json`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
} catch {
  console.warn(`no templates.json at ${since}; the changelog lists every template as added`);
}
// Older indexes have `status` but no `tier`.
const tierOf = (t) => t.tier || (t.status === 'ready' ? 'ready' : t.status === 'partial' ? 'experimental' : 'needs-setup');
const prevByPath = new Map((previous?.templates || []).map((t) => [t.path, t]));
const nowByPath = new Map(index.templates.map((t) => [t.path, t]));
const added = index.templates.filter((t) => !prevByPath.has(t.path));
const removed = [...prevByPath.values()].filter((t) => !nowByPath.has(t.path));
const rank = Object.fromEntries(TIERS.map((t, i) => [t, i]));
const moved = index.templates
  .filter((t) => prevByPath.has(t.path) && tierOf(prevByPath.get(t.path)) !== t.tier)
  .map((t) => ({ t, from: tierOf(prevByPath.get(t.path)), to: t.tier }));
const promoted = moved.filter((m) => rank[m.to] < rank[m.from]);
const demoted = moved.filter((m) => rank[m.to] > rank[m.from]);
const prevTiers = Object.fromEntries(TIERS.map((k) => [k, (previous?.templates || []).filter((t) => tierOf(t) === k).length]));

const list = (items, fmt, max = 25) => {
  const lines = items.slice(0, max).map(fmt);
  if (items.length > max) lines.push(`- ...and ${items.length - max} more`);
  return lines.join('\n');
};
const section = (title, items, fmt) => (items.length ? `\n### ${title} (${items.length})\n\n${list(items, fmt)}\n` : '');
const entry =
  `## ${version} - ${date}\n\n` +
  `${index.count} templates (upstream ${index.upstream.commit.slice(0, 7)}). Tiers: ` +
  TIERS.map((k) => `${k} ${previous ? `${prevTiers[k]} -> ` : ''}${index.tiers[k]}`).join(', ') +
  '.\n' +
  section('Added', added, (t) => `- \`${t.path}\` (${t.tier})`) +
  section('Removed', removed, (t) => `- \`${t.path}\`${index.aliases?.[t.path] ? ` (merged into \`${index.aliases[t.path]}\`)` : ''}`) +
  section('Promoted', promoted, (m) => `- \`${m.t.path}\`: ${m.from} -> ${m.to}`) +
  section('Demoted', demoted, (m) => `- \`${m.t.path}\`: ${m.from} -> ${m.to}${m.t.blockers.length ? ` (${m.t.blockers.join(', ')})` : ''}`) +
  '\n';

// Bundle: the index plus every template body, so a consumer can pin one URL.
const bundle = {
  bundleVersion: version,
  schema: index.$schema,
  generatedAt: index.generatedAt,
  upstream: index.upstream,
  count: index.count,
  tiers: index.tiers,
  aliases: index.aliases,
  index: index.templates,
  templates: Object.fromEntries(index.templates.map((t) => [t.path, readJson(t.path)])),
};
const text = JSON.stringify(bundle) + '\n';
const sha = crypto.createHash('sha256').update(text).digest('hex');

if (dryRun) {
  console.log(entry);
  console.log(`would write dist/templates-${version}.json (${(text.length / 1e6).toFixed(1)} MB, sha256 ${sha.slice(0, 12)})`);
  process.exit(0);
}
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist', `templates-${version}.json`), text);
fs.writeFileSync(path.join(ROOT, 'dist', `templates-${version}.json.sha256`), `${sha}  templates-${version}.json\n`);
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const head = '# Changelog\n\nRelease bundles are built by `npm run release`; see CONTRIBUTING.md.\n\n';
const old = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8').replace(head, '') : '';
if (old.includes(`## ${version} - `)) {
  console.error(`CHANGELOG.md already has an entry for ${version}`);
  process.exit(1);
}
fs.writeFileSync(changelogPath, head + entry + old);
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`wrote dist/templates-${version}.json (${(text.length / 1e6).toFixed(1)} MB), its .sha256, and the CHANGELOG.md entry for ${version}`);
console.log('Next (by hand): review, commit, then tag and publish the bundle; see CONTRIBUTING.md "Releasing".');
