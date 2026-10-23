#!/usr/bin/env node
// Quality report for the catalog: tiers, blockers, approximations, shim size.
//
//   node scripts/report-quality.mjs                    # human-readable report
//   node scripts/report-quality.mjs --json             # machine-readable
//   node scripts/report-quality.mjs --demo             # best demo candidates (tier ready)
//   node scripts/report-quality.mjs --max-hard 40 --max-experimental 96 --max-shim-bytes 2500000
//                                                       # CI ratchet: fail when a number grows
//
// Tiers and blockers come from lib/quality.mjs, the same gate validate.mjs
// enforces, so the numbers here always match the files and templates.json.

import { TIERS, BLOCKERS, listTemplates, readJson, loadCatalog, loadVerified } from './lib/catalog-fs.mjs';
import { evaluate } from './lib/quality.mjs';

const args = process.argv.slice(2);
const num = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : Number(args[i + 1]);
};

function approxFamily(n8n) {
  const s = String(n8n || '');
  if (s.startsWith('html.')) return 'html';
  if (s.startsWith('extractFromFile') || s === 'readPDF') return 'extractFromFile';
  if (s.startsWith('code.') || s === 'langchain.code') return 'code';
  if (s.startsWith('email.') || s.startsWith('message.')) return 'email';
  if (s === 'executeWorkflow') return 'executeWorkflow';
  if (s.startsWith('splitInBatches') || s === 'wait' || s === 'executionData') return 'controlFlow';
  if (s.includes('webhook') || s.includes('Trigger')) return 'webhooks';
  if (s.startsWith('vectorStore') || s.includes('Qdrant')) return 'vector';
  if (s.startsWith('crypto.')) return 'crypto';
  if (s.startsWith('database.')) return 'sql';
  if (s.includes('googleAnalytics') || s.includes('HTTP') || s.includes('search') || s.includes('file.get')) return 'httpStandin';
  if (s.startsWith('image.') || s.startsWith('audio.') || s.startsWith('file.')) return 'media';
  if (s.startsWith('row.') || s.startsWith('document.')) return 'crud';
  return 'other';
}

