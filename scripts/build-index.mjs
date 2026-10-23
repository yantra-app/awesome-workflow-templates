#!/usr/bin/env node
// Build templates.json and the generated parts of README.md from the
// templates on disk. Run after converting or hand-editing templates.
//
// The tier, blockers and setup list come from lib/quality.mjs (the same gate
// validate.mjs enforces), never from a hand-kept list. Output depends only on
// the repository: it is dated by the upstream pin, not by the clock.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TIERS, BLOCKERS, STATUSES, listTemplates, readJson, loadSources, loadCatalog, loadVerified } from './lib/catalog-fs.mjs';
import { evaluate, blockerCodes } from './lib/quality.mjs';

const sources = loadSources();
const catalog = loadCatalog();
const verified = loadVerified();

const templates = [];
const aliases = {};
for (const rel of listTemplates()) {
  const wf = readJson(rel);
  const t = wf.template || {};
  const q = evaluate(wf, { catalog, verified, path: rel });
  const own = (t.aliases || []).map((a) => a.path).sort();
  for (const a of own) aliases[a] = rel;
  templates.push({
    id: wf.workflowSlug,
    name: wf.name,
    description: wf.description,
    category: t.category || path.dirname(rel),
    categoryLabel: t.categoryLabel || path.dirname(rel),
    department: t.department || '',
    connectors: t.connectors || [],
    nodeTypes: t.nodeTypes || [],
    nodeCount: wf.nodes.length,
    steps: t.comparison ? { n8n: t.comparison.n8nSteps, yantra: t.comparison.yantraSteps } : undefined,
    foldedHelpers: t.comparison?.foldedHelpers?.length ?? 0,
    handAuthored: t.conversion?.tool === 'hand' || undefined,
    tier: q.tier,
    status: q.status,
    blockers: blockerCodes(q),
    setup: q.setup,
    setupVars: t.setupVars?.length ? t.setupVars.map((v) => v.key) : undefined,
    setupSecrets: t.setupSecrets?.length ? t.setupSecrets.map((v) => v.key) : undefined,
    activation: t.activation || undefined,
    coverage: t.conversion?.coverage ?? null,
    aliases: own.length ? own : undefined,
    path: rel,
    source: t.source?.path ? `${sources.upstream.repo}/blob/${t.source.commit || 'main'}/${encodeURI(t.source.path)}` : undefined,
  });
}

const categoryOrder = sources.categories.map((c) => c.slug);
templates.sort((a, b) => {
  const ca = categoryOrder.indexOf(a.category);
  const cb = categoryOrder.indexOf(b.category);
  if (ca !== cb) return (ca === -1 ? 999 : ca) - (cb === -1 ? 999 : cb);
  return a.name.localeCompare(b.name);
});

const categories = sources.categories
  .map((c) => ({ ...c, count: templates.filter((t) => t.category === c.slug).length }))
  .filter((c) => c.count > 0);

const tiers = Object.fromEntries(TIERS.map((k) => [k, templates.filter((t) => t.tier === k).length]));
const status = Object.fromEntries(STATUSES.map((k) => [k, templates.filter((t) => t.status === k).length]));
const blockers = Object.fromEntries(Object.keys(BLOCKERS).map((k) => [k, templates.filter((t) => t.blockers.includes(k)).length]).filter(([, n]) => n));

// How the Yantra graphs compare with the n8n originals, counted honestly.
const withSteps = templates.filter((t) => t.steps);
const comparison = {
  fewerSteps: withSteps.filter((t) => t.steps.yantra < t.steps.n8n).length,
  sameSteps: withSteps.filter((t) => t.steps.yantra === t.steps.n8n).length,
  moreSteps: withSteps.filter((t) => t.steps.yantra > t.steps.n8n).length,
  n8nSteps: withSteps.reduce((n, t) => n + t.steps.n8n, 0),
  yantraSteps: withSteps.reduce((n, t) => n + t.steps.yantra, 0),
  foldedHelpers: templates.reduce((n, t) => n + t.foldedHelpers, 0),
  handAuthored: templates.filter((t) => t.handAuthored).length,
};

