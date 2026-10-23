#!/usr/bin/env node
// Connector catalog: the single source of truth for which connector actions a
// template may use (data/connector-actions.json).
//
//   node scripts/connector-catalog.mjs                 # build the catalog from the pinned registry lock (offline)
//   node scripts/connector-catalog.mjs --check         # CI: fail on drift or on a template action absent from the catalog
//   node scripts/connector-catalog.mjs --refresh       # re-pin data/connector-registry.lock.json from the published CDN registry
//   node scripts/connector-catalog.mjs --refresh --registry ~/.cdecli/registry.json
//                                                       # re-pin from a registry.json snapshot file instead of the network
//   node scripts/connector-catalog.mjs --import-src /path/to/third-party-extensions
//                                                       # add action ids/params for new actions from extension sources
//   node scripts/connector-catalog.mjs --import-pkg ~/.cdecli/connectors/firecrawl
//                                                       # add action ids/params from an installed connector package.json
//                                                       # (`cdecli connector install <id>`; comma-separate several dirs)
//   node scripts/connector-catalog.mjs --refresh --only firecrawl,openai
//                                                       # re-pin only these connectors in the lock
//
// Inputs
//   data/connector-registry.lock.json  pinned registry snapshot: per connector its
//                                      published version and published action titles.
//   data/connector-action-titles.json  id -> published title, for the few connectors
//                                      whose ids do not carry their published title.
//   data/connector-actions.json        action definitions (id, title, params, triggers).
//
// Rules
//   - An action is published when its title is in the connector's registry entry.
//   - Unpublished actions are dropped, unless a template or the converter still
//     references them; those stay with `unimplemented: true`, which the quality
//     gate turns into the `experimental` tier. Nothing is kept "because it was
//     there before".
//   - Output is sorted and carries no wall-clock date, so a rebuild on any
//     machine is byte-identical.
//   - Local ~/.cdecli connector installs are never read.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { CONNECTORS } from './lib/n8n-mapping.mjs';
import { ROOT, listTemplates, readJson, loadPending, patchPending } from './lib/catalog-fs.mjs';