/** Bytes of the generated n8n shim prelude in one Transform body. */
function shimBytes(code) {
  const i = code.indexOf('// n8n compatibility shims (generated)');
  if (i < 0) return 0;
  const lines = code.slice(i).split('\n');
  let j = 1;
  while (j < lines.length && /^(?:const (?:__|\$|DateTime|items?\b)|__def\(|\/\/ n8n data|\/\/ Cross-node)/.test(lines[j])) j++;
  return lines.slice(0, j).join('\n').length;
}

const catalog = loadCatalog();
const verified = loadVerified();
const tiers = Object.fromEntries(TIERS.map((t) => [t, 0]));
const blockerTemplates = Object.fromEntries(Object.keys(BLOCKERS).map((b) => [b, 0]));
const blockerInstances = Object.fromEntries(Object.keys(BLOCKERS).map((b) => [b, 0]));
const hardOps = new Map();
const families = new Map();
const rows = [];
let hardApprox = 0;
let softApprox = 0;
let transforms = 0;
let jsBytes = 0;
let shimTotal = 0;
let shimMax = 0;

for (const rel of listTemplates()) {
  const wf = readJson(rel);
  const q = evaluate(wf, { catalog, verified, path: rel });
  tiers[q.tier]++;
  for (const b of q.blockers) blockerInstances[b.code]++;
  for (const code of new Set(q.blockers.map((b) => b.code))) blockerTemplates[code]++;
  for (const a of wf.template?.conversion?.approximate || []) {
    if (a.soft) softApprox++;
    else {
      hardApprox++;
      hardOps.set(String(a.n8n), (hardOps.get(String(a.n8n)) || 0) + 1);
    }
    families.set(approxFamily(a.n8n), (families.get(approxFamily(a.n8n)) || 0) + 1);
  }
  for (const n of wf.nodes) {
    if (n.type !== 'NodeTransform') continue;
    transforms++;
    const code = String(n.inputs?.jsCode || '');
    jsBytes += code.length;
    const b = shimBytes(code);
    shimTotal += b;
    shimMax = Math.max(shimMax, b);
  }
  rows.push({ path: rel, name: wf.name, category: wf.template?.category, connectors: wf.template?.connectors || [], tier: q.tier, blockers: q.blockers, steps: wf.template?.comparison?.yantraSteps ?? 0, n8nSteps: wf.template?.comparison?.n8nSteps ?? 0, hand: wf.template?.conversion?.tool === 'hand' });
}

const report = {
  templates: rows.length,
  tiers,
  blockers: { templates: blockerTemplates, instances: blockerInstances },
  approximate: { hard: hardApprox, soft: softApprox },
  transforms: { count: transforms, jsBytes, shimBytes: shimTotal, shimMaxBytes: shimMax },
};

// Demo candidates: ready, real integrations in popular categories, short graphs.
const POPULAR = ['gmail-and-email', 'slack', 'telegram', 'google-drive-and-sheets', 'notion', 'openai-and-llms', 'discord', 'whatsapp', 'airtable', 'social-media', 'forms-and-surveys'];
const demo = rows
  .filter((r) => (r.tier === 'ready' || r.tier === 'verified') && POPULAR.includes(r.category))
  .map((r) => {
    const external = r.connectors.filter((c) => !c.startsWith('yantra-'));
    const informational = r.blockers.length;
    const score = (r.hand ? 3 : 0) + Math.min(external.length, 2) * 2 + (POPULAR.length - POPULAR.indexOf(r.category)) / POPULAR.length + (r.steps <= 8 ? 2 : r.steps <= 14 ? 1 : 0) + (r.steps < r.n8nSteps ? 1 : 0) - informational * 0.5;
    return { ...r, external, score };
  })
  .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

if (args.includes('--json')) {
  console.log(JSON.stringify({ ...report, demo: demo.slice(0, 10).map((d) => d.path) }, null, 1));
} else {
  console.log(`templates ${report.templates}`);
  console.log(`tiers ${TIERS.map((t) => `${t}=${tiers[t]}`).join(' ')}`);
  console.log('blockers (templates / instances):');
  for (const [code, n] of Object.entries(blockerTemplates).sort((a, b) => b[1] - a[1])) {
    if (n) console.log(`  ${String(n).padStart(4)} / ${String(blockerInstances[code]).padStart(4)}  ${code}${BLOCKERS[code].blocking ? '' : ' (informational)'}`);
  }
  console.log(`approximate hard=${hardApprox} soft=${softApprox}`);
  console.log(`transforms ${transforms}, jsCode ${jsBytes} bytes, of which shim prelude ${shimTotal} bytes (largest ${shimMax})`);
  console.log('top hard n8n ops:');
  [...hardOps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([t, n]) => console.log(`  ${String(n).padStart(4)}  ${t}`));
  console.log('approximate by family:');
  [...families.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${String(n).padStart(4)}  ${t}`));
  if (args.includes('--demo')) {
    console.log('demo candidates (tier ready, popular categories):');
    for (const d of demo.slice(0, 10)) console.log(`  ${d.path}  [${d.external.join(', ') || 'no credentials'}] ${d.steps} steps${d.blockers.length ? ` (${[...new Set(d.blockers.map((b) => b.code))].join(', ')})` : ''}`);
  }
}

// Ratchets: CI passes the current numbers; a change that makes one worse fails.
let failed = 0;
const ratchet = (flag, value, label) => {
  const max = num(flag);
  if (max === undefined || Number.isNaN(max)) return;
  if (value > max) {
    console.error(`FAIL ${label} is ${value}, above the ratchet ${flag} ${max}`);
    failed++;
  } else if (value < max) console.log(`ratchet ${flag}: ${value} (limit ${max}; lower the limit in CI to lock in the gain)`);
};
ratchet('--max-hard', hardApprox, 'hard approximations');
ratchet('--max-experimental', tiers.experimental, 'experimental templates');
ratchet('--max-shim-bytes', shimTotal, 'shim prelude bytes');
ratchet('--max-shim-bytes-per-transform', shimMax, 'largest shim prelude');
process.exit(failed ? 1 : 0);
