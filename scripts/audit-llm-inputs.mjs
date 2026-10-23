#!/usr/bin/env node
// Offline audit. --json emits the complete report; --check rejects unflagged
// defects. Runtime-dependent API payloads are explicitly counted as unknown.
import { listTemplates, readJson } from './lib/catalog-fs.mjs';
import { auditLlmInputs } from './lib/llm-inputs.mjs';

const rows = listTemplates().flatMap((file) => auditLlmInputs(readJson(file)).map((r) => ({ file, ...r })));
const problems = rows.flatMap((r) => r.problems.map((p) => ({ file: r.file, node: r.label, ...p })));
const summary = { templates: new Set(rows.map((r) => r.file)).size, chains: rows.length,
  checkedReferences: rows.reduce((n, r) => n + r.checked, 0), unknownReferences: rows.reduce((n, r) => n + r.unknown, 0), problems: problems.length };
if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, rows }, null, 2));
else {
  console.log(JSON.stringify(summary));
  for (const p of problems) console.log(`${p.file}: ${p.node}: ${p.detail}`);
}
if (process.argv.includes('--check') && problems.some((p) => {
  const meta = readJson(p.file).template;
  return meta.tier !== 'experimental' || !meta.blockers.some((b) => b.detail === `LLM input mismatch: ${p.detail}`);
})) process.exitCode = 1;