const REGISTRY_BASE = 'https://d3pdzbmtmn6yq3.cloudfront.net/_connectors/registry';
const CATALOG = path.join(ROOT, 'data', 'connector-actions.json');
const LOCK = path.join(ROOT, 'data', 'connector-registry.lock.json');
const TITLES = path.join(ROOT, 'data', 'connector-action-titles.json');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => {
  const i = args.indexOf(f);
  return i === -1 ? undefined : args[i + 1];
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

// ---------------------------------------------------------------------------
// Registry lock
// ---------------------------------------------------------------------------

function lockEntry(ext) {
  return {
    version: String(ext.version || ''),
    package: ext.package || undefined,
    actions: [...new Set((ext.actions || []).map(String))].sort((a, b) => a.localeCompare(b)),
  };
}

async function refreshLock() {
  const snapshot = value('--registry');
  const only = value('--only') ? value('--only').split(',').map((x) => x.trim()).filter(Boolean) : null;
  const previous = only && fs.existsSync(LOCK) ? readJson(LOCK) : null;
  const scope = only || [...new Set([...CONNECTORS, ...Object.keys(readJson(CATALOG).connectors || {})])].sort();
  const connectors = {};
  const missing = [];
  let source;
  if (snapshot) {
    const file = snapshot.replace(/^~(?=\/)/, process.env.HOME || '');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const byName = new Map((reg.extensions || []).map((e) => [e.name, e]));
    for (const name of scope) {
      const ext = byName.get(name);
      if (ext) connectors[name] = lockEntry(ext);
      else missing.push(name);
    }
    source = { kind: 'registry-snapshot', file: path.basename(file), registryVersion: reg.version, registryGenerated: reg.generated };
  } else {
    for (const name of scope) {
      const res = await fetch(`${REGISTRY_BASE}/${encodeURIComponent(name)}.json`);
      if (!res.ok) {
        missing.push(name);
        continue;
      }
      const text = await res.text();
      let ext;
      try {
        ext = JSON.parse(text);
      } catch {
        missing.push(name);
        continue;
      }
      connectors[name] = lockEntry(ext);
    }
    source = { kind: 'cdn', base: REGISTRY_BASE };
  }
  const merged = previous ? { ...previous.connectors, ...connectors } : connectors;
  const lock = { note: 'Pinned connector registry snapshot. Refresh with `npm run catalog -- --refresh`; never edit by hand.', source: previous?.source || source, connectors: sortObj(merged) };
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 1) + '\n');
  console.log(`pinned ${Object.keys(connectors).length} connectors to ${path.relative(ROOT, LOCK)}`);
  if (missing.length) console.warn(`not in the registry (their actions will be unimplemented): ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Import action definitions from a third-party-extensions checkout
// ---------------------------------------------------------------------------

function parseActions(src) {
  const out = {};
  for (const m of src.matchAll(/^\s*'([A-Z][A-Z0-9_]+)':\s*\{\s*name:\s*'((?:[^'\\]|\\.)*)'/gm)) out[m[1]] = { title: m[2].replace(/\\'/g, "'") };
  return out;
}

function parseSchemas(src) {
  const interfaces = {};
  for (const m of src.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
    interfaces[m[1]] = [...m[2].matchAll(/\n\s*([\w$]+)(\??):/g)].map((f) => (f[2] === '' ? `*${f[1]}` : f[1]));
  }
  const inputByAction = {};
  for (const m of src.matchAll(/'([A-Z][A-Z0-9_]+)':\s*\{\s*input:\s*'(\w+)'/g)) inputByAction[m[1]] = m[2];
  return { interfaces, inputByAction };
}

/**
 * Action ids, titles and params (`*` = required) from installed connector
 * packages (`contributes.actions[].inputSchema`). Only fills actions the
 * catalog does not know yet; the registry lock still decides what is published.
 */
function importFromPackages(dirs, catalog) {
  let added = 0;
  for (const raw of dirs) {
    const dir = raw.replace(/^~(?=\/)/, process.env.HOME || '');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const name = pkg.provider || path.basename(dir);
    const entry = (catalog.connectors[name] ||= { actions: {}, triggers: [] });
    for (const a of pkg.contributes?.actions || []) {
      if (!a?.id || entry.actions[a.id]) continue;
      const req = new Set(a.inputSchema?.required || []);
      entry.actions[a.id] = { title: a.title || a.id, params: Object.keys(a.inputSchema?.properties || {}).map((k) => (req.has(k) ? `*${k}` : k)) };
      added++;
    }
    const triggers = (pkg.contributes?.triggers || []).map((t) => t?.id || t?.name).filter(Boolean);
    if (triggers.length) entry.triggers = [...new Set([...(entry.triggers || []), ...triggers])].sort();
  }
  console.log(`imported ${added} new action definitions from ${dirs.length} installed package(s)`);
  return catalog;
}

function importFromSource(checkout, catalog) {
  const extDir = path.join(checkout, 'packages-extensions');
  if (!fs.existsSync(extDir)) throw new Error(`not a third-party-extensions checkout: ${checkout}`);
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  let added = 0;
  for (const name of CONNECTORS) {
    const candidates = [path.join(extDir, `${name}-extension`, 'src')];
    if (name.startsWith('yantra-')) candidates.push(path.join(extDir, 'yantra-extension', name.slice(7), 'src'));
    const parts = name.split('-');
    if (parts.length >= 2) candidates.push(path.join(extDir, `${parts[0]}-extension`, parts.slice(1).join('-'), 'src'));
    const dir = candidates.find((d) => fs.existsSync(d));
    if (!dir) continue;
    let actions = parseActions(read(path.join(dir, 'actions.ts')));
    if (!Object.keys(actions).length) actions = parseActions(read(path.join(dir, 'actionRegistry.ts')));
    const { interfaces, inputByAction } = parseSchemas(read(path.join(dir, 'schemas.ts')));
    const entry = (catalog.connectors[name] ||= { actions: {}, triggers: [] });
    for (const [id, a] of Object.entries(actions)) {
      if (entry.actions[id]) continue;
      entry.actions[id] = { title: a.title, params: interfaces[inputByAction[id]] || [] };
      added++;
    }
    const triggers = [...read(path.join(dir, 'triggers.ts')).matchAll(/name:\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
    if (triggers.length) entry.triggers = [...new Set([...(entry.triggers || []), ...triggers])].sort();
  }
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: checkout, encoding: 'utf8' }).trim();
  } catch {
    // not a git checkout
  }
  console.log(`imported ${added} new action definitions from third-party-extensions@${commit.slice(0, 12)}; run without flags to prune against the registry`);
  return catalog;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Every connector/action pair the templates use. */
function templateActions() {
  const used = new Map();
  for (const rel of listTemplates()) {
    const wf = readJson(rel);
    for (const n of wf.nodes || []) {
      if (n.type !== 'NodeCdeConnector') continue;
      const key = `${n.inputs?.connectorName}/${n.inputs?.action}`;
      if (!used.has(key)) used.set(key, new Set());
      used.get(key).add(rel);
    }
  }
  return used;
}

/** Action ids the converter itself may emit (mapping tables and hard-coded stand-ins). */
function converterActions() {
  const text = ['convert-n8n.mjs', 'lib/n8n-mapping.mjs'].map((f) => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')).join('\n');
  return new Set([...text.matchAll(/'([A-Z][A-Z0-9]*_[A-Z0-9_]+)'/g)].map((m) => m[1]));
}

export function buildCatalog(definitions, lock, titles, used, referenced, pending = {}) {
  const connectors = {};
  const stats = { published: 0, unimplemented: 0, dropped: 0 };
  const usedIds = new Set([...used.keys()]);
  for (const name of [...new Set([...CONNECTORS, ...[...used.keys()].map((k) => k.split('/')[0])])].sort()) {
    const def = definitions.connectors?.[name] || { actions: {} };
    const reg = lock.connectors?.[name];
    const published = new Set((reg?.actions || []).map(norm));
    const aliases = titles[name] || {};
    const actions = {};
    for (const id of Object.keys(def.actions || {}).sort()) {
      const a = def.actions[id];
      const title = aliases[id] || a.title || id;
      // A patch (data/pending-actions.json) stays pending until the lock pins a newer
      // connector version: an action it adds is unpublished even if an older action
      // shares its title, and params it adds to a published action are pendingParams.
      const pend = pending[`${name}/${id}`];
      const stillPending = pend ? patchPending(pend, reg?.version) : false;
      const isPublished = published.has(norm(title)) && !(stillPending && !pend.newParams);
      const isUsed = usedIds.has(`${name}/${id}`) || referenced.has(id);
      if (!isPublished && !isUsed) {
        stats.dropped++;
        continue;
      }
      const out = { title, params: [...(a.params || [])] };
      if (isPublished && stillPending && pend.newParams?.length) out.pendingParams = [...pend.newParams];
      if (!isPublished) {
        out.unimplemented = true;
        stats.unimplemented++;
      } else stats.published++;
      actions[id] = out;
    }
    const entry = { version: reg?.version || null, actions };
    if (!reg) entry.unpublished = true;
    if ((def.triggers || []).length) entry.triggers = [...new Set(def.triggers)].sort();
    connectors[name] = entry;
  }
  const lockText = fs.existsSync(LOCK) ? fs.readFileSync(LOCK, 'utf8') : '';
  return {
    catalog: {
      generatedFrom: {
        script: 'scripts/connector-catalog.mjs',
        registry: lock.source || null,
        lock: 'data/connector-registry.lock.json',
        lockSha256: crypto.createHash('sha256').update(lockText).digest('hex').slice(0, 16),
      },
      note: 'Generated; do not edit. Params prefixed with * are required. `unimplemented: true` marks an action a template or the converter references that the published connector registry does not ship. `pendingParams` lists params a written but unpublished connector patch adds to a published action (data/pending-actions.json).',
      connectors,
    },
    stats,
  };
}

async function main() {
  if (flag('--refresh')) {
    await refreshLock();
    if (!flag('--build')) return;
  }
  let definitions = readJson(CATALOG);
  if (value('--import-src')) definitions = importFromSource(path.resolve(value('--import-src')), definitions);
  if (value('--import-pkg')) definitions = importFromPackages(value('--import-pkg').split(','), definitions);
  if (!fs.existsSync(LOCK)) {
    console.error(`${path.relative(ROOT, LOCK)} is missing; run with --refresh first`);
    process.exit(2);
  }
  // Patched actions waiting for publish (data/pending-actions.json): their definitions
  // come from the patch, so they are kept as unimplemented until the registry lists them.
  const pending = loadPending();
  for (const [key, def] of Object.entries(pending)) {
    const [c, a] = key.split('/');
    const entry = (definitions.connectors[c] ||= { actions: {}, triggers: [] });
    entry.actions[a] = { title: def.title, params: def.params };
  }
  const lock = readJson(LOCK);
  const titles = fs.existsSync(TITLES) ? readJson(TITLES) : {};
  delete titles.$comment;
  const used = templateActions();
  const { catalog, stats } = buildCatalog(definitions, lock, titles, used, converterActions(), pending);
  const text = JSON.stringify(catalog, null, 1) + '\n';

  if (flag('--check')) {
    let failed = 0;
    if (fs.readFileSync(CATALOG, 'utf8') !== text) {
      console.error('FAIL data/connector-actions.json is out of date; run `npm run catalog` and commit');
      failed++;
    }
    const unimplemented = [];
    const extended = [];
    for (const [key, files] of [...used].sort()) {
      const [c, a] = key.split('/');
      const act = catalog.connectors[c]?.actions?.[a];
      if (!act) {
        console.error(`FAIL ${key} is used by ${[...files].join(', ')} but is not in the catalog`);
        failed++;
      } else if (act.unimplemented) unimplemented.push(`${key} (${files.size} template${files.size === 1 ? '' : 's'})`);
      else if (act.pendingParams) extended.push(`${key} ${act.pendingParams.join(', ')} (in ${files.size} template${files.size === 1 ? '' : 's'} using the action)`);
    }
    if (unimplemented.length) console.log(`unpublished actions in use (templates are tier experimental; those in data/pending-actions.json report action-pending-publish and promote once the patch is published):\n  ${unimplemented.join('\n  ')}`);
    if (extended.length) console.log(`published actions with patched params not published yet (a template sending one of them reports action-pending-publish):\n  ${extended.join('\n  ')}`);
    console.log(`catalog check: ${stats.published} published, ${stats.unimplemented} unimplemented, ${Object.keys(catalog.connectors).length} connectors`);
    process.exit(failed ? 1 : 0);
  }

  fs.writeFileSync(CATALOG, text);
  console.log(`wrote ${path.relative(ROOT, CATALOG)}: ${Object.keys(catalog.connectors).length} connectors, ${stats.published} published actions, ${stats.unimplemented} unimplemented (kept because referenced), ${stats.dropped} dropped`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
