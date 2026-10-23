#!/usr/bin/env node
// node scripts/migrate-llm-chain.mjs [--dry-run | --write | --check] [--verbose]
// Preflights all templates before writing. No provider/model API calls.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, listTemplates, readJson, loadCatalog, loadVerified } from './lib/catalog-fs.mjs';
import { migrateLlmChains } from './lib/llm-chain.mjs';
import { evaluate } from './lib/quality.mjs';

const args = process.argv.slice(2);
const modes = ['--dry-run', '--write', '--check'];
if (args.some((a) => ![...modes, '--verbose'].includes(a)) || args.filter((a) => modes.includes(a)).length > 1) {
  console.error('Usage: node scripts/migrate-llm-chain.mjs [--dry-run | --write | --check] [--verbose]');
  process.exit(2);
}
const catalog = loadCatalog(), verified = loadVerified(), pending = [];
const totals = { nodes: 0, text: 0, structured: 0, chatModels: 0, arrays: 0, schemas: 0, modelSetup: 0, unsupported: 0 };
const providers = {};
for (const rel of listTemplates()) {
  try {
    const wf = readJson(rel);
    const report = migrateLlmChains(wf);
    if (!report.nodes) continue;
    const q = evaluate(wf, { catalog, verified, path: rel });
    Object.assign(wf.template, { tier: q.tier, blockers: q.blockers, setup: q.setup });
    wf.template.conversion.status = q.status;
    pending.push({ rel, text: JSON.stringify(wf, null, 2) + '\n', report });
    for (const k of Object.keys(totals)) totals[k] += report[k];
    for (const [k, count] of Object.entries(report.providers)) providers[k] = (providers[k] || 0) + count;
  } catch (error) { throw new Error(`${rel}: ${error.message}`, { cause: error }); }
}
if (args.includes('--write')) for (const { rel, text } of pending) fs.writeFileSync(path.join(ROOT, rel), text);
if (args.includes('--verbose')) for (const { rel, report } of pending) console.log(`${rel}: ${JSON.stringify(report)}`);
console.log(`${args.includes('--write') ? 'Migrated' : 'Pending'}: ${pending.length} templates; ${JSON.stringify(totals)}`);
console.log(`Chat Model providers: ${JSON.stringify(providers)}`);
if (args.includes('--write') && pending.length) console.log('Next: npm run index && npm test');
if (args.includes('--check') && pending.length) process.exitCode = 1;