const index = {
  $schema: 'https://raw.githubusercontent.com/yantra-app/awesome-workflow-templates/main/data/templates.schema.json',
  generatedAt: sources.upstream.fetchedAt,
  upstream: sources.upstream,
  count: templates.length,
  tiers,
  status,
  blockers,
  comparison,
  categories,
  aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b))),
  templates,
};
fs.writeFileSync(path.join(ROOT, 'templates.json'), JSON.stringify(index, null, 1) + '\n');

// README ------------------------------------------------------------------

const TIER_LABEL = { verified: 'Verified', ready: 'Ready', experimental: 'Experimental' };

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/—/g, '-').trim();
}

const toc = categories.map((c) => `- [${c.label}](#${c.slug}) (${c.count})`).join('\n');
const sections = categories
  .map((c) => {
    const rows = templates
      .filter((t) => t.category === c.slug)
      .map((t) => {
        const link = `[${mdCell(t.name)}](${encodeURI(t.path)})${t.handAuthored ? ' (hand-built)' : ''}`;
        const connectors = t.connectors.length ? t.connectors.map((x) => `\`${x}\``).join(', ') : '-';
        const steps = t.steps ? `${t.steps.n8n} -> ${t.steps.yantra}` : '-';
        const src = t.source ? `[n8n](${t.source})` : '-';
        return `| ${link} | ${mdCell(t.description)} | ${connectors} | ${steps} | ${TIER_LABEL[t.tier]} | ${src} |`;
      })
      .join('\n');
    return `### ${c.label}\n\n<a id="${c.slug}"></a>\n\n${c.description}\n\n| Template | What it does | Connectors | Steps n8n -> Yantra | Tier | Original |\n|---|---|---|---|---|---|\n${rows}\n`;
  })
  .join('\n');

const tierLine = TIERS.filter((k) => tiers[k] || k !== 'verified').map((k) => `${tiers[k]} ${TIER_LABEL[k].toLowerCase()}`).join(', ');
const catalogMd = `<!-- catalog:start -->\n_${templates.length} templates in ${categories.length} categories. Tiers: ${tierLine}. Steps: ${comparison.fewerSteps} templates need fewer steps on Yantra than in n8n, ${comparison.sameSteps} the same, ${comparison.moreSteps} more; ${comparison.foldedHelpers} model, memory, parser and tool helpers represented in AI configuration and agent settings; ${comparison.handAuthored} hand-built. Generated by \`npm run index\` from upstream commit ${sources.upstream.commit.slice(0, 7)} (fetched ${sources.upstream.fetchedAt})._\n\n${toc}\n\n${sections}<!-- catalog:end -->`;

const readmePath = path.join(ROOT, 'README.md');
let readme = fs.readFileSync(readmePath, 'utf8');
const start = readme.indexOf('<!-- catalog:start -->');
const end = readme.indexOf('<!-- catalog:end -->');
if (start === -1 || end === -1) {
  console.error('README.md needs <!-- catalog:start --> and <!-- catalog:end --> markers');
  process.exit(1);
}
readme = readme.slice(0, start) + catalogMd + readme.slice(end + '<!-- catalog:end -->'.length);
// Inline counts in the prose: <!-- n:key -->123<!-- /n -->
const counts = {
  total: templates.length,
  converted: templates.length - comparison.handAuthored,
  hand: comparison.handAuthored,
  ...Object.fromEntries(TIERS.map((k) => [k, tiers[k]])),
};
readme = readme.replace(/<!-- n:([\w-]+) -->[^<]*<!-- \/n -->/g, (m, key) => (key in counts ? `<!-- n:${key} -->${counts[key]}<!-- /n -->` : m));
fs.writeFileSync(readmePath, readme);
console.log(`templates.json: ${templates.length} templates, ${categories.length} categories (${TIERS.map((k) => `${tiers[k]} ${k}`).join(', ')}); ${Object.keys(aliases).length} alias(es)`);
