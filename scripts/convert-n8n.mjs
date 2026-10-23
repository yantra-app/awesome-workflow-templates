#!/usr/bin/env node
// Convert the awesome-n8n-templates collection into Yantra workflow templates.
//
//   node scripts/convert-n8n.mjs --upstream .cache/upstream [--only <substring>]
//
// Output: one `<category>/<slug>.json` per n8n workflow in the shape that
// `cdecli workflow create-from-json` and the editor's Import accept, plus a
// `template` metadata block (category, connectors, provenance, conversion
// report) that build-index.mjs turns into templates.json and the README.
//
// The conversion is deterministic: node ids are hashes of the template slug
// and the n8n node name, so re-running on the same upstream commit produces
// the same files and a refreshed upstream produces a reviewable diff.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NODE_TYPES, DATA_OUTPUT, DONE_OUTPUT, RUN_INPUT } from './lib/yantra-nodes.mjs';
import { migrateLlmChains } from './lib/llm-chain.mjs';
import { simplifyLlmHelpers } from './lib/llm-helpers.mjs';
import { planItemLoops, isLoopReturn } from './lib/item-loops.mjs';
import { planRepeatLoops } from './lib/repeat-loops.mjs';
import { beginRepeat, wireRepeats, buildRepeatWait } from './lib/repeat-converter.mjs';
import * as M from './lib/n8n-mapping.mjs';
import * as X from './lib/expressions.mjs';
import { evaluate, scanLiterals, SECRET_NAME, AUTH_HEADER, EXTRA_REQUIRED } from './lib/quality.mjs';
import { loadVerified, PLACEHOLDER_RE } from './lib/catalog-fs.mjs';
import { SetupRegistry, paramVar, authPlan, headerFormat, literalVarName, isSecretPlaceholder, liftString, camel, serviceName, upperSnake, UNSIGNABLE_AUTH } from './lib/setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const upstream = path.resolve(argValue('--upstream') || path.join(root, '.cache', 'upstream'));
const only = argValue('--only');
const sources = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
// The converter reads only the checked-in catalog (never ~/.cdecli), so output depends on the repo alone.
const catalogFull = JSON.parse(fs.readFileSync(path.join(root, 'data', 'connector-actions.json'), 'utf8'));
const catalog = catalogFull.connectors;
// Small, explicit corrections for defects in the pinned upstream prompts.
const llmPromptFixes = JSON.parse(fs.readFileSync(path.join(root, 'data', 'llm-prompt-fixes.json'), 'utf8'));
const verified = loadVerified(root);

// ---------------------------------------------------------------------------
// Upstream metadata
// ---------------------------------------------------------------------------

function readmeMetadata() {
  const readme = fs.readFileSync(path.join(upstream, 'README.md'), 'utf8');
  const rows = readme.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \| \[Link to Template\]\((.+?)\) \|$/gm);
  const byPath = new Map();
  for (const [, title, description, department, link] of rows) {
    if (link.startsWith('http')) continue;
    // Some README rows link `./Dir/File.json`. Their description and department
    // apply; the title does not replace the workflow name, so slugs stay stable.
    const rel = decodeURIComponent(link);
    const dotted = rel.startsWith('./');
    byPath.set(rel.replace(/^\.\//, ''), { title: dotted ? undefined : clean(title), description: clean(description), department: clean(department) });
  }
  return byPath;
}

function clean(s) {
  return String(s ?? '')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(s) {
  return clean(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{ASCII}]/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '') || 'workflow';
}

// ---------------------------------------------------------------------------
// Per-workflow conversion
// ---------------------------------------------------------------------------

const MARK = (expr) => `<<n8n: ${clean(expr).slice(0, 160)}>>`;

/** Personal email addresses and author resource ids in a sticky note, replaced by a neutral marker. */
function scrubNote(text) {
  const found = scanLiterals('notes', text).filter((f) => f.code === 'personal-email' || f.code === 'upstream-literal-id');
  let out = '';
  let at = 0;
  for (const f of found) {
    if (f.start < at) continue;
    out += text.slice(at, f.start) + (f.code === 'personal-email' ? '[email removed]' : '[id removed]');
    at = f.start + f.text.length;
  }
  return out + text.slice(at);
}

/** n8n node types that only reshape data: a loop over them is the same work done once over the whole list. */
const SAFE_LOOP_TYPES = new Set([
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.wait',
  'n8n-nodes-base.set',
  'n8n-nodes-base.code',
  'n8n-nodes-base.function',
  'n8n-nodes-base.functionItem',
  'n8n-nodes-base.splitOut',
  'n8n-nodes-base.aggregate',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.removeDuplicates',
  'n8n-nodes-base.summarize',
  'n8n-nodes-base.itemLists',
  'n8n-nodes-base.renameKeys',
  'n8n-nodes-base.dateTime',
]);

class Converter {
  constructor(n8n, info) {
    this.n8n = n8n;
    this.info = info; // { slug, name, description, category, categoryLabel, department, sourcePath }
    this.nodes = [];
    this.edges = [];
    this.edgeKeys = new Set();
    this.units = new Map(); // n8n node name -> unit
    this.labels = new Set();
    this.report = { unmapped: [], approximate: [], folded: [], removedEdges: [], notes: [], nodes: {}, triggers: [] };
    this.setup = new Set();
    this.seeds = {};
    this.connectors = new Set();
    this.startUnit = null;
    this.loopPolicy = null;
    // Setup values and workflow secrets (lib/setup.mjs). Run-input seeds keep their names.
    this.reg = new SetupRegistry({ has: (k) => Object.prototype.hasOwnProperty.call(this.seeds, k) });
  }

  // -- setup values and secrets ------------------------------------------------

  /** A `{{key}}` token for a setup value the person supplies before import. */
  setupVar(spec, nodeName) {
    return this.reg.variable({ ...spec, node: nodeName });
  }

  /** Declare a workflow secret for an auth plan (lib/setup.mjs authPlan) and return its run-context key. */
  secretFor(plan, nodeName) {
    return this.reg.secret({ key: plan.key, label: plan.label, host: plan.host, headerFormat: headerFormat(plan), node: nodeName, oauth: plan.oauth });
  }

  /** The header value for an auth plan, with the secret as a run-context token. */
  authValue(plan, nodeName) {
    return plan.format.replace('{v}', `{{${this.secretFor(plan, nodeName)}}}`);
  }

  // -- helpers ---------------------------------------------------------------

  id(role, name) {
    return crypto.createHash('sha1').update(`${this.info.slug}|${role}|${name}`).digest('hex').slice(0, 10);
  }

  uniqueLabel(label) {
    let base = clean(label).slice(0, 60) || 'Node';
    let candidate = base;
    let i = 2;
    while (this.labels.has(candidate)) candidate = `${base} ${i++}`;
    this.labels.add(candidate);
    return candidate;
  }

  addNode(role, n8nNode, type, label, inputs, extra = {}) {
    const hash = this.id(role, n8nNode.name);
    const spec = NODE_TYPES[type];
    const node = {
      nodeId: `node_${hash}`,
      actorId: `actor_${hash}`,
      type,
      label: type === 'NodeCdeConnector' ? label : this.uniqueLabel(label),
      color: spec.color,
      position: { x: 0, y: 0 },
      size: { ...spec.size },
    };
    const cleanInputs = {};
    for (const [k, v] of Object.entries(inputs || {})) if (v !== undefined) cleanInputs[k] = v;
    if (Object.keys(cleanInputs).length) node.inputs = cleanInputs;
    this.nodes.push(node);
    this.report.nodes[node.nodeId] = { n8n: n8nNode.name, n8nType: n8nNode.type, ...extra };
    return node;
  }

  addEdge(from, to) {
    if (!from || !to) return;
    const key = `${from.nodeId}:${from.socket}>${to.nodeId}:${to.socket}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    const src = this.nodes.find((n) => n.nodeId === from.nodeId);
    const dst = this.nodes.find((n) => n.nodeId === to.nodeId);
    this.edges.push({
      source: from.nodeId,
      target: to.nodeId,
      sourceOutput: from.socket,
      targetInput: to.socket,
      sourceNodeType: src.type,
      targetNodeType: dst.type,
    });
  }

  sock(node, socket) {
    return { nodeId: node.nodeId, socket };
  }

  dataExit(node) {
    const key = DATA_OUTPUT[node.type];
    return key ? { nodeId: node.nodeId, socket: key, key, nodeType: node.type } : null;
  }

  simpleUnit(name, kind, node, flags = {}) {
    const unit = {
      name,
      kind,
      entry: RUN_INPUT[node.type] ? this.sock(node, RUN_INPUT[node.type]) : null,
      dataIn: node.type === 'NodeTransform' ? () => this.sock(node, 'source') : null,
      exits: [{ trigger: DONE_OUTPUT[node.type] ? this.sock(node, DONE_OUTPUT[node.type]) : null, data: this.dataExit(node) }],
      flags,
      lastNode: node,
    };
    // Stable step keys so $('NodeName') can resolve to {{steps.<key>.result…}} for Transforms/HTTP too.
    if (flags.stepKey) unit.stepKey = flags.stepKey;
    else if (node.type === 'NodeTransform') unit.stepKey = `xf_${node.nodeId.slice(5)}`;
    else if (node.type === 'NodeHttpRequest') unit.stepKey = `http_${node.nodeId.slice(5)}`;
    else if (node.type === 'NodeCdeGenerateObject') unit.stepKey = `obj_${node.nodeId.slice(5)}`;
    else if (node.type === 'NodeCdecliChatCompletion' || node.type === 'NodeCdecliAgent') unit.stepKey = `llm_${node.nodeId.slice(5)}`;
    return unit;
  }

  // -- graph preparation -----------------------------------------------------

  prepare() {
    const nodes = (this.n8n.nodes || []).filter((n) => n && n.name && n.type);
    this.byName = new Map(nodes.map((n) => [n.name, n]));
    this.mainOut = new Map();
    this.aiIn = new Map();
    this.aiSources = new Set();
    for (const [src, outs] of Object.entries(this.n8n.connections || {})) {
      for (const [ctype, arr] of Object.entries(outs || {})) {
        if (ctype === 'main') {
          this.mainOut.set(src, (arr || []).map((a) => (a || []).filter((t) => t && this.byName.has(t.node))));
        } else {
          for (const list of arr || []) {
            for (const t of list || []) {
              if (!t || !this.byName.has(t.node)) continue;
              const m = this.aiIn.get(t.node) || {};
              (m[ctype] ||= []).push(src);
              this.aiIn.set(t.node, m);
              this.aiSources.add(src);
            }
          }
        }
      }
    }

    this.disposition = new Map();
    for (const n of nodes) {
      const cls = M.classify(n.type);
      if (n.type === 'n8n-nodes-base.stickyNote') {
        const content = clean(n.parameters?.content || '').replace(/\s+/g, ' ');
        // The author's notes ship as documentation; their email addresses and resource ids do not.
        if (content && !/^#*\s*$/.test(content)) this.report.notes.push(scrubNote(String(n.parameters?.content || '').replace(/\u2014/g, '-').trim()));
        this.disposition.set(n.name, 'drop');
      } else if (n.disabled) {
        this.disposition.set(n.name, 'bypass');
        this.report.folded.push({ node: n.name, type: n.type, reason: 'disabled in the original' });
      } else if (cls === 'drop') {
        this.disposition.set(n.name, 'bypass');
      } else if (cls === 'fold' || (this.aiSources.has(n.name) && !(this.mainOut.get(n.name) || []).some((a) => a.length))) {
        this.disposition.set(n.name, 'fold');
      } else {
        this.disposition.set(n.name, 'unit');
      }
    }

    // Effective edges: skip bypassed nodes, drop folded/dropped targets.
    const targets = (name, outIdx, guard = new Set()) => {
      const out = [];
      for (const t of (this.mainOut.get(name) || [])[outIdx] || []) {
        const d = this.disposition.get(t.node);
        if (d === 'unit') out.push(t);
        else if (d === 'bypass' && !guard.has(t.node)) {
          guard.add(t.node);
          out.push(...targets(t.node, 0, guard));
        }
      }
      return out;
    };
    this.rawEdges = [];
    for (const n of nodes) {
      if (this.disposition.get(n.name) !== 'unit') continue;
      const outs = this.mainOut.get(n.name) || [];
      for (let outIdx = 0; outIdx < outs.length; outIdx++) {
        for (const t of targets(n.name, outIdx)) this.rawEdges.push({ src: n.name, outIdx, dst: t.node, inIdx: t.index || 0 });
      }
    }

    const unitNames = nodes.filter((n) => this.disposition.get(n.name) === 'unit').map((n) => n.name);
    this.itemLoops = planItemLoops(unitNames.map((name) => this.byName.get(name)), this.rawEdges);
    this.loopReturns = new Set([...this.itemLoops.values()].filter((p) => p.native).flatMap((p) => p.returns));
    const takeSelfEdges = new Set([...this.itemLoops.values()].filter((p) => p.takeOnly).flatMap((p) => p.selfEdges));
    // Native feedback is wired to NEXT after building the DAG.
    const itemForward = this.rawEdges.filter((e) => !this.loopReturns.has(e) && !takeSelfEdges.has(e));
    const repeats = planRepeatLoops(unitNames.map((name) => this.byName.get(name)), itemForward, this.rawEdges);
    this.repeatLoops = repeats.plans;
    this.repeatReturns = new Set([...this.repeatLoops.values()].flatMap((p) => p.returns));
    this.repeatIntercepts = new Set([...this.repeatLoops.values()].flatMap((p) => [...p.returns, ...p.exits]));
    this.repeatBody = new Set([...this.repeatLoops.values()].flatMap((p) => [...p.body]));
    for (const { name, reason } of repeats.deferred) this.setup.add(`"${name}" remains a conditional-loop conversion candidate: ${reason}.`);
    const forwardEdges = itemForward.filter((e) => !this.repeatReturns.has(e));
    const adj = new Map(unitNames.map((n) => [n, []]));
    for (const e of forwardEdges) adj.get(e.src).push(e);
    const indeg = new Map(unitNames.map((n) => [n, 0]));
    for (const e of forwardEdges) indeg.set(e.dst, indeg.get(e.dst) + 1);
    const color = new Map();
    const back = new Set();
    const visit = (name) => {
      color.set(name, 'gray');
      for (const e of adj.get(name)) {
        const c = color.get(e.dst);
        if (c === 'gray') back.add(e);
        else if (!c) visit(e.dst);
      }
      color.set(name, 'black');
    };
    for (const n of unitNames) if (indeg.get(n) === 0 && !color.has(n)) visit(n);
    for (const n of unitNames) if (!color.has(n)) visit(n);
    this.edgesKept = forwardEdges.filter((e) => !back.has(e));
    for (const e of back) this.report.removedEdges.push({ from: e.src, to: e.dst });
    if (back.size) {
      // A loop whose body only reshapes data (Set, Code, split, filter, batching, waits)
      // does the same work in one pass over the whole list; anything that calls a
      // service or branches per item does not.
      const reach = (from) => {
        const seen = new Set([from]);
        const q = [from];
        while (q.length) {
          const x = q.shift();
          for (const e of this.rawEdges) {
            if (e.src === x && !seen.has(e.dst)) {
              seen.add(e.dst);
              q.push(e.dst);
            }
          }
        }
        return seen;
      };
      const body = new Set();
      for (const e of back) for (const x of reach(e.dst)) if (reach(x).has(e.src)) body.add(x);
      const safe = [...body].every((x) => SAFE_LOOP_TYPES.has(this.byName.get(x)?.type)) &&
        ![...this.itemLoops.values()].some((p) => p.returns.length && !p.native);
      this.loopPolicy = safe ? 'flattened-safe' : 'flattened';
      this.setup.add(
        safe
          ? 'The original looped over items in batches; every step inside the loop only reshapes data, so here the whole list flows through once (loopPolicy=flattened-safe).'
          : 'Unsupported loop edges from the original were removed (loopPolicy=flattened); these paths still run once. Supported item and conditional loops use NodeLoop and NodeRepeatUntil.',
      );
    } else if (this.loopReturns.size || this.repeatReturns.size) this.loopPolicy = 'native';

    // Topological order.
    const indeg2 = new Map(unitNames.map((n) => [n, 0]));
    for (const e of this.edgesKept) indeg2.set(e.dst, indeg2.get(e.dst) + 1);
    const queue = unitNames.filter((n) => indeg2.get(n) === 0);
    this.order = [];
    const seen = new Set();
    while (queue.length) {
      const n = queue.shift();
      if (seen.has(n)) continue;
      seen.add(n);
      this.order.push(n);
      for (const e of this.edgesKept) if (e.src === n) {
        indeg2.set(e.dst, indeg2.get(e.dst) - 1);
        if (indeg2.get(e.dst) === 0) queue.push(e.dst);
      }
    }
    for (const n of unitNames) if (!seen.has(n)) this.order.push(n);
    this.incoming = new Map();
    for (const e of this.edgesKept) (this.incoming.get(e.dst) || this.incoming.set(e.dst, []).get(e.dst)).push(e);

    // HTTP requests whose response is a file another step reads as n8n binary data:
    // they run on yantra-storage HTTP_SEND so the bytes come back as base64.
    this.binaryHttp = new Set();
    for (const n of nodes) {
      if (this.disposition.get(n.name) !== 'unit') continue;
      if (!binaryConsumer(n)) continue;
      const o = this.binaryOrigin(n.name);
      if (o.ok && this.byName.get(o.from || o.name)?.type === 'n8n-nodes-base.httpRequest') this.binaryHttp.add(o.from || o.name);
    }
  }

  // -- binary files ------------------------------------------------------------

  /**
   * Where the n8n binary file a node reads comes from. n8n carries binary data
   * along with each item, so the producer can sit several steps upstream (past
   * IF / Merge / Set / loops, or a write-then-read on the n8n host disk). On
   * Yantra a file travels as base64 bytes or a file URL on the producing step's
   * output, so the consumer reads it from that step by name.
   *
   * @returns {{ ok: boolean, name?: string, from?: string, mode?: 'url'|'base64', hops?: number, reason?: string }}
   *   `name` is the step whose output holds the file, `mode` how it holds it,
   *   `hops` 1 when it is the immediate upstream step; `reason` says why not.
   */
  binaryOrigin(name) {
    const preds = (x) => {
      const out = [];
      for (const [src, outs] of this.mainOut) for (const arr of outs) for (const t of arr) if (t.node === x && !out.includes(src)) out.push(src);
      return out;
    };
    const seen = new Set([name]);
    const fails = [];
    const visit = (cur, hops) => {
      for (const src of preds(cur)) {
        if (seen.has(src)) continue;
        seen.add(src);
        const r = classify(src, hops + 1);
        if (r?.ok) return r;
        if (r) fails.push(r);
      }
      return null;
    };
    const classify = (src, hops) => {
      const n = this.byName.get(src);
      const p = n.parameters || {};
      const t = n.type;
      const short = t.replace(/^.*\./, '');
      const op = p.operation;
      // A start / trigger node is where the file really enters the run, so its reason wins.
      const fail = (why) => ({ ok: false, name: src, start: /Trigger$|^n8n-nodes-base\.(?:webhook|formTrigger|form)$/.test(t), reason: `the file comes from "${src}" (${short}), which ${why}` });
      if (n.disabled || this.disposition.get(src) === 'bypass') return visit(src, hops);
      if (t === 'n8n-nodes-base.googleDrive') return op === 'download' ? { ok: true, name: src, mode: 'url', hops } : fail('does not download a file');
      if (t === 'n8n-nodes-base.httpRequest') {
        if (!httpReturnsFile(p)) return fail('returns an API response, not a file (n8n drops the incoming binary at an HTTP step)');
        const reach = httpFileReachable(p.url);
        return reach.ok ? { ok: true, name: src, mode: 'base64', hops } : fail(reach.why);
      }
      if (t === '@n8n/n8n-nodes-langchain.openAi' || t === 'n8n-nodes-base.openAi') {
        const gen = (op ?? 'generate') === 'generate';
        if (p.resource === 'image' && gen) return { ok: true, name: src, mode: 'url', hops };
        if (p.resource === 'audio' && gen) return { ok: true, name: src, mode: 'url', hops };
        return fail('does not produce a file');
      }
      if (t === 'n8n-nodes-base.code' || t === 'n8n-nodes-base.function' || t === 'n8n-nodes-base.functionItem') {
        const code = String(p.jsCode ?? p.functionCode ?? '');
        const rn = renamedBinary(code);
        if (rn && this.byName.has(rn.from) && !seen.has(rn.from)) {
          seen.add(rn.from);
          const inner = classify(rn.from, hops + 1);
          return inner?.ok ? { ...inner, name: src, from: inner.from || inner.name, hops } : inner;
        }
        // Code that builds binary from its own data (base64 from a shell step, ...) hands the
        // file over; Code that re-shuffles the upstream item's binary passes it through.
        const live = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
        if (/\bbinary\s*:/.test(live) && !/\.binary\b|\$binary\b/.test(live)) return { ok: true, name: src, mode: 'base64', hops };
        // Code that picks the binary of a named step (`$('Form').first().binary`): that step is the source.
        if (/\.binary\b|\$binary\b/.test(live)) {
          for (const m of live.matchAll(/\$\(\s*(['"])(.+?)\1\s*\)/g)) {
            const ref = m[2];
            if (!this.byName.has(ref) || seen.has(ref)) continue;
            seen.add(ref);
            const r = classify(ref, hops + 1);
            if (r?.ok) return r;
            if (r) fails.push(r);
          }
        }
        return visit(src, hops);
      }
      if (t === 'n8n-nodes-base.convertToFile') return { ok: true, name: src, mode: 'base64', hops };
      if (t === 'n8n-nodes-base.writeBinaryFile' || (t === 'n8n-nodes-base.readWriteFile' && op === 'write') || t === 'n8n-nodes-base.moveBinaryData') return visit(src, hops);
      if (t === 'n8n-nodes-base.readBinaryFile' || t === 'n8n-nodes-base.readWriteFile') {
        const writer = this.diskWriter(n);
        if (!writer || seen.has(writer)) return fail('reads a file from the n8n host disk, and no step of this workflow writes that path');
        seen.add(writer);
        return visit(writer, hops + 1);
      }
      if (BINARY_PASS_TYPES.has(t)) return visit(src, hops);
      // Image information / split-out keep the item's binary as is.
      if (t === 'n8n-nodes-base.editImage' && op === 'information') return visit(src, hops);
      if (t === 'n8n-nodes-base.splitOut' && p.options?.includeBinary !== false) return visit(src, hops);
      if (t === 'n8n-nodes-base.editImage') return fail('edits the image with yantra-image-editing, whose result is not handed over as this file');
      if (/gmail|emailReadImap|microsoftOutlook/i.test(t)) return fail('hands over email attachments as metadata, not as file bytes or a file URL');
      if (t === 'n8n-nodes-base.webhook' || t === 'n8n-nodes-base.formTrigger' || t === 'n8n-nodes-base.form') return fail('starts the run; the Yantra start payload carries no uploaded file bytes');
      if (/Trigger$/.test(t)) return fail('starts the run with event metadata, not file bytes');
      return fail('does not hand over file bytes or a file URL on Yantra');
    };
    return visit(name, 0) || fails.find((f) => f.start) || fails[0] || { ok: false, reason: 'no upstream step hands over a file' };
  }

  /** The step that wrote the path a readBinaryFile / readWriteFile(read) node reads back. */
  diskWriter(n) {
    const p = n.parameters || {};
    const path = String(p.filePath ?? p.fileSelector ?? '');
    const writers = [...this.byName.values()].filter((w) => w.type === 'n8n-nodes-base.writeBinaryFile' || (w.type === 'n8n-nodes-base.readWriteFile' && w.parameters?.operation === 'write'));
    for (const w of writers) {
      const ref = new RegExp(`\\$\\(\\s*['"]${w.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`);
      if (ref.test(path) || (path && String(w.parameters?.fileName ?? '') === path)) return w.name;
    }
    return null;
  }

  /**
   * JS expression (for a params builder with FILE_REF in its prelude) that
   * reads the file an n8n node consumed as binary property `prop`.
   */
  fileRefJs(origin, prop) {
    // `source` is the immediate upstream output (__fileRef takes the first item of a list).
    const ref = origin.hops === 1 ? 'source' : this.stepRefJs(origin.name);
    return `__fileRef(${ref}, ${JSON.stringify(prop || 'data')})`;
  }

  /**
   * JS for the output of an earlier step, read straight from the run context
   * (`{{steps.<key>.result}}`, the Start payload as `{{ctx}}`), so the step
   * needs no `$('Node')` shim.
   */
  stepRefJs(name) {
    const unit = this.units.get(name);
    if (unit?.kind === 'start') return '{{ctx}}';
    if (this.repeatLoops?.size) return `$(${JSON.stringify(name)}).first().json`;
    if (unit?.stepKey) return `{{steps.${unit.stepKey}.result}}`;
    return `$(${JSON.stringify(name)}).first().json`;
  }

  /**
   * A connector's file params from the upstream file: `keys.b64` (+ name/mime)
   * when the origin hands over bytes, `keys.url` (+ urlName/urlMime) when it
   * hands over a URL. Only the keys for the origin's mode are emitted.
   */
  fileParamsJs(origin, prop, keys) {
    const obj = (pairs) => `{ ${pairs.filter(([k]) => k).map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')} }`;
    const ref = this.fileRefJs(origin, prop);
    if (origin.mode === 'url') {
      return `(() => { const __f = ${ref}; if (__f.fileUrl === undefined) throw new Error("expected a file URL from ${origin.name.replace(/["\\]/g, '')}"); return ${obj([[keys.url, '__f.fileUrl'], [keys.urlName, '__f.filename'], [keys.urlMime, '__f.mimeType']])}; })()`;
    }
    return `(() => { const __f = ${ref}; return __f.contentBase64 !== undefined ? ${obj([[keys.b64, '__f.contentBase64'], [keys.name, '__f.filename'], [keys.mime, '__f.mimeType']])} : ${obj([[keys.url, '__f.fileUrl'], [keys.urlName ?? keys.name, '__f.filename'], [keys.urlMime ?? keys.mime, '__f.mimeType']])}; })()`;
  }

  /**
   * Emit a connector whose params combine static values with the upstream
   * file (`fileJs`, a JS object expression). Required configuration params
   * become setup values first, like any other connector step.
   */
  emitFileConnector(n, connector, label, action, staticParams, fileJs, pred, flags = {}) {
    const filled = this.fillSetupParams(n, connector, action, staticParams);
    const clean = Object.fromEntries(Object.entries(filled).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const code = Object.keys(clean).length ? `Object.assign(${X.toJs(clean)}, ${fileJs})` : fileJs;
    return this.emitConnector(n, connector, label, action, new X.RawJs(code), pred, { ...flags, prelude: `${FILE_REF}${flags.prelude || ''}` });
  }

  /** Report a file mapping whose upstream does not hand over a file, with the precise reason. */
  fileGap(n, what, action, origin) {
    const reason = origin.reason || 'no upstream step hands over a file';
    this.report.approximate.push({ node: n.name, n8n: what, action, reason });
    this.setup.add(`"${n.name}" (${what}): ${reason}; hand the file over as base64 bytes or a public https URL before this step.`);
  }

  /** Where the data flowing out of `unit`'s output `outIdx` comes from. */
  resolveData(unit, outIdx, guard = new Set()) {
    if (!unit || guard.has(unit.name)) return null;
    guard.add(unit.name);
    const exit = unit.exits[Math.min(outIdx, unit.exits.length - 1)];
    if (!exit) return null;
    if (exit.data && exit.data !== 'inherit') return exit.data;
    if (exit.data === null && unit.kind === 'start') return { start: true };
    const inc = (this.incoming.get(unit.name) || [])[0];
    if (!inc) return unit.kind === 'start' ? { start: true } : null;
    return this.resolveData(this.units.get(inc.src), inc.outIdx, guard);
  }

  /** Information about the upstream payload for token rendering. */
  predInfo(name) {
    if (this.predOverride?.name === name) return this.predOverride.pred;
    const inc = (this.incoming.get(name) || [])[0];
    if (!inc) return { start: true };
    const d = this.resolveData(this.units.get(inc.src), inc.outIdx);
    if (!d || d.start) return { start: true };
    return { key: d.key, nodeType: d.nodeType, unit: this.units.get(inc.src) };
  }

  // -- expression rendering --------------------------------------------------

  /**
   * n8n LLM nodes wrap their answer (`{ text }`, `{ output }`,
   * `{ message: { content } }`); Yantra's LLM nodes emit the answer itself on
   * `text` / `object`. Drop the wrapper from a path that reads the upstream LLM.
   */
  stripLlmPath(path, pred) {
    if (!path) return path;
    const parts = path.split('.');
    if (pred.nodeType === 'NodeCdeGenerateObject') {
      if (parts[0] === 'output') parts.shift();
      return parts.join('.');
    }
    if (pred.nodeType === 'NodeCdecliChatCompletion' || pred.nodeType === 'NodeCdecliAgent') {
      // Historical summarization chains returned response.text/output_text.
      if (parts[0] === 'response' && ['text', 'output_text'].includes(parts[1])) parts.splice(0, 2);
      else if (parts[0] === 'message' && parts[1] === 'content') parts.splice(0, 2);
      // Anthropic messages (`content[0].text`) and Gemini (`candidates[0].content.parts[0].text`).
      else if (parts[0] === 'content' && /^\d+$/.test(parts[1] || '') && parts[2] === 'text') parts.splice(0, 3);
      else if (parts[0] === 'candidates') {
        const i = parts.lastIndexOf('text');
        parts.splice(0, i === -1 ? parts.length : i + 1);
      } else if (parts[0] === 'choices') {
        const i = parts.indexOf('content');
        parts.splice(0, i === -1 ? parts.length : i + 1);
      } else if (['text', 'output', 'content', 'response'].includes(parts[0])) parts.shift();
      return parts.join('.');
    }
    return path;
  }

  tokenResolver(pred) {
    // A run-context token is `{{path}}` with a plain dotted path. A key such as
    // "What's your email ?" cannot be one, so that value goes through a Transform.
    const plain = /^[\w$][\w$.[\]-]*$/;
    const inner = this.tokenResolverRaw(pred);
    return (c) => {
      const t = inner(c);
      if (t == null) return t;
      const m = /^\{\{(.*)\}\}$/.exec(t);
      return m && !plain.test(m[1]) ? null : t;
    };
  }

  tokenResolverRaw(pred) {
    return (c) => {
      if (c.kind === 'self') {
        if (pred.start) return `{{${c.path || 'ctx'}}}`;
        const path = this.stripLlmPath(c.path, pred);
        return `{{last.${pred.key}${path ? '.' + path : ''}}}`;
      }
      const unit = this.units.get(c.node);
      if (unit?.kind === 'start') return `{{${c.path || 'ctx'}}}`;
      if (this.repeatLoops?.size) return null;
      // Loop item adapters publish by label in both the canvas and server
      // runtime. Resolve named-loop expressions in a wired Transform.
      if (['loop', 'mapped', 'initialized'].includes(unit?.kind)) return null;
      const srcNode = this.byName.get(c.node);
      if (
        srcNode &&
        (srcNode.type === 'n8n-nodes-base.executeWorkflowTrigger' ||
          srcNode.type === 'n8n-nodes-base.manualTrigger' ||
          srcNode.type === 'n8n-nodes-base.webhook' ||
          srcNode.type === 'n8n-nodes-base.formTrigger' ||
          srcNode.type === 'n8n-nodes-base.form' ||
          srcNode.type === '@n8n/n8n-nodes-langchain.chatTrigger' ||
          srcNode.type === '@n8n/n8n-nodes-langchain.manualChatTrigger')
      ) {
        return `{{${c.path || 'ctx'}}}`;
      }
      if (unit?.stepKey) return `{{steps.${unit.stepKey}.result${c.path ? '.' + c.path : ''}}}`;
      if (unit && pred.unit && unit.name === pred.unit.name) {
        const path = this.stripLlmPath(c.path, pred);
        return `{{last.${pred.key}${path ? '.' + path : ''}}}`;
      }
      // Constant Set fields (cluster URLs, collection names, …) → literal, so HTTP
      // URLs stop carrying <<n8n: $('Variables').json.…>> markers.
      const lit = staticSetLiteral(this.byName.get(c.node), c.path);
      if (lit != null) return lit;
      return null;
    };
  }

  /** Render a value for a static input: tokens when possible, otherwise null. */
  inline(value, pred) {
    if (value instanceof X.RawJs) return null;
    if (!X.containsExpression(value)) return value;
    if (typeof value === 'string') return X.toTokens(value, this.tokenResolver(pred));
    if (Array.isArray(value)) {
      const out = value.map((v) => this.inline(v, pred));
      return out.some((v) => v === null) ? null : out;
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const r = this.inline(v, pred);
        if (r === null) return null;
        out[k] = r;
      }
      return out;
    }
    return value;
  }

  /** Render an expression as marker text when it cannot be a token. */
  markers(value) {
    if (!X.isExpression(value)) return value;
    return X.parseExpression(value)
      .map((s) => (s.expr !== undefined ? MARK(s.expr) : s.text))
      .join('');
  }

  /** Name → payload map for `$('Node')` shims (static Set literals + step tokens). */
  namedPayloadMap(currentName, runtimeOutputs = false) {
    runtimeOutputs ||= this.repeatLoops?.size > 0;
    const map = {};
    const idx = this.order.indexOf(currentName);
    const limit = idx < 0 ? this.order.length : idx;
    for (let i = 0; i < limit; i++) {
      const name = this.order[i];
      const n8n = this.byName.get(name);
      const unit = this.units.get(name);
      if (['loop', 'mapped', 'initialized'].includes(unit?.kind)) {
        const output = unit.kind === 'loop' && !unit.plan.body?.has(currentName) ? unit.doneNode : unit.lastNode;
        map[name] = { kind: 'output', key: output.label, socket: 'transformed' };
        continue;
      }
      if (unit?.kind === 'start') {
        map[name] = { kind: 'ctx' };
        continue;
      }
      const obj = staticSetObject(n8n);
      if (obj) {
        map[name] = { kind: 'literal', value: obj };
        continue;
      }
      if (runtimeOutputs && unit) {
        const data = this.repeatLoops?.size ? this.resolveData(unit, 0) : null;
        const node = data ? this.nodes.find((n) => n.nodeId === data.nodeId) : unit.lastNode;
        const socket = data?.socket || (node && DATA_OUTPUT[node.type]);
        if (socket) map[name] = { kind: 'output', key: node.inputs?.action || node.label, socket,
          llm: ['NodeCdecliChatCompletion', 'NodeCdecliAgent'].includes(node.type) ? 'text' : node.type === 'NodeCdeGenerateObject' ? 'object' : undefined };
      } else if (unit?.stepKey) map[name] = { kind: 'step', key: unit.stepKey };
    }
    return map;
  }

  jsPrelude(body, pred, n8nNode, runtimeOutputs = false) {
    let named = this.namedPayloadMap(n8nNode?.name, runtimeOutputs);
    if (this.loopReturns?.size || this.repeatReturns?.size) {
      // Loop bodies repeat these lookups. Emit only statically referenced
      // names, retaining the full map when the original computes a name.
      const calls = [...body.matchAll(/\$\(\s*(['"])(.*?)\1\s*\)/g)];
      if (calls.length === (body.match(/\$\(/g) || []).length) {
        const names = new Set(calls.map((m) => m[2]));
        named = Object.fromEntries(Object.entries(named).filter(([name]) => names.has(name)));
      }
    }
    let prelude = X.shimPrelude(body, named);
    if (pred?.start && /\$json\b|\$input\b|\$\(|\$node\b|\$items\(|\bsource\b/.test(body)) {
      // No upstream node feeds `source` here (its socket default is {}), so the
      // n8n item is the run context: the run inputs, with the webhook `body`
      // fields also available at top level because n8n authors read both
      // `$json.body.x` and `$json.x`. Direct node inputs, when given, still win.
      prelude =
        '// This step follows the Start node: n8n item data comes from the run inputs.\n' +
        'const __ctx = {{ctx}};\n' +
        "const __hasUpstream = source != null && source !== '' && !(typeof source === 'object' && !Array.isArray(source) && Object.keys(source).length === 0);\n" +
        "source = __hasUpstream ? source : { ...__ctx, ...(__ctx && typeof __ctx.body === 'object' && !Array.isArray(__ctx.body) ? __ctx.body : {}) };\n" +
        prelude;
    }
    return prelude;
  }

  transformNode(n8nNode, role, label, body, pred, extra = {}, runtimeOutputs = false) {
    let code = body;
    if (pred?.nodeType === 'NodeCdecliChatCompletion' || pred?.nodeType === 'NodeCdecliAgent') {
      code = code
        .replace(/(\$json|\$input\.item\.json|\$input\.first\(\)\.json)\.response\.(?:output_text|text)\b/g, '$1')
        .replace(/(\$json|\$input\.item\.json|\$input\.first\(\)\.json)(?:\.content\[0\]\.text|\.candidates\[0\]\.content\.parts\[0\]\.text|\.choices\[0\]\.message\.content)/g, '$1')
        .replace(/(\$json|\$input\.item\.json|\$input\.first\(\)\.json)\.(?:message\.content|choices\[0\]\.message\.content|text|output|content|response)\b/g, '$1');
    } else if (pred?.nodeType === 'NodeCdeGenerateObject') {
      code = code.replace(/(\$json|\$input\.item\.json|\$input\.first\(\)\.json)\.output\b/g, '$1');
    }
    let jsCode = this.jsPrelude(code, pred, n8nNode, runtimeOutputs) + code;
    if (jsCode.includes('const $env = {};')) jsCode = jsCode.replace(/const \$env = \{\};[^\n]*/, this.envShim(code, n8nNode?.name));
    return this.addNode(role, n8nNode, 'NodeTransform', label, { mode: 'jsCode', jsCode }, extra);
  }

  /**
   * n8n `$env.KEY` has no Yantra equivalent. Each key a step reads becomes a
   * setup value (or, for credentials, a workflow secret) and `$env` is rebuilt
   * from the run context, so the original code keeps working unchanged.
   */
  envShim(code, nodeName) {
    const live = code
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    const keys = [...new Set([...live.matchAll(/\$env\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/g)].map((m) => m[1] || m[2]))].sort();
    if (!keys.length) return 'const $env = {}; // n8n environment variables are not available; read run-context values instead';
    const plain = [];
    const secret = [];
    for (const k of keys) {
      if (SECRET_NAME.test(k)) {
        const ctxKey = this.reg.secret({ key: k, label: `${k.replace(/_/g, ' ').toLowerCase()} (was the n8n environment variable ${k})`, headerFormat: `read by the step as $env.${k}`, node: nodeName });
        secret.push(`${JSON.stringify(k)}: "{{${ctxKey}}}"`);
      } else {
        const tok = this.setupVar({ key: camel(k.toLowerCase()), label: `${k.replace(/_/g, ' ').toLowerCase()} (was the n8n environment variable ${k})`, type: /EMAIL|_TO$|_FROM$/.test(k) ? 'email' : /_ID$/.test(k) ? 'id' : /URL|HOST|LINK|PATH/.test(k) ? 'url' : 'text' }, nodeName);
        plain.push(`${JSON.stringify(k)}: __envCtx[${JSON.stringify(tok.slice(2, -2))}]`);
      }
    }
    return [
      '// n8n $env values come from the Workflow Configs initialContext (setup values and workflow secrets).',
      plain.length ? 'const __envCtx = {{ctx}};' : '',
      `const $env = { ${[...plain, ...secret].join(', ')} };`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // -- unit builders ---------------------------------------------------------

  buildStart(n) {
    const p = n.parameters || {};
    const t = n.type;
    this.report.triggers.push({ node: n.name, type: t, as: 'NodeStart' });
    if (t === '@n8n/n8n-nodes-langchain.chatTrigger' || t === '@n8n/n8n-nodes-langchain.manualChatTrigger') {
      this.seeds.chatInput ??= '';
      this.seeds.sessionId ??= '';
      this.setup.add('Provide `chatInput` (and optionally `sessionId`) as run inputs; the original started from a chat message.');
    } else if (t === 'n8n-nodes-base.webhook') {
      this.seeds.body ??= {};
      this.seeds.query ??= {};
      this.seeds.headers ??= {};
      this.setup.add(`The original started from an inbound webhook (${p.httpMethod || 'POST'} /${p.path || ''}). Run it with \`cdecli workflow run <slug> --ver <version> -d '{"body": {...}}'\` or through the workflow API.`);
    } else if (t === 'n8n-nodes-base.formTrigger' || t === 'n8n-nodes-base.form') {
      for (const f of p.formFields?.values || []) if (f?.fieldLabel) this.seeds[f.fieldLabel] ??= '';
      this.setup.add('The original started from a form submission; pass the form fields as run inputs.');
    } else if (t === 'n8n-nodes-base.executeWorkflowTrigger') {
      for (const f of p.workflowInputs?.values || []) if (f?.name) this.seeds[f.name] ??= '';
      this.setup.add('The original was a sub-workflow called by another workflow; pass its inputs as run inputs.');
    } else if (t !== 'n8n-nodes-base.manualTrigger' && t !== 'n8n-nodes-base.start') {
      this.seeds.event ??= {};
      this.setup.add(`The original started from ${t.replace(/^.*\./, '')}; Yantra has no webhook slug for it, so run on demand, on a schedule (add a NodeCron), or via the workflow API with the event under the run input \`event\`.`);
    }
    if (this.startUnit) {
      this.report.nodes[this.startUnit.lastNode.nodeId].also = [...(this.report.nodes[this.startUnit.lastNode.nodeId].also || []), n.name];
      return this.startUnit;
    }
    const node = this.addNode('start', n, 'NodeStart', 'Start', {});
    this.startUnit = { name: n.name, kind: 'start', entry: null, dataIn: null, exits: [{ trigger: this.sock(node, 'trigger'), data: null }], flags: {}, lastNode: node };
    return this.startUnit;
  }

  buildCron(n) {
    this.report.triggers.push({ node: n.name, type: n.type, as: 'NodeCron' });
    const p = n.parameters || {};
    const inputs = cronInputs(n.type, p);
    const node = this.addNode('cron', n, 'NodeCron', n.name, inputs);
    return { name: n.name, kind: 'cron', entry: null, dataIn: null, exits: [{ trigger: this.sock(node, 'onTick'), data: this.dataExit(node) }], flags: {}, lastNode: node };
  }

  buildWebhook(n, spec) {
    const p = n.parameters || {};
    const slug = typeof spec.slug === 'function' ? spec.slug(p) : spec.slug;
    if (!catalog[spec.connector]?.triggers?.includes(slug)) {
      this.setup.add(`The original started from ${n.type.replace(/^.*\./, '')}; the ${spec.connector} connector has no matching trigger slug yet, so run on demand or on a schedule.`);
      return this.buildStart(n);
    }
    this.report.triggers.push({ node: n.name, type: n.type, as: 'NodeCdeWebhookTrigger' });
    const node = this.addNode('webhook', n, 'NodeCdeWebhookTrigger', `Webhook: ${spec.connector}/${slug}`, {
      connector: spec.connector,
      webhookEndpointId: '',
      triggerSlug: slug,
      connectedAccountId: '',
      config: {},
      responseMode: 'onReceived',
    });
    this.connectors.add(spec.connector);
    this.setup.add(
      `"${n.name}" is a provider webhook (${spec.connector}/${slug}). Create the endpoint and trigger instance, then paste the we_… id and connected account into this node before the first run: \`cdecli webhook endpoint create -c ${spec.connector} --client-id <id>\`, \`cdecli webhook endpoint set-data <we_id> --signing-secret <secret>\`, \`cdecli trigger instance upsert --slug ${slug} --account <connectedAccountId>\`.`,
    );
    return { name: n.name, kind: 'webhook', entry: null, dataIn: null, exits: [{ trigger: this.sock(node, 'onEvent'), data: this.dataExit(node) }], flags: { webhook: true }, lastNode: node };
  }

  /** A connector action, with a params-builder Transform when the params need JavaScript. */
  emitConnector(n, connector, connectorLabel, action, params, pred, flags = {}, alias = '') {
    this.connectors.add(connector);
    if (!(params instanceof X.RawJs)) params = this.fillSetupParams(n, connector, action, params);
    const label = `${connector}/${action}`;
    const role = alias ? `connector-${alias}` : 'connector';
    const paramsRole = alias ? `params-${alias}` : 'params';
    const inlined = this.inline(params, pred);
    if (inlined !== null) {
      const node = this.addNode(role, n, 'NodeCdeConnector', label, { connectorName: connector, connectorLabel, action, params: inlined }, { approximate: flags.approximate || undefined });
      const unit = this.simpleUnit(n.name, 'service', node, flags);
      unit.stepKey = action;
      return unit;
    }
    const body = `${flags.prelude || ''}// Params for ${label} (n8n node "${n.name}").\nreturn ${params instanceof X.RawJs ? params.code : X.toJsObject(params)};`;
    const builder = this.transformNode(n, paramsRole, `Params: ${n.name}${alias ? ` ${alias}` : ''}`, body, pred);
    const node = this.addNode(role, n, 'NodeCdeConnector', label, { connectorName: connector, connectorLabel, action }, { approximate: flags.approximate || undefined });
    this.addEdge(this.sock(builder, 'onDone'), this.sock(node, 'RUN'));
    this.addEdge(this.sock(builder, 'transformed'), this.sock(node, 'params'));
    return {
      name: n.name,
      kind: 'service',
      entry: this.sock(builder, 'RUN'),
      dataIn: () => this.sock(builder, 'source'),
      exits: [{ trigger: this.sock(node, 'onDone'), data: this.dataExit(node) }],
      flags,
      stepKey: action,
      lastNode: node,
    };
  }

  /**
   * Required connector params the original left empty. Configuration (ids,
   * refs, channels, recipients) becomes a declared setup value; content (the
   * text or file being processed) is left missing, because a static value there
   * would change what the workflow does.
   */
  fillSetupParams(n, connector, action, params) {
    const def = catalog[connector]?.actions?.[action];
    const required = [...new Set([...(def?.params || []).filter((k) => k.startsWith('*')).map((k) => k.slice(1)), ...(EXTRA_REQUIRED[connector]?.[action] || [])])];
    const empty = (v) => v === undefined || v === null || (typeof v === 'string' && (v.trim() === '' || v.trim() === '='));
    let out = params;
    for (const k of required) {
      if (!empty(params?.[k])) continue;
      // Content the original author left blank on purpose (a WhatsApp text, an Outlook body)
      // is for the person to write: a setup value, not a gap in the conversion.
      const spec = paramVar(connector, k) ?? BLANK_CONTENT_VARS[`${connector}/${action}`]?.[k];
      if (!spec) continue;
      if (out === params) out = { ...params };
      out[k] = this.setupVar(spec, n.name);
    }
    // A Sheets tab picked by id (gid=0) instead of by name.
    for (const k of ['range', 'ranges', 'sheet_name']) {
      const v = out?.[k];
      const gid = (x) => typeof x === 'string' && /^gid=\d+$/.test(x);
      if (gid(v) || (Array.isArray(v) && v.some(gid))) {
        if (out === params) out = { ...params };
        const tok = this.setupVar({ key: 'sheetName', label: 'Sheet tab name', type: 'text', example: 'Sheet1' }, n.name);
        out[k] = Array.isArray(v) ? v.map((x) => (gid(x) ? tok : x)) : tok;
      }
    }
    return out;
  }

  /** Wire units of one n8n node so the first entry and the last exit stay visible. */
  chainUnits(name, units) {
    const first = units[0];
    for (let i = 0; i < units.length - 1; i++) {
      const exit = units[i].exits[0];
      const next = units[i + 1];
      if (exit?.trigger && next.entry) this.addEdge(exit.trigger, next.entry);
      const din = next.dataIn?.(0);
      if (exit?.data && exit.data !== 'inherit' && din) this.addEdge({ nodeId: exit.data.nodeId, socket: exit.data.socket }, din);
    }
    const last = units[units.length - 1];
    return { ...first, name, exits: last.exits, lastNode: last.lastNode, flags: last.flags, stepKey: last.stepKey };
  }

  emitImageMultiStep(n, pred) {
    const list = n.parameters?.operations?.operations;
    const spec = M.SERVICES['n8n-nodes-base.editImage'];
    if (!Array.isArray(list) || !list.length) {
      this.report.approximate.push({ node: n.name, n8n: 'image.multiStep', action: 'yantra-image-editing/YANTRA_IMAGE_EDIT_COMPOSE' });
      this.setup.add(`"${n.name}": image multiStep has no operations.`);
      return this.emitConnector(n, 'yantra-image-editing', 'Image editing', 'YANTRA_IMAGE_EDIT_COMPOSE', {}, pred, { approximate: true });
    }
    const units = [];
    const unsupported = [];
    const stepPred = (unit) => {
      const data = unit?.exits?.[0]?.data;
      if (!data || data === 'inherit' || data.start) return null;
      return { key: data.key, nodeType: data.nodeType, unit };
    };
    list.forEach((op, i) => {
      const operation = op?.operation || 'unknown';
      const entry = spec.ops[`image.${operation}`];
      const known = entry && !entry[2]?.approximate;
      const incoming = units.length ? stepPred(units[units.length - 1]) || pred : pred;
      if (!known) {
        unsupported.push(operation);
        const node = this.transformNode(
          n,
          `image-skip-${i}`,
          `${n.name}: ${operation}`,
          `// image ${operation} has no Yantra image-editing action.\nreturn source;`,
          incoming,
        );
        units.push(this.simpleUnit(n.name, 'data', node, { approximate: true }));
        return;
      }
      const params = {};
      for (const [k, s] of Object.entries(entry[1] || {})) {
        if (s && typeof s === 'object' && 'const' in s) {
          if (s.const !== '' && s.const != null) params[k] = s.const;
          continue;
        }
        const v = op?.[s];
        if (v !== undefined && v !== '' && v !== null) params[k] = v;
      }
      units.push(this.emitConnector(n, spec.connector, spec.label, entry[0], params, incoming, {}, String(i)));
    });
    if (unsupported.length) {
      this.report.approximate.push({ node: n.name, n8n: 'image.multiStep', action: 'yantra-image-editing' });
      this.setup.add(`"${n.name}": image operations ${[...new Set(unsupported)].join(', ')} have no Yantra action.`);
    }
    return units.length === 1 ? { ...units[0], name: n.name } : this.chainUnits(n.name, units);
  }

  emitSupabaseRow(n, pred, operation) {
    const p = n.parameters || {};
    const table = M.rl(p.tableId) || M.param(p, 'table') || '';
    const fields = M.baserowFieldMap(p) ?? (p.dataToSend === 'autoMapInputData' && (operation === 'create' || operation === 'update') ? '={{ $json }}' : null);
    const ref = M.param(p, 'projectId') || M.param(p, 'options.ref') || '';
    const id = M.param(p, 'id') || M.param(p, 'rowId') || '';
    const filters = M.supabaseFilterConditions(p);
    const action = {
      create: 'SUPABASE_INSERT_ROW',
      get: 'SUPABASE_SELECT_ROWS',
      getAll: 'SUPABASE_SELECT_ROWS',
      update: 'SUPABASE_UPDATE_ROW',
      delete: 'SUPABASE_DELETE_ROW',
    }[operation] || 'SUPABASE_SELECT_ROWS';
    const params = {};
    if (table) params.table = table;
    if (ref) params.ref = ref;
    if (fields && (operation === 'create' || operation === 'update')) params.fields = fields;
    if (id && operation !== 'create' && operation !== 'getAll') params.id = id;
    if (filters && operation !== 'create') params.filters = filters;
    const needsFields = operation === 'create' || operation === 'update';
    const needsFilter = operation === 'update' || operation === 'delete' || operation === 'get';
    const hasMatch = Boolean(id) || Boolean(filters);
    const approximate = !table || (needsFields && !fields) || (needsFilter && !hasMatch);
    if (approximate) {
      this.report.approximate.push({ node: n.name, n8n: `row.${operation}`, action: `supabase/${action}` });
      this.setup.add(`"${n.name}": Supabase ${operation} needs a table and ${needsFields ? 'fields' : 'an id or filter'} before it can run.`);
    } else if (!ref) {
      this.setup.add(`"${n.name}": set the Supabase project ref (Management API) on ${action}.`);
    }
    return this.emitConnector(n, 'supabase', 'Supabase', action, params, pred, approximate ? { approximate: true } : {});
  }

  /**
   * n8n Postgres insert/update/select/delete as a structured Supabase row
   * action. Values travel as `fields` / `filters`; the connector renders each
   * one as an escaped literal, so no upstream value is ever spliced into SQL.
   */
  emitPostgresRow(n, pred, operation) {
    const p = n.parameters || {};
    const action = { insert: 'SUPABASE_INSERT_ROW', upsert: 'SUPABASE_INSERT_ROW', update: 'SUPABASE_UPDATE_ROW', select: 'SUPABASE_SELECT_ROWS', delete: 'SUPABASE_DELETE_ROW' }[operation];
    if (!action) return this.buildStub(n, `Postgres ${operation} has no Supabase row action`);
    const row = M.postgresRow(p, operation);
    const params = { table: row.table };
    if (row.fields !== undefined) params.fields = row.fields;
    if (row.filters && Object.keys(row.filters).length) params.filters = row.filters;
    const hard = row.problems.length > 0 || operation === 'upsert';
    this.report.approximate.push({ node: n.name, n8n: `database.${operation}`, action: `supabase/${action}`, soft: hard ? undefined : true });
    if (operation === 'upsert') this.setup.add(`"${n.name}": the original upserted; SUPABASE_INSERT_ROW inserts only, so a conflicting row makes this step fail.`);
    for (const problem of row.problems) this.setup.add(`"${n.name}": Postgres ${operation}: ${problem}.`);
    this.setup.add(`"${n.name}": the original ran on a Postgres credential; on Yantra it runs through the Supabase connector. Set the project ref on ${action}.`);
    return this.emitConnector(n, 'supabase', 'Postgres (via Supabase)', action, params, pred, { approximate: true, soft: !hard });
  }

  /**
   * n8n Postgres executeQuery. A query with `{{ }}` interpolation is built in a
   * params Transform whose helpers escape every value (quoted literals get
   * their quotes doubled, bare values must be numbers or become literals,
   * table names must be plain identifiers), so upstream text cannot break out
   * of the SQL. A query that is one whole expression (SQL written by an agent
   * upstream) runs as given and is reported.
   */
  emitPostgresQuery(n, pred) {
    const p = n.parameters || {};
    const q = M.param(p, 'query');
    if (q == null || String(q).replace(/^=/, '').trim() === '') {
      this.report.approximate.push({ node: n.name, n8n: 'database.executeQuery', action: 'supabase/SUPABASE_BETA_RUN_SQL_QUERY' });
      this.setup.add(`"${n.name}": database.executeQuery has no query yet; paste the SQL before running.`);
      return this.emitConnector(n, 'supabase', 'Postgres (via Supabase)', 'SUPABASE_BETA_RUN_SQL_QUERY', {}, pred, { approximate: true });
    }
    const segments = X.isExpression(q) ? X.parseExpression(q) : [];
    const wholeExpression = segments.length === 1 && segments[0].expr !== undefined;
    const interpolated = X.isExpression(q) && segments.some((sg) => sg.expr !== undefined);
    this.report.approximate.push({ node: n.name, n8n: 'database.executeQuery', action: 'supabase/SUPABASE_BETA_RUN_SQL_QUERY', soft: true });
    this.setup.add(`"${n.name}": the original ran on a Postgres credential; on Yantra the SQL runs through the Supabase connector. Set the project ref.`);
    if (wholeExpression) {
      this.setup.add(`"${n.name}": runs SQL produced by an upstream step as-is; give the Supabase credential a least-privilege role.`);
      return this.emitConnector(n, 'supabase', 'Postgres (via Supabase)', 'SUPABASE_BETA_RUN_SQL_QUERY', { query: q }, pred, { approximate: true, soft: true });
    }
    const params = { query: interpolated ? new X.RawJs(X.toSafeSqlJs(q)) : String(q).replace(/^=/, '') };
    return this.emitConnector(n, 'supabase', 'Postgres (via Supabase)', 'SUPABASE_BETA_RUN_SQL_QUERY', params, pred, {
      approximate: true,
      soft: true,
      prelude: interpolated ? `// Interpolated values are escaped before they reach the SQL text.\n${X.SQL_HELPERS}` : '',
    });
  }

  /**
   * n8n Facebook Graph API node: a raw Graph request. POST /{page}/feed maps to
   * FACEBOOK_CREATE_POST; everything else (Instagram media, status reads) is an
   * HTTP request that needs a Graph access token.
   */
  emitFacebookGraph(n, pred) {
    const p = n.parameters || {};
    const method = String(p.httpRequestMethod || 'GET').toUpperCase();
    const edge = p.edge ? String(p.edge).replace(/^\/+/, '') : '';
    const graphNode = p.node ?? '';
    const qp = {};
    for (const x of p.options?.queryParameters?.parameter || []) if (x?.name) qp[x.name] = x.value;
    const fields = (p.options?.fields?.field || []).map((f) => f?.name).filter(Boolean);
    if (method === 'POST' && edge === 'feed' && qp.message !== undefined) {
      return this.emitConnector(n, 'facebook', 'Facebook', 'FACEBOOK_CREATE_POST', { page_id: graphNode, message: qp.message, link: qp.link, published: true }, pred);
    }
    const ver = p.graphApiVersion ? `${p.graphApiVersion}/` : '';
    const seg = (v) => (typeof v === 'string' && v.startsWith('=') ? `{{ ${v.slice(1).replace(/^\s*\{\{|\}\}\s*$/g, '').trim()} }}` : encodeURIComponent(String(v ?? '')));
    const query = method === 'GET' ? { ...qp, ...(fields.length ? { fields: fields.join(',') } : {}) } : fields.length ? { fields: fields.join(',') } : {};
    const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${seg(v)}`).join('&');
    const dynamic = [graphNode, ...Object.values(query)].some((v) => typeof v === 'string' && v.startsWith('='));
    const url = `${dynamic ? '=' : ''}https://graph.facebook.com/${ver}${seg(graphNode)}${edge ? `/${edge}` : ''}${qs ? `?${qs}` : ''}`;
    this.approximateStep(n, 'facebookGraphApi.request', 'Graph API request over HTTP; add the Page or Instagram access token as an Authorization header.', { soft: true });
    const body = method === 'GET' || !Object.keys(qp).length ? undefined : qp;
    return this.emitHttpRequest(n, pred, { url, method, headers: body ? { 'Content-Type': 'application/json' } : {}, body, auth: 'facebookGraphApi' });
  }

  buildService(n, spec, pred) {
    const p = n.parameters || {};
    // n8n leaves parameters that equal their default out of an export, so a
    // missing resource/operation means "the node's default", which differs per
    // resource (Gmail label -> getAll, Airtable base -> getMany, ...). Never
    // borrow another resource's default operation.
    const resource = p.resource ?? spec.defaults.resource;
    const operation =
      p.operation ?? spec.defaults.byResource?.[resource] ?? (resource === spec.defaults.resource ? spec.defaults.operation : undefined);
    if (operation === undefined) return this.buildStub(n, `n8n omitted the operation for resource "${resource}" and its default is not mapped`);
    const key = `${resource}.${operation}`;

    // Ops with no catalog action: honest HTTP stand-ins (Bot API / GitHub Contents / YouTube Data / GA4).
    if (n.type === 'n8n-nodes-base.telegram' && key === 'file.get') return this.emitTelegramFileGet(n, pred);
    if (n.type === 'n8n-nodes-base.telegram' && p.binaryData === true && /^message\.send(?:Photo|Document|Audio|Video|Animation)$/.test(key)) {
      // n8n sent the previous step's binary file; the Bot API also takes a URL, which the
      // platform image / voice steps return. Other binary sources have no URL to send.
      const src = pred?.unit?.lastNode;
      const media = src?.type === 'NodeCdeConnector' ? { 'yantra-image-generation': '={{ $json.imageUrl ?? $json.imageUrls?.[0] }}', 'yantra-voicebox': '={{ $json.audioUrl }}' }[src.inputs?.connectorName] : undefined;
      if (media) {
        this.report.approximate.push({ node: n.name, n8n: key, action: `telegram/${key === 'message.sendPhoto' ? 'TELEGRAM_SEND_PHOTO' : 'TELEGRAM_SEND_DOCUMENT'}`, soft: true });
        this.setup.add(`"${n.name}" sent the generated file by URL instead of as binary.`);
        const photo = key === 'message.sendPhoto';
        return this.emitConnector(n, 'telegram', 'Telegram', photo ? 'TELEGRAM_SEND_PHOTO' : 'TELEGRAM_SEND_DOCUMENT', { chat_id: M.param(p, 'chatId'), [photo ? 'photo' : 'document']: media, caption: M.param(p, 'additionalFields.caption'), parse_mode: M.param(p, 'additionalFields.parse_mode') }, pred);
      }
      return this.emitTelegramFile(n, pred, key);
    }
    if (n.type === 'n8n-nodes-base.jira' && key === 'issueAttachment.add') return this.emitJiraAttachment(n, pred);
    if (n.type === 'n8n-nodes-base.dropbox' && key === 'file.upload' && p.binaryData === true) return this.emitDropboxUpload(n, pred);
    if (n.type === 'n8n-nodes-base.googleDrive' && key === 'file.update' && p.changeFileContent) return this.emitDriveUpdate(n, pred);
    if (n.type === 'n8n-nodes-base.github' && (key === 'file.get' || key === 'file.getContents')) return this.emitGithubFileGet(n, pred);
    if (n.type === 'n8n-nodes-base.github' && key === 'issue.edit') return this.emitGithubIssueEdit(n, pred);
    if (n.type === 'n8n-nodes-base.youTube') return this.emitYoutubeSearch(n, pred);
    // Hacker News "get all" without a keyword lists the latest stories rather than searching.
    if (n.type === 'n8n-nodes-base.hackerNews' && key === 'all.getAll' && !M.param(p, 'additionalFields.keyword')) {
      return this.emitConnector(n, 'hackernews', 'Hacker News', 'HACKERNEWS_GET_LATEST_POSTS', { size: p.returnAll ? undefined : Number(p.limit) || 100, tags: M.param(p, 'additionalFields.tags') }, pred);
    }
    if (n.type === 'n8n-nodes-base.airtable' && key === 'record.upsert') return this.emitAirtableUpsert(n, pred);
    if (n.type === 'n8n-nodes-base.airtable' && key === 'record.update') {
      const match = M.param(p, 'columns.matchingColumns');
      if (Array.isArray(match) && match.length && !match.includes('id') && M.param(p, 'columns.mappingMode') !== 'autoMapInputData' && !M.param(p, 'id')) return this.emitAirtableMatchUpdate(n, pred, match);
    }
    if (n.type === 'n8n-nodes-base.googleSheets' && (key === 'sheet.appendOrUpdate' || key === 'sheet.upsert')) {
      return this.emitSheetsAppendOrUpdate(n, pred);
    }
    if (n.type === 'n8n-nodes-base.googleDrive' && (key === 'file.upload' || key === 'fileFolder.upload')) {
      return this.emitDriveUpload(n, pred, key);
    }
    if (n.type === 'n8n-nodes-base.googleAnalytics' && (key === 'report.get' || !spec.ops[key])) {
      return this.emitGaReport(n, pred);
    }
    if (n.type === 'n8n-nodes-base.slack' && key === 'message.search') {
      return this.emitSlackSearch(n, pred);
    }
    if ((n.type === 'n8n-nodes-base.supabase' || n.type === 'n8n-nodes-base.supabaseTool') && resource === 'row') {
      return this.emitSupabaseRow(n, pred, operation);
    }
    if ((n.type === 'n8n-nodes-base.postgres' || n.type === 'n8n-nodes-base.postgresTool') && operation !== 'executeQuery') {
      return this.emitPostgresRow(n, pred, operation);
    }
    if (n.type === 'n8n-nodes-base.postgres' || n.type === 'n8n-nodes-base.postgresTool') {
      return this.emitPostgresQuery(n, pred);
    }
    if ((n.type === 'n8n-nodes-base.mySql' || n.type === 'n8n-nodes-base.mySqlTool') && operation === 'executeQuery') {
      this.setup.add(`"${n.name}": the original ran this SQL on MySQL; it now runs on Postgres through the Supabase connector, so check MySQL-only syntax (backticks, LIMIT x,y, IFNULL).`);
      return this.emitPostgresQuery(n, pred);
    }
    if (n.type === 'n8n-nodes-base.facebookGraphApi' || n.type === 'n8n-nodes-base.facebookGraphApiTool') {
      return this.emitFacebookGraph(n, pred);
    }
    if (n.type === 'n8n-nodes-base.editImage' && (operation === 'multiStep' || key === 'image.multiStep')) {
      return this.emitImageMultiStep(n, pred);
    }

    let action;
    let params = {};
    let approximate = !!spec.approximate;
    let soft = !!spec.soft;
    const entry = spec.ops[key];
    const known = catalog[spec.connector]?.actions || {};
    if (entry && known[entry[0]]) {
      action = entry[0];
      const paramSpec = entry[1] || {};
      if (entry[2]?.approximate) approximate = true;
      if (entry[2]?.soft) soft = true;
      for (const [k, s] of Object.entries(paramSpec)) {
        const v = typeof s === 'function' ? s(p) : s && typeof s === 'object' && 'const' in s ? s.const : M.param(p, s);
        if (v !== undefined && v !== '' && v !== null) params[k] = v;
      }
    } else {
      const guess = fuzzyAction(known, resource, operation);
      if (!guess) {
        return this.buildStub(n, `no ${spec.connector} action for ${key}`);
      }
      action = guess;
      params = matchParams(known[action]?.params || [], p);
      approximate = true;
      this.report.approximate.push({ node: n.name, n8n: key, action: `${spec.connector}/${action}` });
      this.setup.add(`Verify the action chosen by name match for "${n.name}" (${key} -> ${spec.connector}/${action}) and fill its params.`);
    }
    // MySQL executeQuery runs on ClickHouse: always a hard approximation.
    if (n.type === 'n8n-nodes-base.mySql' && key === 'database.executeQuery') {
      const q = params.query ?? M.param(p, 'query');
      if (q != null && String(q).trim() !== '') {
        soft = false;
        approximate = true;
        this.setup.add(
          `"${n.name}": original was MySQL; mapped to ClickHouse executeQuery which is a different dialect - rewrite the SQL or point this at a Postgres/Supabase connector.`,
        );
      } else {
        approximate = true;
        soft = false;
        this.setup.add(`"${n.name}": database.executeQuery has no query yet; paste the SQL before running.`);
      }
    }
    // Baserow/NocoDB CREATE/UPDATE expect field names flattened onto the body.
    if (action === 'BASEROW_CREATE_ROW' || action === 'BASEROW_UPDATE_ROW' || action === 'NOCODB_CREATE_ROW' || action === 'NOCODB_UPDATE_ROW') {
      const fields = M.baserowFieldMap(p);
      if (params.fields && typeof params.fields === 'object' && !Array.isArray(params.fields)) {
        Object.assign(params, params.fields);
        delete params.fields;
      }
      if (fields) Object.assign(params, fields);
    }
    if (action === 'ELASTICSEARCH_INDEX_DOCUMENT') {
      // The patched action takes the body as `document`.
      const fields = M.baserowFieldMap(p);
      params.document = params.document ?? fields ?? '={{ $json }}';
    }
    if (params.values === M.AUTO_MAP_ROWS) {
      this.report.approximate.push({ node: n.name, n8n: `${key}.autoMap`, action: `${spec.connector}/${action}`, soft: true });
      this.setup.add(`"${n.name}" mapped columns automatically; here each item's fields are appended in their own order, so keep them in the same order as the sheet's header row.`);
    }
    if (approximate && entry) {
      this.report.approximate.push({ node: n.name, n8n: key, action: `${spec.connector}/${action}`, soft: soft || undefined });
      this.setup.add(`"${n.name}": the original used ${spec.label}; check the mapped ${spec.connector}/${action} params before running.`);
    }
    return this.emitConnector(n, spec.connector, spec.label, action, params, pred, { approximate, soft });
  }

  /** Airtable upsert: UPDATE when record id present, else CREATE (soft). */
  emitAirtableUpsert(n, pred) {
    const p = n.parameters || {};
    const id = M.param(p, 'id') ?? M.param(p, 'recordId') ?? M.param(p, 'columns.id');
    const fields = M.param(p, 'columns.value') ?? M.param(p, 'fields') ?? {};
    const baseId = M.param(p, 'base');
    const tableIdOrName = M.param(p, 'table');
    this.approximateStep(n, 'record.upsert', id ? 'Airtable upsert with id → UPDATE_RECORD.' : 'Airtable upsert without id → CREATE_RECORD (no match-key upsert).', { soft: true });
    if (id) {
      return this.emitConnector(n, 'airtable', 'Airtable', 'AIRTABLE_UPDATE_RECORD', { baseId, tableIdOrName, recordId: id, fields }, pred, { approximate: true, soft: true });
    }
    return this.emitConnector(n, 'airtable', 'Airtable', 'AIRTABLE_CREATE_RECORD', { baseId, tableIdOrName, fields }, pred, { approximate: true, soft: true });
  }

  /**
   * Airtable update matched on columns other than the record id: n8n finds the
   * records whose matching columns equal the new values and updates them. Here
   * a Transform builds the filter and the fields from the item, LIST_RECORDS
   * finds the records (filterByFormula) and UPDATE_MULTIPLE_RECORDS updates
   * them (Airtable takes 10 per call).
   */
  emitAirtableMatchUpdate(n, pred, match) {
    const p = n.parameters || {};
    const baseId = M.param(p, 'base');
    const tableIdOrName = M.param(p, 'table');
    const values = M.param(p, 'columns.value') || {};
    const fields = Object.fromEntries(Object.entries(values).filter(([k]) => k !== 'id'));
    const body = [
      `// n8n updated the Airtable records whose ${match.join(', ')} equal the new values; build that filter and the fields from the input.`,
      "const __q = (v) => \"'\" + String(v ?? '').replace(/\\\\/g, '\\\\\\\\').replace(/'/g, \"\\\\'\") + \"'\";",
      `const __fields = ${X.toJs(fields)};`,
      `const __match = ${JSON.stringify(match)};`,
      `return { baseId: ${X.toJs(baseId)}, tableIdOrName: ${X.toJs(tableIdOrName)}, fields: __fields, filterByFormula: 'AND(' + __match.map((k) => '{' + k + '}=' + __q(__fields[k])).join(',') + ')' };`,
    ].join('\n');
    const prep = this.transformNode(n, 'airtable-match', `${n.name}: match`, body, pred);
    const prepUnit = this.simpleUnit(n.name, 'data', prep);
    const prepKey = prepUnit.stepKey;
    const list = this.emitConnector(n, 'airtable', 'Airtable', 'AIRTABLE_LIST_RECORDS', { baseId: '={{ $json.baseId }}', tableIdOrName: '={{ $json.tableIdOrName }}', filterByFormula: '={{ $json.filterByFormula }}' }, { key: 'transformed', nodeType: 'NodeTransform', unit: prepUnit }, {}, 'match');
    const update = this.emitConnector(
      n,
      'airtable',
      'Airtable',
      'AIRTABLE_UPDATE_MULTIPLE_RECORDS',
      new X.RawJs(
        `(() => { const __prep = {{steps.${prepKey}.result}}; const __r = source && typeof source === 'object' && source.data && typeof source.data === 'object' ? source.data : source; const __recs = (__r?.records ?? []).slice(0, 10); if (!__recs.length) throw new Error('No Airtable record matches ' + __prep.filterByFormula + '; the original updated nothing in that case.'); return { "baseId": __prep.baseId, "tableIdOrName": __prep.tableIdOrName, "records": __recs.map((r) => ({ id: r.id, fields: __prep.fields })) }; })()`,
      ),
      { key: 'result', nodeType: 'NodeCdeConnector', unit: list },
    );
    this.report.approximate.push({ node: n.name, n8n: 'record.update.matchColumns', action: 'airtable/AIRTABLE_UPDATE_MULTIPLE_RECORDS', soft: true });
    this.setup.add(`"${n.name}" updates the Airtable records whose ${match.join(', ')} match (LIST_RECORDS with filterByFormula, then UPDATE_MULTIPLE_RECORDS, 10 records per run); when none match, the step stops the run.`);
    return this.chainUnits(n.name, [prepUnit, list, update]);
  }

  /** Sheets appendOrUpdate: LOOKUP when match key present, else APPEND (soft). */
  emitSheetsAppendOrUpdate(n, pred) {
    const p = n.parameters || {};
    const spreadsheetId = M.param(p, 'documentId');
    const range = M.param(p, 'sheetName');
    const match =
      M.param(p, 'columnToMatchOn') ??
      M.param(p, 'matchingColumns') ??
      M.param(p, 'options.columnToMatchOn') ??
      M.param(p, 'lookupColumn');
    const lookupValue = M.param(p, 'valueToMatchOn') ?? M.param(p, 'lookupValue') ?? M.param(p, 'filters.values');
    if (match != null && match !== '') {
      this.approximateStep(
        n,
        'sheet.appendOrUpdate',
        'Sheets upsert with a match key → LOOKUP_SPREADSHEET_ROW (follow with BATCH_UPDATE / CREATE_SPREADSHEET_ROW when the row is missing).',
        { soft: true },
      );
      this.setup.add(
        `"${n.name}": LOOKUP finds the row by ${JSON.stringify(String(match).slice(0, 80))}; add BATCH_UPDATE or CREATE_SPREADSHEET_ROW when you need a true upsert.`,
      );
      return this.emitConnector(
        n,
        'googlesuper',
        'Google Sheets',
        'GOOGLESUPER_LOOKUP_SPREADSHEET_ROW',
        { spreadsheet_id: spreadsheetId, range, query: lookupValue ?? match },
        pred,
        { approximate: true, soft: true },
      );
    }
    this.approximateStep(n, 'sheet.appendOrUpdate', 'Sheets upsert without a match key → APPEND only (soft).', { soft: true });
    return this.emitConnector(
      n,
      'googlesuper',
      'Google Sheets',
      'GOOGLESUPER_SPREADSHEETS_VALUES_APPEND',
      { spreadsheetId, range, values: M.rowValues(p) ?? '={{ $json }}', valueInputOption: 'USER_ENTERED' },
      pred,
      { approximate: true, soft: true },
    );
  }

  /** Drive upload: binary → CREATE_FILE; text → CREATE_FILE_FROM_TEXT. */
  emitDriveUpload(n, pred, key) {
    const p = n.parameters || {};
    const name = M.param(p, 'name') ?? M.param(p, 'fileName') ?? 'file';
    const parent = M.param(p, 'folderId') ?? M.param(p, 'parents');
    const content = M.param(p, 'content') ?? M.param(p, 'fileContent') ?? M.param(p, 'text');
    const binaryHint =
      p.binaryData === true ||
      p.inputDataFieldName ||
      p.binaryPropertyName ||
      (typeof content === 'string' && /binary|base64|\$binary/i.test(content)) ||
      key === 'fileFolder.upload';
    // A file another step produced (download, HTTP response, generated image, Code-built
    // binary): upload its bytes or URL with GOOGLESUPER_UPLOAD_FILE.
    const origin = this.binaryOrigin(n.name);
    const producer = origin.ok ? this.byName.get(origin.from || origin.name) : null;
    const textFile = producer?.type === 'n8n-nodes-base.convertToFile' && (producer.parameters?.operation || 'csv') !== 'toBinary';
    if (origin.ok && !textFile && (binaryHint || !content)) {
      const fileJs = this.fileParamsJs(origin, p.inputDataFieldName || p.binaryPropertyName || 'data', { b64: 'content_base64', url: 'file_url', mime: 'mime_type', urlMime: 'mime_type' });
      this.report.approximate.push({ node: n.name, n8n: 'file.upload', action: 'googlesuper/GOOGLESUPER_UPLOAD_FILE', soft: true });
      this.setup.add(`"${n.name}" uploads the file from "${origin.name}" to Google Drive (bytes or URL) with GOOGLESUPER_UPLOAD_FILE.`);
      return this.emitFileConnector(n, 'googlesuper', 'Google Drive', 'GOOGLESUPER_UPLOAD_FILE', { file_name: name, parent_id: parent, mime_type: M.param(p, 'options.mimeType'), description: M.param(p, 'options.description') }, fileJs, pred);
    }
    if (binaryHint) {
      this.approximateStep(n, 'file.upload', 'Drive binary upload → GOOGLESUPER_CREATE_FILE; wire file bytes/base64 into the upload.', { soft: true });
      return this.emitConnector(
        n,
        'googlesuper',
        'Google Drive',
        'GOOGLESUPER_CREATE_FILE',
        { name, parents: parent, mimeType: M.param(p, 'options.mimeType'), description: M.param(p, 'options.description') },
        pred,
        { approximate: true, soft: true },
      );
    }
    return this.emitConnector(
      n,
      'googlesuper',
      'Google Drive',
      'GOOGLESUPER_CREATE_FILE_FROM_TEXT',
      { file_name: name, parent_id: parent, text_content: content },
      pred,
    );
  }

  /** Drive file.update with new content: GOOGLESUPER_EDIT_FILE with the upstream file's bytes or URL. */
  emitDriveUpdate(n, pred) {
    const p = n.parameters || {};
    const origin = this.binaryOrigin(n.name);
    const params = { file_id: M.param(p, 'fileId'), mime_type: M.param(p, 'updateFields.mimeType') ?? M.param(p, 'options.mimeType') };
    if (!origin.ok) {
      this.fileGap(n, 'file.update', 'googlesuper/GOOGLESUPER_EDIT_FILE', origin);
      return this.emitConnector(n, 'googlesuper', 'Google Drive', 'GOOGLESUPER_EDIT_FILE', params, pred);
    }
    const fileJs = this.fileParamsJs(origin, p.inputDataFieldName || 'data', { b64: 'content_base64', url: 'file_url', mime: 'mime_type', urlMime: 'mime_type' });
    this.setup.add(`"${n.name}" replaces the Drive file's content with the file from "${origin.name}" (GOOGLESUPER_EDIT_FILE).`);
    return this.emitFileConnector(n, 'googlesuper', 'Google Drive', 'GOOGLESUPER_EDIT_FILE', params, fileJs, pred);
  }

  /**
   * Telegram sendPhoto / sendDocument (and audio / video / animation, sent as a
   * document) of a binary file from an upstream step: the patched actions take
   * the bytes (`*_base64`) or a URL the connector downloads (`*_file_url`); a
   * photo URL goes to Telegram as is.
   */
  emitTelegramFile(n, pred, key) {
    const p = n.parameters || {};
    const photo = key === 'message.sendPhoto';
    const action = photo ? 'TELEGRAM_SEND_PHOTO' : 'TELEGRAM_SEND_DOCUMENT';
    const f = photo ? 'photo' : 'document';
    const params = { chat_id: M.param(p, 'chatId'), caption: M.param(p, 'additionalFields.caption'), parse_mode: M.param(p, 'additionalFields.parse_mode'), reply_to_message_id: M.param(p, 'additionalFields.reply_to_message_id') };
    const origin = this.binaryOrigin(n.name);
    if (!origin.ok) {
      this.fileGap(n, key, `telegram/${action}`, origin);
      return this.emitConnector(n, 'telegram', 'Telegram', action, params, pred);
    }
    const urlAsIs = photo && origin.mode === 'url';
    const keys = urlAsIs ? { url: 'photo' } : { b64: `${f}_base64`, name: `${f}_filename`, mime: `${f}_mime_type`, url: `${f}_file_url` };
    let fileJs = this.fileParamsJs(origin, p.binaryPropertyName || 'data', keys);
    const fileName = M.param(p, 'additionalFields.fileName');
    if (fileName && !urlAsIs) fileJs = `Object.assign(${fileJs}, { ${JSON.stringify(`${f}_filename`)}: ${X.toJs(fileName)} })`;
    this.report.approximate.push({ node: n.name, n8n: key, action: `telegram/${action}`, soft: true });
    this.setup.add(`"${n.name}" sends the file from "${origin.name}" ${urlAsIs ? 'by URL' : 'as bytes or a URL the connector downloads'}.`);
    return this.emitFileConnector(n, 'telegram', 'Telegram', action, params, fileJs, pred);
  }

  /** Jira issueAttachment.add: JIRA_ADD_ATTACHMENT with the upstream file's bytes or URL. */
  emitJiraAttachment(n, pred) {
    const p = n.parameters || {};
    const params = { issue_key: M.param(p, 'issueKey') };
    const origin = this.binaryOrigin(n.name);
    if (!origin.ok) {
      this.fileGap(n, 'issueAttachment.add', 'jira/JIRA_ADD_ATTACHMENT', origin);
      return this.emitConnector(n, 'jira', 'Jira', 'JIRA_ADD_ATTACHMENT', params, pred);
    }
    const fileJs = this.fileParamsJs(origin, p.binaryPropertyName || 'data', { b64: 'content_base64', name: 'filename', mime: 'mime_type', url: 'file_url' });
    this.setup.add(`"${n.name}" attaches the file from "${origin.name}" to the Jira issue.`);
    return this.emitFileConnector(n, 'jira', 'Jira', 'JIRA_ADD_ATTACHMENT', params, fileJs, pred);
  }

  /** Dropbox file.upload of a binary file: DROPBOX_UPLOAD_FILE with content_base64 or file_url. */
  emitDropboxUpload(n, pred) {
    const p = n.parameters || {};
    const params = { path: M.param(p, 'path'), mode: p.overwrite ? 'overwrite' : undefined };
    const origin = this.binaryOrigin(n.name);
    if (!origin.ok) {
      this.fileGap(n, 'file.upload', 'dropbox/DROPBOX_UPLOAD_FILE', origin);
      return this.emitConnector(n, 'dropbox', 'Dropbox', 'DROPBOX_UPLOAD_FILE', params, pred);
    }
    const fileJs = this.fileParamsJs(origin, p.binaryPropertyName || 'data', { b64: 'content_base64', url: 'file_url' });
    this.setup.add(`"${n.name}" uploads the file from "${origin.name}" to Dropbox.`);
    return this.emitFileConnector(n, 'dropbox', 'Dropbox', 'DROPBOX_UPLOAD_FILE', params, fileJs, pred);
  }

  /** GitHub issue.edit — no UPDATE action in catalog; PATCH via REST. */
  emitGithubIssueEdit(n, pred) {
    const p = n.parameters || {};
    const owner = M.param(p, 'owner') ?? 'OWNER';
    const repo = M.param(p, 'repository') ?? M.param(p, 'repo') ?? 'REPO';
    const issue = M.param(p, 'issueNumber') ?? M.param(p, 'number') ?? '1';
    const title = M.param(p, 'title') ?? M.param(p, 'editFields.title');
    const body = M.param(p, 'body') ?? M.param(p, 'editFields.body');
    const seg = (v, ph) => {
      if (v == null || v === '') return ph;
      if (typeof v === 'string' && v.startsWith('=')) {
        const b = v.slice(1).trim();
        return b.startsWith('{{') ? b : `{{ ${b} }}`;
      }
      return encodeURIComponent(String(v));
    };
    const dynamic = [owner, repo, issue].some((v) => typeof v === 'string' && String(v).startsWith('='));
    const url = dynamic
      ? `=https://api.github.com/repos/${seg(owner, 'OWNER')}/${seg(repo, 'REPO')}/issues/${seg(issue, '1')}`
      : `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`;
    const patch = {};
    if (title != null && title !== '') patch.title = title;
    if (body != null && body !== '') patch.body = body;
    this.approximateStep(n, 'issue.edit', 'GitHub catalog has no update-issue action; this step PATCHes the Issues REST API.', { soft: true });
    this.setup.add(`"${n.name}": add a GitHub Authorization header (token) on this HTTP step.`);
    return this.emitHttpRequest(n, pred, {
      url,
      method: 'PATCH',
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: Object.keys(patch).length ? patch : '={{ $json }}',
      auth: 'githubApi',
    });
  }

  /** Telegram Bot API getFile — catalog has send/edit but not file download. */
  emitTelegramFileGet(n, pred) {
    const p = n.parameters || {};
    const fileId = M.param(p, 'fileId') ?? '={{ $json.file_id }}';
    this.approximateStep(n, 'telegram.file.get', 'Uses the Telegram Bot API getFile HTTP call with the bot token from a workflow secret; download file_path from the JSON result.', { soft: true });
    const tok = this.reg.secret({ key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token (from @BotFather)', host: 'api.telegram.org', headerFormat: 'URL path /bot<secret>/getFile', node: n.name });
    this.setup.add(`"${n.name}": the file itself is at https://api.telegram.org/file/bot<token>/<file_path>; the token is the TELEGRAM_BOT_TOKEN workflow secret.`);
    const url =
      typeof fileId === 'string' && fileId.startsWith('=')
        ? `=https://api.telegram.org/bot{{${tok}}}/getFile?file_id=${fileId.slice(1)}`
        : `https://api.telegram.org/bot{{${tok}}}/getFile?file_id=${fileId}`;
    return this.emitHttpRequest(n, pred, { url, method: 'GET' });
  }

  /**
   * GitHub file contents. GITHUB_GET_REPOSITORY_CONTENT is the connector action
   * (credential via the GitHub connector); when the published registry does not
   * ship it yet the catalog marks it unimplemented and the template is
   * experimental, instead of falling back to a raw token in a run input.
   */
  emitGithubFileGet(n, pred) {
    const p = n.parameters || {};
    const owner = M.param(p, 'owner');
    const repo = M.param(p, 'repository') ?? M.param(p, 'repo');
    const filePath = M.param(p, 'filePath') ?? M.param(p, 'path');
    return this.emitConnector(n, 'github', 'GitHub', 'GITHUB_GET_REPOSITORY_CONTENT', { owner, repo, path: filePath }, pred);
  }

  /** YouTube Data API search — yantra-youtube-search has no actions in the catalog yet. */
  emitYoutubeSearch(n, pred) {
    const p = n.parameters || {};
    const q = M.param(p, 'q') ?? M.param(p, 'query') ?? M.param(p, 'filters.query') ?? M.param(p, 'title') ?? '';
    const limit = Number(p.limit) || 25;
    this.approximateStep(n, 'youTube.search', 'YouTube search via the Data API HTTP endpoint with a Google API key from a workflow secret.', { soft: true });
    const ytKey = this.reg.secret({ key: 'GOOGLE_API_KEY', label: 'Google API key (YouTube Data API enabled)', host: 'www.googleapis.com', headerFormat: 'query parameter key=<secret>', node: n.name });
    const qPart =
      typeof q === 'string' && q.startsWith('=')
        ? (() => {
            const body = q.slice(1).trim();
            return body.startsWith('{{') ? body : `{{ ${body} }}`;
          })()
        : encodeURIComponent(String(q));
    const url =
      typeof q === 'string' && q.startsWith('=')
        ? `=https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${limit}&q=${qPart}&key={{${ytKey}}}`
        : `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${limit}&q=${qPart}&key={{${ytKey}}}`;
    return this.emitHttpRequest(n, pred, { url, method: 'GET' });
  }

  /**
   * GA4 runReport on the google-analytics connector (credential via the
   * connector, never an access token in a run input). The catalog marks the
   * action unimplemented until the registry publishes it.
   */
  emitGaReport(n, pred) {
    const p = n.parameters || {};
    const propertyId = M.param(p, 'propertyId');
    // n8n GA4 lists: { listName } names a metric/dimension, or `other` with the name in `name`.
    const names = (list, fallback) =>
      (Array.isArray(list) ? list : []).map((x) => ({ name: x?.listName && x.listName !== 'other' ? x.listName : x?.name || fallback })).filter((x) => x.name);
    const metrics = names(M.param(p, 'metricsGA4.metricValues'), 'totalUsers');
    const dimensions = names(M.param(p, 'dimensionsGA4.dimensionValues'), 'date');
    const day = (v) => (typeof v === 'string' && !v.startsWith('=') ? v.slice(0, 10) : v);
    const preset = {
      today: ['today', 'today'],
      yesterday: ['yesterday', 'yesterday'],
      last7days: ['7daysAgo', 'today'],
      last30days: ['30daysAgo', 'today'],
      lastCalendarWeek: ['14daysAgo', '7daysAgo'],
      lastCalendarMonth: ['60daysAgo', '30daysAgo'],
    }[p.dateRange || 'last7days'];
    const dateRanges =
      p.dateRange === 'custom'
        ? [{ startDate: day(M.param(p, 'startDate')) || '30daysAgo', endDate: day(M.param(p, 'endDate')) || 'today' }]
        : [{ startDate: preset?.[0] || '7daysAgo', endDate: preset?.[1] || 'today' }];
    return this.emitConnector(
      n,
      'google-analytics',
      'Google Analytics',
      'GOOGLE_ANALYTICS_RUN_REPORT',
      { property: propertyId, dateRanges, metrics: metrics.length ? metrics : [{ name: 'totalUsers' }], dimensions: dimensions.length ? dimensions : [{ name: 'date' }] },
      pred,
    );
  }

  /** Slack search.messages on the Slack connector (unimplemented until the registry ships it). */
  emitSlackSearch(n, pred) {
    const p = n.parameters || {};
    const q = M.param(p, 'query') ?? M.param(p, 'text');
    this.setup.add(`"${n.name}": Slack search.messages needs a user token (xoxp) with the search:read scope; a bot token cannot search.`);
    return this.emitConnector(n, 'slack', 'Slack', 'SLACK_SEARCH_MESSAGES', { query: q, count: Number(p.limit) || 20 }, pred);
  }

  /** GCS object list — no google-cloud-storage connector in cdecli. */
  emitGcsList(n, pred) {
    const p = n.parameters || {};
    const bucket = M.param(p, 'bucketName') || M.rl(p.bucketName) || 'BUCKET';
    this.approximateStep(n, 'googleCloudStorage.object.list', 'No GCS connector; lists objects via the JSON API with an OAuth access token from a workflow secret.', { soft: true });
    const url =
      typeof bucket === 'string' && bucket.startsWith('=')
        ? `=https://storage.googleapis.com/storage/v1/b/${bucket.slice(1)}/o`
        : `https://storage.googleapis.com/storage/v1/b/${bucket}/o`;
    return this.emitHttpRequest(n, pred, {
      url,
      method: 'GET',
      auth: 'googleCloudStorageOAuth2Api',
    });
  }

  /** n8n Public API — list/get workflows on a self-hosted instance. */
  emitN8nApi(n, pred) {
    const p = n.parameters || {};
    const op = p.operation || 'getAll';
    const wfId = M.rl(p.workflowId) || M.param(p, 'workflowId') || 'WORKFLOW_ID';
    this.approximateStep(n, `n8n.${op}`, 'Reads workflows from an n8n instance Public API; Yantra has no n8n, so this only works against an n8n you still run.');
    const host = this.setupVar({ key: 'n8nHost', label: 'Host of your n8n instance', type: 'url', example: 'n8n.example.com' }, n.name).slice(2, -2);
    const apiKey = this.reg.secret({ key: 'N8N_API_KEY', label: 'n8n Public API key', host: 'your n8n instance', headerFormat: 'X-N8N-API-KEY: <secret>', node: n.name });
    const headers = { 'X-N8N-API-KEY': `{{${apiKey}}}`, Accept: 'application/json' };
    if (op === 'get') {
      const idPart =
        typeof wfId === 'string' && wfId.startsWith('=')
          ? wfId.slice(1).trim().startsWith('{{')
            ? wfId.slice(1).trim()
            : `{{ ${wfId.slice(1).trim()} }}`
          : encodeURIComponent(String(wfId));
      const url =
        typeof wfId === 'string' && wfId.startsWith('=')
          ? `=https://{{${host}}}/api/v1/workflows/${idPart}`
          : `https://{{${host}}}/api/v1/workflows/${idPart}`;
      return this.emitHttpRequest(n, pred, { url, method: 'GET', headers });
    }
    return this.emitHttpRequest(n, pred, {
      url: `https://{{${host}}}/api/v1/workflows`,
      method: 'GET',
      headers,
    });
  }

  /** Google Perspective Comment Analyzer. */
  emitPerspective(n, pred) {
    const p = n.parameters || {};
    const text = M.param(p, 'text') ?? '={{ $json.text || $json.message?.text || $json }}';
    const attrs = (p.requestedAttributesUi?.requestedAttributesValues || []).map((a) => a?.attributeName).filter(Boolean);
    const requestedAttributes = Object.fromEntries((attrs.length ? attrs : ['TOXICITY']).map((a) => [a.toUpperCase(), {}]));
    // The Comment Analyzer REST call is the one the n8n node makes; only the credential moves to a workflow secret.
    this.approximateStep(n, 'googlePerspective.analyze', 'Perspective Comment Analyzer over HTTP with the API key from a workflow secret.', { soft: true });
    const key = this.reg.secret({ key: 'PERSPECTIVE_API_KEY', label: 'Perspective API key', host: 'commentanalyzer.googleapis.com', headerFormat: 'query parameter key=<secret>', node: n.name });
    return this.emitHttpRequest(n, pred, {
      url: `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key={{${key}}}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        comment: { text },
        languages: [M.param(p, 'options.languages') || 'en'],
        requestedAttributes,
      },
    });
  }

  /** Magic Hour image/video API. */
  emitMagicHour(n, pred) {
    const p = n.parameters || {};
    const resource = p.resource || 'image';
    const op = p.operation || 'generate';
    this.approximateStep(n, `magicHour.${resource}.${op}`, 'Magic Hour REST stand-in; the paths and body are a best guess at the current API, so confirm them before relying on it.');
    this.setup.add(`"${n.name}": verify https://api.magichour.ai paths for ${resource}.${op}.`);
    const headers = { 'Content-Type': 'application/json' };
    if (resource === 'video' && op === 'get') {
      const id = M.param(p, 'videoProjectId') || 'PROJECT_ID';
      const url =
        typeof id === 'string' && id.startsWith('=')
          ? `=https://api.magichour.ai/v1/video-projects/${id.slice(1)}`
          : `https://api.magichour.ai/v1/video-projects/${id}`;
      return this.emitHttpRequest(n, pred, { url, method: 'GET', headers, auth: 'magicHourApi' });
    }
    if (resource === 'video') {
      return this.emitHttpRequest(n, pred, {
        url: 'https://api.magichour.ai/v1/video-projects/image-to-video',
        method: 'POST',
        headers,
        auth: 'magicHourApi',
        body: {
          prompt: M.param(p, 'imagePrompt') ?? M.param(p, 'prompt'),
          image_url: M.param(p, 'imageUrl') ?? '={{ $json.image_url || $json.url }}',
        },
      });
    }
    return this.emitHttpRequest(n, pred, {
      url: 'https://api.magichour.ai/v1/image-generation',
      method: 'POST',
      headers,
      auth: 'magicHourApi',
      body: {
        prompt: M.param(p, 'imagePrompt') ?? M.param(p, 'prompt') ?? '',
        model: M.param(p, 'imageModel'),
        resolution: M.param(p, 'imageResolution'),
        aspect_ratio: M.param(p, 'imageAspectRatio'),
        n: Number(p.imageCount) || 1,
      },
    });
  }

  /** Fiwano messaging send. */
  emitFiwano(n, pred) {
    const p = n.parameters || {};
    this.approximateStep(n, 'fiwano.send', 'Fiwano send over HTTP; the send path is a best guess at the Fiwano API, so confirm it before relying on it.');
    const host = this.setupVar({ key: 'fiwanoHost', label: 'Host of your Fiwano workspace API', type: 'url', example: 'api.fiwano.com' }, n.name).slice(2, -2);
    const key = this.reg.secret({ key: 'FIWANO_API_KEY', label: 'Fiwano API key', host: 'your Fiwano workspace', headerFormat: 'Authorization: Bearer <secret>', node: n.name });
    return this.emitHttpRequest(n, pred, {
      url: `https://{{${host}}}/v1/messages`,
      method: 'POST',
      headers: { Authorization: `Bearer {{${key}}}`, 'Content-Type': 'application/json' },
      body: {
        channel_id: M.param(p, 'channelId'),
        recipient: M.param(p, 'recipient'),
        text: M.param(p, 'text'),
      },
    });
  }

  /** Venafi TLS Protect Cloud — certificate request (stock connector is list-only). */
  emitVenafiCert(n, pred) {
    const p = n.parameters || {};
    this.approximateStep(n, 'venafiTlsProtectCloud.certificate', 'Venafi connector is list-only; this step posts a certificate request over HTTP whose body is a best guess, so confirm it for your tenant.');
    return this.emitHttpRequest(n, pred, {
      url: 'https://api.venafi.cloud/outagedetection/v1/certificaterequests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      auth: 'venafiApi',
      body: {
        applicationId: M.param(p, 'applicationId'),
        certificateIssuingTemplateId: M.param(p, 'certificateIssuingTemplateId'),
        isExistingKey: false,
        csrGenerate: p.generateCsr !== false,
        commonName: M.param(p, 'commonName'),
        organizationalUnit: M.param(p, 'additionalFields.organizationalUnits'),
      },
    });
  }

  /** Cradl AI document parse. */
  emitCradl(n, pred) {
    const p = n.parameters || {};
    const agentId = M.param(p, 'agentId') || 'AGENT_ID';
    this.approximateStep(n, 'cradlAi.parse', 'Cradl document parse over HTTP; the document has to be uploaded first, which the JSON-only HTTP step cannot do.');
    return this.emitHttpRequest(n, pred, {
      url: `https://api.cradl.ai/v1/agents/${typeof agentId === 'string' ? agentId.replace(/^=/, '') : agentId}/parse`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      auth: 'cradlApi',
      body: {
        document: '={{ $json.data || $json.document || $json }}',
        binaryProperty: M.param(p, 'documentBinaryData') || 'data',
      },
    });
  }

  /** YouTube transcript community node → timedtext HTTP stand-in. */
  emitYoutubeTranscript(n, pred) {
    const p = n.parameters || {};
    const videoId = M.param(p, 'videoId') ?? M.param(p, 'url') ?? '={{ $json.videoId || $json.id || $json.url }}';
    this.approximateStep(n, 'youtubeTranscripter', 'YouTube captions via timedtext HTTP; may need cookies/region handling.', {
      reason: 'no connector fetches public YouTube transcripts: the timedtext endpoint is unofficial, YouTube Data API captions need ownership of the video, and yantra-youtube-search returns captions only on some search backends, so the transcript may be missing',
    });
    this.setup.add(`"${n.name}": set video id (or parse from URL); timedtext availability depends on the video's captions.`);
    const idPart =
      typeof videoId === 'string' && videoId.startsWith('=')
        ? videoId.slice(1).trim().startsWith('{{')
          ? videoId.slice(1).trim()
          : `{{ ${videoId.slice(1).trim()} }}`
        : encodeURIComponent(String(videoId));
    const url =
      typeof videoId === 'string' && videoId.startsWith('=')
        ? `=https://www.youtube.com/api/timedtext?lang=en&v=${idPart}`
        : `https://www.youtube.com/api/timedtext?lang=en&v=${idPart}`;
    return this.emitHttpRequest(n, pred, { url, method: 'GET' });
  }

  /** Shared HTTP emitter: tokens when possible; else Transform builders into url/headers/body (no <<n8n:>> markers). */
  emitHttpRequest(n, pred, { url, method = 'GET', headers = {}, body, auth }) {
    ({ url, headers } = this.applyHttpAuth(n, url, headers, auth));
    const inputs = { method };
    const builders = [];
    const noteCross = (raw) => {
      const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (/\$\(\s*['"]/.test(s)) {
        this.setup.add(
          `"${n.name}": a request field used $('OtherNode'); on Yantra $() resolves via the named upstream map when that node ran earlier, else the immediate upstream — check that expression.`,
        );
      }
    };

    const inlineUrl = url === undefined || url === null || url === '' ? '' : this.inline(url, pred);
    if (inlineUrl !== null && inlineUrl !== undefined) {
      inputs.url = inlineUrl === '' ? '' : inlineUrl;
    } else {
      noteCross(url);
      builders.push({
        role: 'url',
        socket: 'url',
        title: `URL: ${n.name}`,
        code: `// Request URL for "${n.name}".\nreturn ${X.toJs(url)};`,
      });
    }

    if (headers && Object.keys(headers).length) {
      const inlineHeaders = this.inline(headers, pred);
      if (inlineHeaders !== null) inputs.headers = inlineHeaders;
      else {
        noteCross(headers);
        builders.push({
          role: 'headers',
          socket: 'headers',
          title: `Headers: ${n.name}`,
          code: `// Request headers for "${n.name}".\nreturn ${X.toJs(headers)};`,
        });
      }
    }

    if (body !== undefined) {
      const inlineBody = this.inline(body, pred);
      if (inlineBody !== null) inputs.body = inlineBody;
      else {
        const bodyJs = typeof body === 'string' && body.startsWith('=') && /^=\s*\{\{[\s\S]*\}\}\s*$/.test(body) ? X.toJs(body) : X.toJs(body);
        builders.push({
          role: 'body',
          socket: 'body',
          title: `Body: ${n.name}`,
          code: `// Request body for "${n.name}".\nconst __body = ${bodyJs};\nreturn typeof __body === 'string' ? (() => { try { return JSON.parse(__body); } catch { return __body; } })() : __body;`,
        });
      }
    }

    const node = this.addNode('http', n, 'NodeHttpRequest', n.name, inputs, auth ? { auth } : {});
    if (!builders.length) return this.simpleUnit(n.name, 'http', node);

    let entry = null;
    let prevDone = null;
    let dataIn = null;
    for (const b of builders) {
      const builder = this.transformNode(n, b.role, b.title, b.code, pred);
      if (!entry) entry = this.sock(builder, 'RUN');
      if (!dataIn) dataIn = () => this.sock(builder, 'source');
      if (prevDone) this.addEdge(prevDone, this.sock(builder, 'RUN'));
      this.addEdge(this.sock(builder, 'transformed'), this.sock(node, b.socket));
      prevDone = this.sock(builder, 'onDone');
    }
    this.addEdge(prevDone, this.sock(node, 'RUN'));
    return {
      name: n.name,
      kind: 'http',
      entry,
      dataIn,
      exits: [{ trigger: this.sock(node, 'onDone'), data: this.dataExit(node) }],
      flags: {},
      lastNode: node,
    };
  }

  /**
   * Authentication for an HTTP step: a workflow secret in the header (or query
   * parameter) the API expects. Placeholder or redacted credentials in the
   * original headers are replaced by the same secret; nothing literal ships.
   */
  applyHttpAuth(n, url, headers, auth) {
    const text = typeof url === 'string' ? url.replace(/^=/, '') : '';
    const m = /https?:\/\/([^/?#:\s'"`{}]+)(\/[^\s?'"`]*)?/.exec(text.replace(/\{\{[\s\S]*?\}\}/g, 'X'));
    const host = m && !/^X$/.test(m[1]) ? m[1].toLowerCase() : '';
    const path = m?.[2] || '';
    const out = { ...(headers || {}) };
    const authLike = (k) => AUTH_HEADER.test(k) || /token|api[-_]?key|secret|auth/i.test(k);
    const plan = authPlan(host, path, auth);
    if (auth && UNSIGNABLE_AUTH.has(auth)) {
      this.setup.add(`"${n.name}": the original signed requests with OAuth 1.0a (${auth}); a static header cannot do that. Use the service's connector instead.`);
      return { url, headers: out };
    }
    let authed = false;
    for (const [k, v] of Object.entries(out)) {
      if (!authLike(k) || typeof v !== 'string') continue;
      const raw = v.startsWith('=') ? v.slice(1) : v;
      if (/\{\{/.test(raw) && !/\$env|\$credentials/.test(raw)) {
        authed = true;
        continue;
      }
      // Empty, placeholder, redacted or $env/$credentials: the secret goes here.
      const prefix = /^\s*(Bearer|Basic|Token|Key|token)\s+/.exec(raw)?.[1];
      const p = plan && (plan.header || '').toLowerCase() === k.toLowerCase() ? plan : { ...(plan || {}), key: plan?.key || `${camel(host.split('.').slice(-2, -1)[0] || 'api')}_${k}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), label: plan?.label || `${host || 'API'} ${k} credential`, header: k, format: prefix ? `${prefix} {v}` : '{v}', host };
      out[k] = this.authValue(p, n.name);
      authed = true;
    }
    if (typeof url === 'string' && /[?&](?:key|api_key|apikey|token|access_token)=(?:YOUR_API_KEY|YOUR[_-][A-Z_]+|$|&)/.test(url)) {
      const qp = plan?.query ? plan : { ...(plan || {}), key: plan?.key || `${(host.split('.').slice(-2, -1)[0] || 'api').toUpperCase()}_API_KEY`, label: plan?.label || `${host || 'API'} API key`, query: 'key', host };
      const ctxKey = this.secretFor({ ...qp, query: qp.query || 'key' }, n.name);
      url = url.replace(/([?&](?:key|api_key|apikey|token|access_token)=)(?:YOUR_API_KEY|YOUR[_-][A-Z_]+)?(?=&|$)/, `$1{{${ctxKey}}}`);
      authed = true;
    }
    if (typeof url === 'string' && /[?&](?:key|api_key|apikey|token|access_token|auth)=/.test(url)) authed = true;
    if (typeof url === 'string' && /api\.telegram\.org\/(?:file\/)?bot/.test(url)) authed = true;
    if (!authed && plan) {
      if (plan.query) {
        const ctxKey = this.secretFor(plan, n.name);
        url = `${url}${String(url).includes('?') ? '&' : '?'}${plan.query}={{${ctxKey}}}`;
      } else {
        out[plan.header] = this.authValue(plan, n.name);
        for (const [h, f] of Object.entries(plan.extra || {})) out[h] ??= f.replace('{v}', `{{${this.secretFor(plan, n.name)}}}`);
      }
      if (plan.oauth) this.setup.add(`"${n.name}": ${plan.label} expires; refresh the workflow secret ${plan.key} when calls start failing, or move this step onto the service's connector.`);
    }
    return { url, headers: out };
  }

  /**
   * HTTP calls with a faithful non-HTTP equivalent:
   *   - chat completions (OpenAI, OpenRouter, DeepSeek, Mistral, Groq, Anthropic
   *     messages, Gemini generateContent) become LLMChain + Chat Model with
   *     provider credentials; the answer text replaces the provider's JSON, and the
   *     downstream `choices[0].message.content` style paths are rewritten;
   *   - Apify run-sync-get-dataset-items, Firecrawl v1 scrape and Slack incoming
   *     webhooks run on their connectors (credential through the connector).
   * Bodies with images, tools or streaming stay HTTP.
   */
  trySwapHttp(n, pred, { url, method, body, p }) {
    if (typeof url !== 'string') return null;
    const u = url.replace(/^=/, '').trim();
    // fal.ai queue: submit, then read the result (the patched fal-ai actions wait for completion).
    const falReq = /^https:\/\/queue\.fal\.run\/(.+?)\/requests\/(.+?)(\/status)?\/?$/.exec(u);
    if (falReq && method === 'GET' && !(falReq[3] && this.repeatBody?.has(n.name))) {
      const reqId = /\{\{/.test(falReq[2]) ? `=${falReq[2]}` : falReq[2];
      this.setup.add(`"${n.name}" polled the fal.ai queue${falReq[3] ? ' status' : ''}; FAL_GET_REQUEST_RESULT waits for the request to finish and returns its result.`);
      return this.emitConnector(n, 'fal-ai', 'fal.ai', 'FAL_GET_REQUEST_RESULT', { request_id: reqId, model_id: falReq[1], wait_seconds: 120 }, pred);
    }
    const falSubmit = /^https:\/\/queue\.fal\.run\/([^?{}]+?)\/?$/.exec(u);
    if (falSubmit && method === 'POST') {
      const sb = (() => {
        if (X.containsExpression(body)) return undefined;
        if (typeof body === 'string') {
          try {
            return JSON.parse(body);
          } catch {
            return undefined;
          }
        }
        return body;
      })();
      const input = body === undefined ? undefined : sb ?? new X.RawJs(`(() => { const __v = ${X.toJs(body)}; if (typeof __v !== 'string') return __v; try { return JSON.parse(__v); } catch { return { prompt: __v }; } })()`);
      if (input instanceof X.RawJs) return this.emitConnector(n, 'fal-ai', 'fal.ai', 'FAL_SUBMIT_REQUEST', new X.RawJs(`({ "model_id": ${JSON.stringify(falSubmit[1])}, "input": ${input.code} })`), pred);
      return this.emitConnector(n, 'fal-ai', 'fal.ai', 'FAL_SUBMIT_REQUEST', { model_id: falSubmit[1], input }, pred);
    }
    // Cloudinary upload (multipart in n8n): the patched upload action takes a URL, data URI or base64.
    const cld = /^https:\/\/api\.cloudinary\.com\/v1_1\/[^/]+\/(?:(image|video|raw|auto)\/)?upload\/?(?:\?([^{}]*))?$/.exec(u);
    if (cld && method === 'POST') {
      const fields = Object.fromEntries((p.bodyParameters?.parameters || []).filter((x) => x?.name && x.parameterType !== 'formBinaryData').map((x) => [x.name, x.value]));
      const qs = Object.fromEntries(new URLSearchParams(cld[2] || ''));
      const binary = (p.bodyParameters?.parameters || []).some((x) => x?.parameterType === 'formBinaryData');
      const file = fields.file ?? (binary || !fields.file ? "={{ $json.url ?? $json.imageUrl ?? $json.secure_url ?? ('data:' + ($json.mimeType || $json.mime_type || 'application/octet-stream') + ';base64,' + ($json.data ?? '')) }}" : undefined);
      if (binary) this.report.approximate.push({ node: n.name, n8n: 'cloudinary.upload.binary', action: 'cloudinary/CLOUDINARY_UPLOAD', soft: true });
      this.setup.add(`"${n.name}" uploaded to Cloudinary with a multipart form; CLOUDINARY_UPLOAD sends the file as a URL or base64 data URI from the previous step, and the cloud name comes from the Cloudinary credential.`);
      const params = { file, resource_type: cld[1] || undefined, upload_preset: fields.upload_preset ?? qs.upload_preset, folder: fields.folder ?? qs.folder, public_id: fields.public_id ?? qs.public_id, tags: fields.tags ?? qs.tags };
      return this.emitConnector(n, 'cloudinary', 'Cloudinary', 'CLOUDINARY_UPLOAD', params, pred);
    }
    if (method !== 'POST') return null;
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    const parseBody = (v) => `(() => { const __v = ${X.toJs(v)}; if (typeof __v !== 'string') return __v ?? {}; try { return JSON.parse(__v); } catch { return { __raw: __v }; } })()`;
    const staticBody = () => {
      if (X.containsExpression(body)) return undefined;
      if (typeof body === 'string') {
        try {
          return JSON.parse(body);
        } catch {
          return undefined;
        }
      }
      return body && typeof body === 'object' ? body : undefined;
    };

    const LLM = [
      { re: /^https:\/\/api\.openai\.com\/v1\/chat\/completions\/?$/, style: 'openai', provider: 'OpenAI' },
      { re: /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions\/?$/, style: 'openai', provider: 'OpenRouter' },
      { re: /^https:\/\/api\.deepseek\.com\/(?:v1\/)?chat\/completions\/?$/, style: 'openai', provider: 'DeepSeek' },
      { re: /^https:\/\/api\.mistral\.ai\/v1\/chat\/completions\/?$/, style: 'openai', provider: 'Mistral' },
      { re: /^https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions\/?$/, style: 'openai', provider: 'Groq' },
      { re: /^https:\/\/api\.anthropic\.com\/v1\/messages\/?$/, style: 'anthropic', provider: 'Anthropic' },
      { re: /^https:\/\/generativelanguage\.googleapis\.com\/v1(?:beta)?\/models\/[\w.-]+:generateContent(?:\?[^{}]*)?$/, style: 'gemini', provider: 'Gemini' },
    ];
    const llm = LLM.find((x) => x.re.test(u));
    if (llm && body !== undefined && !/image_url|input_image|inline_data|inlineData|"tools"|"functions"|tool_choice|"stream"\s*:\s*true|"n"\s*:\s*[2-9]/.test(bodyText)) {
      const text = "const __t = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\\n') : c == null ? '' : JSON.stringify(c));";
      const pick = {
        openai: {
          system: "(__b.messages || []).filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => __t(m.content)).join('\\n\\n')",
          message: "(() => { const u = (__b.messages || []).filter((m) => m && m.role !== 'system' && m.role !== 'developer'); return __b.__raw ?? (u.length === 1 ? __t(u[0].content) : u.map((m) => m.role + ': ' + __t(m.content)).join('\\n\\n')); })()",
        },
        anthropic: {
          system: '__t(__b.system)',
          message: "(() => { const u = __b.messages || []; return __b.__raw ?? (u.length === 1 ? __t(u[0].content) : u.map((m) => m.role + ': ' + __t(m.content)).join('\\n\\n')); })()",
        },
        gemini: {
          system: '__t((__b.systemInstruction ?? __b.system_instruction)?.parts)',
          message: "__b.__raw ?? (__b.contents || []).flatMap((c) => c?.parts || []).map((x) => x?.text ?? '').join('\\n\\n')",
        },
      }[llm.style];
      const sb = staticBody();
      let system;
      let message;
      if (sb) {
        // eslint-disable-next-line no-new-func
        const run = (expr) => new Function('__b', `${text}\nreturn ${expr};`)(sb);
        system = run(pick.system) || undefined;
        message = run(pick.message);
      } else {
        system = new X.RawJs(`(() => { const __b = ${parseBody(body)};\n${text}\nreturn ${pick.system}; })()`);
        message = new X.RawJs(`(() => { const __b = ${parseBody(body)};\n${text}\nreturn ${pick.message}; })()`);
      }
      const inputs = { system };
      const temp = /"temperature"\s*:\s*([0-9.]+)/.exec(bodyText)?.[1];
      if (temp !== undefined && !Number.isNaN(Number(temp))) inputs.temperature = Number(temp);
      const model = /"model"\s*:\s*"([^"{}]+)"/.exec(bodyText)?.[1];
      inputs.model = model || /\/models\/([^/:?]+):generateContent/.exec(u)?.[1];
      const maxTokens = /"(?:max_tokens|max_output_tokens|maxOutputTokens)"\s*:\s*(\d+)/.exec(bodyText)?.[1];
      if (maxTokens !== undefined) inputs.maxTokens = Number(maxTokens);
      if (/json_object|json_schema|responseMimeType"\s*:\s*"application\/json/.test(bodyText)) {
        this.setup.add(`"${n.name}": the original asked ${llm.provider} for JSON output; the platform model gets the same prompt, so check the answer parses as JSON.`);
      }
      this.report.approximate.push({ node: n.name, n8n: `httpRequest.${llm.style}.chat`, action: 'NodeCdecliChatCompletion', soft: true });
      this.setup.add(`"${n.name}" called the ${llm.provider} API${inputs.model ? ` (${inputs.model})` : ''} over HTTP; it now runs on LLMChain with a Chat Model and provider connector credential, and later steps read the answer text instead of the provider's JSON.`);
      const unit = this.emitLlm(n, 'NodeCdecliChatCompletion', n.name, inputs, 'message', message, pred);
      this.report.nodes[unit.lastNode.nodeId].llmProvider = llm.provider.toLowerCase();
      return unit;
    }

    const apify = /^https:\/\/api\.apify\.com\/v2\/acts\/([^/?{}]+)\/run-sync-get-dataset-items\/?(?:\?([^{}]*))?$/.exec(u);
    if (apify) {
      const qs = new URLSearchParams(apify[2] || '');
      const params = { actorId: decodeURIComponent(apify[1]), input: body === undefined ? undefined : staticBody() ?? new X.RawJs(parseBody(body)) };
      if (qs.get('limit')) params.limit = Number(qs.get('limit'));
      if (qs.get('format')) params.format = qs.get('format');
      if (params.input instanceof X.RawJs) {
        const code = `(() => ({ "actorId": ${JSON.stringify(params.actorId)}, "input": ${params.input.code}${params.limit ? `, "limit": ${params.limit}` : ''}${params.format ? `, "format": ${JSON.stringify(params.format)}` : ''} }))()`;
        return this.emitConnector(n, 'apify', 'Apify', 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', new X.RawJs(code), pred);
      }
      return this.emitConnector(n, 'apify', 'Apify', 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', params, pred);
    }

    if (/^https:\/\/api\.firecrawl\.dev\/v1\/scrape\/?$/.test(u) && catalog.firecrawl?.actions?.FIRECRAWL_SCRAPE && body !== undefined) {
      const sb = staticBody();
      return this.emitConnector(n, 'firecrawl', 'Firecrawl', 'FIRECRAWL_SCRAPE', sb ?? new X.RawJs(`(() => { const __p = ${parseBody(body)}; return { ...__p, "url": __p.url }; })()`), pred);
    }

    if (/^https:\/\/hooks\.slack\.com\/services\//.test(u)) {
      const channel = this.setupVar({ key: 'slackChannel', label: 'Slack channel the incoming webhook posted to', type: 'channel', example: '#alerts' }, n.name);
      this.setup.add(`"${n.name}" posted through a Slack incoming webhook; it now posts with the Slack connector to the channel in slackChannel.`);
      const sb = staticBody();
      if (sb) return this.emitConnector(n, 'slack', 'Slack', 'SLACK_CHAT_POST_MESSAGE', { channel, text: sb.text, blocks: sb.blocks, attachments: sb.attachments }, pred);
      const code = `(() => { const __b = ${parseBody(body)}; return { "channel": ${JSON.stringify(channel)}, "text": __b.text ?? __b.__raw, "blocks": __b.blocks, "attachments": __b.attachments }; })()`;
      return this.emitConnector(n, 'slack', 'Slack', 'SLACK_CHAT_POST_MESSAGE', new X.RawJs(code), pred);
    }
    return null;
  }

  buildHttp(n, pred) {
    if (n.type === 'n8n-nodes-base.googleCloudStorage') return this.emitGcsList(n, pred);
    if (n.type === 'n8n-nodes-base.n8n') return this.emitN8nApi(n, pred);
    if (n.type === 'n8n-nodes-base.googlePerspective') return this.emitPerspective(n, pred);
    if (n.type === '@gladiator1st/n8n-nodes-magichour.magicHour') return this.emitMagicHour(n, pred);
    if (n.type === 'n8n-nodes-fiwano.fiwano') return this.emitFiwano(n, pred);
    if (n.type === 'n8n-nodes-base.venafiTlsProtectCloud') return this.emitVenafiCert(n, pred);
    if (n.type === '@cradl/n8n-nodes-cradlai.cradlAi') return this.emitCradl(n, pred);
    if (n.type === 'n8n-nodes-youtube-transcription.youtubeTranscripter') return this.emitYoutubeTranscript(n, pred);
    const p = n.parameters || {};
    let url = p.url ?? p.requestUrl;
    let method = (p.method || p.requestMethod || 'GET').toUpperCase();
    let headers = {};
    let body;
    if (n.type === 'n8n-nodes-base.graphql') {
      url = p.endpoint;
      method = 'POST';
      body = { query: p.query, variables: p.variables };
      headers['Content-Type'] = 'application/json';
    } else if (n.type === 'n8n-nodes-base.rssFeedRead') {
      this.setup.add(`"${n.name}": the original parsed an RSS feed; the HTTP step returns the raw XML for the next step to parse.`);
    } else if (n.type === 'n8n-nodes-base.quickChart') {
      url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify({ type: p.chartType || 'bar' }))}`;
    } else {
      if (p.sendHeaders && p.headerParameters?.parameters) for (const h of p.headerParameters.parameters) if (h?.name) headers[h.name] = h.value;
      if (p.specifyHeaders === 'json' && typeof p.jsonHeaders === 'string') {
        try {
          headers = JSON.parse(p.jsonHeaders.replace(/^=/, ''));
        } catch {
          headers = { __json: p.jsonHeaders };
          this.setup.add(`"${n.name}": the request headers were a JavaScript expression; a Transform rebuilds them.`);
        }
      }
      if (p.sendQuery && p.queryParameters?.parameters?.length) {
        const q = p.queryParameters.parameters.filter((x) => x?.name);
        const staticQ = q.filter((x) => !X.containsExpression(x.value));
        if (staticQ.length === q.length && !X.containsExpression(url)) {
          const u = new URL(String(url), 'https://placeholder.invalid');
          for (const x of q) u.searchParams.set(x.name, x.value ?? '');
          url = u.origin === 'https://placeholder.invalid' ? u.pathname + u.search : u.toString();
        } else {
          url = `${url}?${q.map((x) => `${x.name}=${typeof x.value === 'string' && x.value.startsWith('=') ? x.value.slice(1) : x.value ?? ''}`).join('&')}`;
          if (q.some((x) => X.containsExpression(x.value))) url = `=${url.replace(/^=/, '')}`;
        }
      }
      if (p.sendBody) {
        if (p.specifyBody === 'json' || p.contentType === 'json' || p.jsonBody) body = p.jsonBody;
        else if (p.bodyParameters?.parameters) body = Object.fromEntries(p.bodyParameters.parameters.filter((x) => x?.name).map((x) => [x.name, x.value]));
        else if (p.body) body = p.body;
        if (p.contentType === 'json' || p.specifyBody === 'json') headers['Content-Type'] ??= 'application/json';
      }
      if (p.authentication && p.authentication !== 'none') {
        const cred = p.nodeCredentialType || p.genericAuthType || p.authentication;
        this.setup.add(`"${n.name}" authenticated with ${cred} in the original; add the matching Authorization header (or use the service's connector).`);
      }
    }
    // The original left the URL blank for the person to fill in: a setup value.
    if (n.type === 'n8n-nodes-base.httpRequest' && (url === undefined || url === null || String(url).replace(/^=/, '').trim() === '')) {
      url = this.setupVar({ key: camel(`${n.name} url`), label: `Request URL for "${n.name}" (the original node left it blank)`, type: 'url', example: 'https://api.example.com/v1/resource' }, n.name);
    }
    const swapped = this.trySwapHttp(n, pred, { url, method, body, p });
    if (swapped) return swapped;
    const bodyKind = p.sendBody ? p.contentType || (p.specifyBody === 'json' ? 'json' : undefined) : undefined;
    const textFields = (p.bodyParameters?.parameters || []).every((x) => !x?.parameterType || x.parameterType === 'formData');
    const jsonToo = /^=?https:\/\/(?:gitlab\.com|api\.github\.com)\//.test(String(url)) && textFields;
    // Multipart, form, raw (non-JSON) and binary bodies, and responses a later step reads
    // as a file, run on yantra-storage HTTP_SEND (the HTTP node sends and reads JSON only).
    const sendKind = !jsonToo && (['multipart-form-data', 'form-urlencoded', 'binaryData'].includes(bodyKind) || (bodyKind === 'raw' && !/json/i.test(String(p.rawContentType || ''))));
    const viaSend = n.type === 'n8n-nodes-base.httpRequest' && (sendKind || this.binaryHttp.has(n.name));
    // Never re-publish a credential an upstream author left in the export.
    for (const [k, v] of Object.entries(headers)) {
      const redacted = redactSecret(k, v);
      if (redacted !== v) {
        headers[k] = redacted;
        this.setup.add(`"${n.name}": the original shipped a literal credential in header ${k}; it was removed. Add your own credential.`);
      }
    }
    if (typeof url === 'string') {
      const cleaned = url.replace(/([?&](?:key|api_key|apikey|token|access_token)=)([A-Za-z0-9_\-.]{20,})(?=&|$)/g, '$1YOUR_API_KEY');
      if (cleaned !== url) {
        url = cleaned;
        this.setup.add(`"${n.name}": the original shipped a literal API key in the URL; it was removed. Add your own.`);
      }
    }
    const auth =
      p.authentication && p.authentication !== 'none'
        ? String(p.nodeCredentialType || p.genericAuthType || p.authentication)
        : n.credentials && Object.keys(n.credentials).length
          ? Object.keys(n.credentials)[0]
          : undefined;
    if (viaSend) return this.emitHttpSend(n, pred, { url, method, headers, body, auth, bodyKind: sendKind ? bodyKind : bodyKind === 'json' || body !== undefined ? 'json' : 'none', p });
    const request = this.emitHttpRequest(n, pred, { url, method, headers, body, auth });
    const responseOptions = p.options?.response?.response || {};
    if (this.repeatLoops.size && (responseOptions.fullResponse || this.repeatBody.has(n.name))) {
      const response = this.addNode('http-response', n, 'NodeTransform', `${n.name}: response`, {
        mode: 'jsCode', jsCode: `const ctx = {{ctx}};\nconst response = ctx.steps[${JSON.stringify(request.lastNode.label)}];\nif (response.error && (response.statusCode == null || ${!responseOptions.neverError})) throw new Error(response.error.message || 'HTTP check failed');\n${responseOptions.fullResponse ? 'return { body: response.body, headers: response.headers, statusCode: response.statusCode };' : "if (response.body == null) throw new Error('HTTP check returned an empty body');\nreturn response.body;"}`,
      });
      // A 204 body is null. Transform's compute gate cannot run with a null
      // connected source, so read the complete response from its runtime label.
      this.addEdge(request.exits[0].trigger, this.sock(response, 'RUN'));
      const shaped = this.simpleUnit(n.name, 'data', response);
      return { ...request, kind: 'data', exits: shaped.exits, lastNode: response, stepKey: shaped.stepKey };
    }
    return request;
  }

  /**
   * An HTTP request the JSON-only HTTP node cannot make: a multipart, form, raw
   * or binary body, or a response a later step reads as a file. It runs on
   * yantra-storage/YANTRA_STORAGE_HTTP_SEND (form fields -> `fields`, binary
   * form fields -> `files` from the upstream file, the whole binary body ->
   * `file`, raw text -> `rawBody` + `contentType`), with the credential header
   * from a workflow secret as for the HTTP node. A Transform then hands the
   * response on the way n8n did: the parsed body, or `{ bodyBase64, filename,
   * mimeType }` for a file. A multipart upload to OpenAI Whisper becomes the
   * platform transcription instead (no OpenAI key).
   */
  emitHttpSend(n, pred, { url, method, headers, body, auth, bodyKind, p }) {
    // OpenAI Whisper: the platform transcription, so no OpenAI key is declared.
    const whisper = /^=?\s*https:\/\/api\.openai\.com\/v1\/audio\/(transcriptions|translations)\/?$/.exec(String(url));
    const formParams = (p.bodyParameters?.parameters || []).filter((x) => x?.name);
    if (whisper && bodyKind === 'multipart-form-data' && formParams.filter((x) => x.parameterType === 'formBinaryData').length === 1) {
      const origin = this.binaryOrigin(n.name);
      const fields = Object.fromEntries(formParams.filter((x) => x.parameterType !== 'formBinaryData').map((x) => [x.name, x.value]));
      return this.emitWhisperHttp(n, pred, origin.ok ? origin : { hops: 1, name: n.name, mode: 'either' }, formParams, fields, whisper[1], origin.ok ? [] : [origin]);
    }
    ({ url, headers } = this.applyHttpAuth(n, url, headers, auth));
    const what = `httpRequest.${bodyKind === 'none' || bodyKind === 'json' ? 'file-response' : bodyKind}`;
    const reach = httpFileReachable(url);
    const gaps = [];
    if (!reach.ok) gaps.push({ reason: `the request ${reach.why}` });
    const origin = binaryConsumer(n) ? this.binaryOrigin(n.name) : null;
    if (origin && !origin.ok) gaps.push(origin);
    const fileOrigin = origin?.ok ? origin : { hops: 1, name: n.name, mode: 'either' };
    const params = { url, method };
    const hdrs = Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !(/^content-type$/i.test(k) && bodyKind !== 'json' && bodyKind !== 'none')));
    const contentTypeHeader = Object.entries(headers || {}).find(([k]) => /^content-type$/i.test(k))?.[1];
    if (Object.keys(hdrs).length) params.headers = hdrs;
    let usesFile = false;
    const bodyParams = (p.bodyParameters?.parameters || []).filter((x) => x?.name);
    if (bodyKind === 'multipart-form-data' || bodyKind === 'form-urlencoded') {
      const fields = {};
      const files = [];
      for (const x of bodyParams) {
        if (x.parameterType === 'formBinaryData') {
          files.push(new X.RawJs(`{ "field": ${JSON.stringify(x.name)}, ...${this.fileRefJs(fileOrigin, x.inputDataFieldName || 'data')} }`));
          usesFile = true;
        } else fields[x.name] = x.value ?? '';
      }
      // A whole-body string (`specifyBody: string`) for a form request: key=value pairs.
      if (!bodyParams.length && typeof p.body === 'string') params.rawBody = p.body;
      params.bodyType = bodyKind === 'form-urlencoded' ? (params.rawBody !== undefined ? 'raw' : 'form') : 'multipart';
      if (params.rawBody !== undefined) params.contentType = 'application/x-www-form-urlencoded';
      if (Object.keys(fields).length) params.fields = fields;
      if (files.length) params.files = files;
    } else if (bodyKind === 'binaryData') {
      params.bodyType = 'binary';
      params.file = new X.RawJs(this.fileRefJs(fileOrigin, p.inputDataFieldName || 'data'));
      usesFile = true;
    } else if (bodyKind === 'raw') {
      params.bodyType = 'raw';
      params.rawBody = p.body ?? body ?? '';
      params.contentType = contentTypeHeader && !X.containsExpression(contentTypeHeader) ? contentTypeHeader : p.rawContentType || 'text/plain';
    } else if (body !== undefined && body !== '') {
      params.bodyType = 'json';
      params.json = typeof body === 'string' ? new X.RawJs(`(() => { const __v = ${X.toJs(body)}; if (typeof __v !== 'string') return __v; try { return JSON.parse(__v); } catch { return __v; } })()`) : body;
    }
    const resp = p.options?.response?.response || {};
    params.responseType = this.binaryHttp.has(n.name) || resp.responseFormat === 'file' ? 'base64' : 'auto';
    if (resp.neverError) params.failOnHttpError = false;
    if (Number(p.options?.timeout) > 0) params.timeoutMs = Math.min(Number(p.options.timeout), 120000);

    if (gaps.length) {
      const reason = gaps.map((g) => g.reason).join('; ');
      this.report.approximate.push({ node: n.name, n8n: what, action: 'yantra-storage/YANTRA_STORAGE_HTTP_SEND', reason });
      this.setup.add(`"${n.name}" (${what}): ${reason}.`);
    } else {
      this.report.approximate.push({ node: n.name, n8n: what, action: 'yantra-storage/YANTRA_STORAGE_HTTP_SEND', soft: true });
      this.setup.add(`"${n.name}" sends its ${bodyKind === 'none' || bodyKind === 'json' ? 'request' : bodyKind} body${params.responseType === 'base64' ? ' and reads the response as a file' : ''} with yantra-storage HTTP_SEND (public https hosts only, 25 MB, 120 s)${usesFile ? `; the file comes from "${fileOrigin.name}"` : ''}.`);
    }
    const hasRaw = Object.values(params).some((v) => v instanceof X.RawJs || (Array.isArray(v) && v.some((x) => x instanceof X.RawJs)));
    const call = this.emitConnector(n, 'yantra-storage', 'Yantra storage', 'YANTRA_STORAGE_HTTP_SEND', hasRaw ? new X.RawJs(X.toJs(params)) : params, pred, usesFile ? { prelude: FILE_REF } : {});
    call.flags = { ...call.flags, httpSend: true };
    const shape = this.transformNode(n, 'http-shape', `${n.name}: response`, httpSendShape(Boolean(resp.fullResponse)), { key: 'result', nodeType: 'NodeCdeConnector', unit: call });
    return this.chainUnits(n.name, [call, this.simpleUnit(n.name, 'data', shape, { httpSend: true })]);
  }

  /** OpenAI Whisper over multipart HTTP -> the platform transcription (no OpenAI key), answer as `{ text }` like the API. */
  emitWhisperHttp(n, pred, origin, bodyParams, fields, kind, gaps) {
    const prop = bodyParams.find((x) => x.parameterType === 'formBinaryData')?.inputDataFieldName || 'data';
    const language = kind === 'translations' ? 'en' : fields.language;
    const fileJs = this.fileParamsJs(origin, prop, { b64: 'audioBase64', name: 'filename', mime: 'mimeType', url: 'audioUrl' });
    if (gaps.length) {
      const reason = gaps.map((g) => g.reason).join('; ');
      this.report.approximate.push({ node: n.name, n8n: `httpRequest.openai.audio.${kind}`, action: 'yantra-voicebox/YANTRA_VOICEBOX_TRANSCRIBE', reason });
      this.setup.add(`"${n.name}" (httpRequest.openai.audio.${kind}): ${reason}.`);
    } else {
      this.report.approximate.push({ node: n.name, n8n: `httpRequest.openai.audio.${kind}`, action: 'yantra-voicebox/YANTRA_VOICEBOX_TRANSCRIBE', soft: true });
      this.setup.add(`"${n.name}" called OpenAI Whisper over HTTP; it now runs on the platform transcription (no API key) with the audio from "${origin.name}", and later steps read the text as before.`);
    }
    const call = this.emitFileConnector(n, 'yantra-voicebox', 'Audio', 'YANTRA_VOICEBOX_TRANSCRIBE', language ? { language } : {}, fileJs, pred);
    const shape = this.transformNode(
      n,
      'whisper-shape',
      `${n.name}: text`,
      "// The transcription the way the Whisper API returned it ({ text }).\nconst __r = source && typeof source === 'object' && source.data && typeof source.data === 'object' ? source.data : source;\nreturn typeof __r === 'string' ? { text: __r } : { ...__r, text: __r?.text ?? __r?.transcript ?? '' };",
      { key: 'result', nodeType: 'NodeCdeConnector', unit: call },
    );
    return this.chainUnits(n.name, [call, this.simpleUnit(n.name, 'data', shape)]);
  }

  /**
   * LLM / agent / structured-output step. Prefer run-context tokens for
   * message/prompt/system; the final builder supplies {{last.transformed}}.
   * Preserve an earlier dynamic system value before building the user prompt.
   */
  emitLlm(n, type, label, inputs, textKey, textValue, pred, flags = {}) {
    const builders = [];
    const take = (raw, role, socket, title) => {
      if (raw == null || raw === '') return;
      const plain = typeof raw === 'string' && !X.isExpression(raw) && !X.containsExpression(raw);
      if (plain) {
        inputs[socket] = raw;
        return;
      }
      const inlined = this.inline(raw, pred);
      // Resolve item paths from a wired payload. `last` can be replaced by a
      // branch condition or the other prompt builder, and a Transform can
      // return a list where n8n's $json means its first item.
      if (inlined !== null && !(typeof inlined === 'string' && /\{\{(?:last|steps)\./.test(inlined))) {
        inputs[socket] = inlined;
        return;
      }
      builders.push({ role, socket, title, value: raw });
    };

    const systemRaw = inputs.system;
    delete inputs.system;
    take(systemRaw, 'system', 'system', `System: ${n.name}`);
    take(textValue, 'prompt', textKey, `Prompt: ${n.name}`);

    if (!builders.length) {
      const node = this.addNode('llm', n, type, label, inputs);
      return this.simpleUnit(n.name, 'llm', node, flags);
    }

    const node = this.addNode('llm', n, type, label, inputs);
    let entry = null;
    let prevDone = null;
    let dataIn = null;
    const dataInAll = [];
    for (const b of builders) {
      const isLast = b === builders.at(-1);
      const contextKey = `llm_${b.role}_${this.id(b.role, n.name)}`;
      const text = "typeof __promptValue === 'string' ? __promptValue : JSON.stringify(__promptValue ?? '')";
      const body = `// ${b.title}.\nconst __promptValue = ${X.toJs(b.value)};\nreturn ${isLast ? text : `{ ${JSON.stringify(contextKey)}: ${text} }`};`;
      let js = body;
      if (/\bwindow\b/.test(js)) {
        js =
          "const window = { location: { protocol: 'https:', host: 'HOST' } }; // n8n editor global; replace HOST with your Yantra app origin\n" +
          js;
        this.setup.add(`"${n.name}": the ${b.socket} prompt referenced window.location; a HOST placeholder was injected — set your app origin.`);
      }
      const builder = this.transformNode(n, b.role, b.title, js, pred, {}, true);
      if (!entry) entry = this.sock(builder, 'RUN');
      if (!dataIn) dataIn = () => this.sock(builder, 'source');
      dataInAll.push(() => this.sock(builder, 'source'));
      if (prevDone) this.addEdge(prevDone, this.sock(builder, 'RUN'));
      if (isLast) {
        (node.inputs ??= {})[b.socket] = '{{last.transformed}}';
        prevDone = this.sock(builder, 'onDone');
      } else {
        // When both system and prompt are dynamic, keep the system value while
        // the final prompt builder replaces last.transformed.
        const publish = this.addNode(`${b.role}-context`, n, 'NodeUpdateContext', `Save ${b.title}`, {});
        this.addEdge(this.sock(builder, 'transformed'), this.sock(publish, 'patch'));
        this.addEdge(this.sock(builder, 'onDone'), this.sock(publish, 'RUN'));
        (node.inputs ??= {})[b.socket] = `{{${contextKey}}}`;
        prevDone = this.sock(publish, 'onDone');
      }
    }
    this.addEdge(prevDone, this.sock(node, 'RUN'));
    return {
      name: n.name,
      kind: 'llm',
      entry,
      dataIn,
      dataInAll,
      exits: [{ trigger: this.sock(node, 'onDone'), data: this.dataExit(node) }],
      flags,
      lastNode: node,
    };
  }

  foldedModel(n) {
    const srcs = this.aiIn.get(n.name)?.ai_languageModel || [];
    for (const s of srcs) {
      const m = this.byName.get(s);
      if (!m) continue;
      const p = m.parameters || {};
      const model = M.rl(p.model) ?? M.rl(p.modelId) ?? M.rl(p.modelName) ?? p.options?.model;
      this.report.folded.push({ node: s, type: m.type, into: n.name, model: typeof model === 'string' ? model : undefined });
      if (typeof model === 'string' && model && !model.startsWith('=')) return model;
    }
    return undefined;
  }

  foldHelpers(n) {
    const m = this.aiIn.get(n.name) || {};
    const tools = [];
    const connectors = new Set();
    let sessionHint = '';
    for (const [ctype, srcs] of Object.entries(m)) {
      if (ctype === 'ai_languageModel') continue;
      for (const s of srcs) {
        const h = this.byName.get(s);
        if (!h) continue;
        this.report.folded.push({ node: s, type: h.type, into: n.name, as: ctype });
        if (ctype === 'ai_tool') {
          tools.push(`${s} (${h.type.replace(/^.*\./, '')})`);
          const spec = M.SERVICES[h.type];
          if (spec?.connector) {
            connectors.add(spec.connector);
            // The agent reaches the tool's service through that connector, so it needs the credential too.
            this.connectors.add(spec.connector);
          }
        }
        if (ctype === 'ai_memory') {
          const sid = M.rl(h.parameters?.sessionKey) || M.rl(h.parameters?.sessionId);
          sessionHint = typeof sid === 'string' && sid && !sid.startsWith('=') ? sid : '{{sessionId}}';
          if (sessionHint === '{{sessionId}}') this.seeds.sessionId ??= '';
          this.setup.add(
            `"${n.name}" kept conversation memory (${h.type.replace(/^.*\./, '')}); sessionId is set to ${sessionHint === '{{sessionId}}' ? 'the run-input sessionId' : JSON.stringify(sessionHint)}.`,
          );
        }
        if (ctype === 'ai_retriever' || ctype === 'ai_document') {
          this.setup.add(`"${n.name}" folded a ${ctype.replace(/^ai_/, '')} (${h.type.replace(/^.*\./, '')}); retrieved text is expected on the upstream payload as context/documents.`);
        }
      }
    }
    if (tools.length) {
      const connHint = connectors.size ? ` Prefer connectors: ${[...connectors].join(', ')}.` : '';
      this.setup.add(
        `"${n.name}" used agent tools in the original: ${tools.join(', ')}. The cdecli agent calls connectors directly; connect credentials for the services those tools reached.${connHint}`,
      );
    }
    return { tools, sessionId: sessionHint || '' };
  }

  outputParserSchema(n) {
    const parsers = this.aiIn.get(n.name)?.ai_outputParser || [];
    for (const s of parsers) {
      let parser = this.byName.get(s);
      if (!parser) continue;
      if (parser.type.endsWith('outputParserAutofixing')) {
        const inner = this.aiIn.get(parser.name)?.ai_outputParser?.[0];
        parser = this.byName.get(inner) || parser;
      }
      const p = parser.parameters || {};
      const schema = schemaFromParser(p);
      if (schema) return schema;
    }
    return null;
  }

  buildLlm(n, pred) {
    const p = { ...n.parameters };
    for (const fix of llmPromptFixes[this.info.slug] || []) {
      if (fix.node === n.name && typeof p[fix.parameter] === 'string') p[fix.parameter] = p[fix.parameter].replace(fix.from, fix.to);
    }
    const t = n.type;
    const model = this.foldedModel(n);
    const folded = this.foldHelpers(n);
    const chatInput = () => {
      if (p.promptType === 'define') return p.text ?? p.prompt ?? '';
      if (!p.promptType && (typeof p.prompt === 'string' || typeof p.text === 'string')) return p.text ?? p.prompt;
      // Early Basic LLM Chain versions used `input` before chatInput became
      // the default. Their exports omit default-valued prompt parameters.
      if ((t.endsWith('.chainLlm') && n.typeVersion != null && n.typeVersion < 1.4) || (t.endsWith('.chainRetrievalQa') && n.typeVersion === 1)) return '={{ $json.input }}';
      return '={{ $json.chatInput }}';
    };
    const sessionId = folded.sessionId || '';

    if (t === '@n8n/n8n-nodes-langchain.agent' || t === '@n8n/n8n-nodes-langchain.openAiAssistant') {
      const system = p.options?.systemMessage;
      const inputs = { system: system || undefined, model, sessionId };
      return this.emitLlm(n, 'NodeCdecliAgent', n.name, inputs, 'message', chatInput(), pred);
    }
    if (t === '@n8n/n8n-nodes-langchain.chainLlm') {
      const systems = [];
      let human = [];
      for (const mv of p.messages?.messageValues || []) {
        if (!mv?.message) continue;
        if (mv.type === 'HumanMessagePromptTemplate' || mv.type === 'AIMessagePromptTemplate') human.push(mv.message);
        else systems.push(mv.message);
      }
      const schema = this.outputParserSchema(n);
      const text = human.length ? joinExpr([chatInput(), ...human]) : chatInput();
      const system = systems.length ? joinExpr(systems) : undefined;
      if (schema) return this.emitGenerateObject(n, text, system, schema, model, pred);
      const inputs = { system: system || undefined, model };
      return this.emitLlm(n, 'NodeCdecliChatCompletion', n.name, inputs, 'message', text, pred);
    }
    if (t === '@n8n/n8n-nodes-langchain.openAi' || t === 'n8n-nodes-base.openAi') {
      const resource = p.resource || (t === 'n8n-nodes-base.openAi' ? 'text' : 'chat');
      if (resource === 'image' && (p.operation || 'generate') === 'analyze') return this.emitVision(n, p, pred, model);
      if (resource === 'image') {
        const spec = M.OPENAI_MEDIA.image;
        return this.emitConnector(n, spec.connector, 'Image generation', spec.action, pickParams(spec.params, p), pred);
      }
      if (resource === 'audio') {
        // n8n's OpenAI audio resource defaults to generate (text to speech).
        const op = p.operation || 'generate';
        const spec = M.OPENAI_MEDIA.audio[op] || M.OPENAI_MEDIA.audio.transcribe;
        const params = pickParams(spec.params, p);
        if (spec.action === 'YANTRA_VOICEBOX_SPEAK') {
          this.report.approximate.push({ node: n.name, n8n: `audio.${op}`, action: `${spec.connector}/${spec.action}`, soft: true });
          this.setup.add(`"${n.name}" used OpenAI text to speech; the platform voice speaks the text and returns audioUrl (a stored audio file) instead of binary audio.`);
        } else {
          // Whisper needs the audio as a URL. A Telegram voice message is at the Bot API file URL.
          const tg = pred?.unit?.lastNode?.type === 'NodeHttpRequest' && this.report.nodes[pred.unit.lastNode.nodeId]?.n8nType === 'n8n-nodes-base.telegram';
          if (tg) {
            const tok = this.reg.secret({ key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token (from @BotFather)', host: 'api.telegram.org', headerFormat: 'URL path /bot<secret>/', node: n.name });
            params.audioUrl = `https://api.telegram.org/file/bot{{${tok}}}/{{last.body.result.file_path}}`;
            this.report.approximate.push({ node: n.name, n8n: `audio.${op}`, action: `${spec.connector}/${spec.action}`, soft: true });
            this.setup.add(`"${n.name}" transcribes the Telegram voice file by URL (Bot API file path) with the platform Whisper; no OpenAI key needed.`);
          } else {
            // Binary audio from an upstream step: its bytes (audioBase64) or URL (audioUrl).
            const origin = this.binaryOrigin(n.name);
            if (origin.ok) {
              const fileJs = this.fileParamsJs(origin, p.binaryPropertyName || 'data', { b64: 'audioBase64', name: 'filename', mime: 'mimeType', url: 'audioUrl' });
              this.report.approximate.push({ node: n.name, n8n: `audio.${op}`, action: `${spec.connector}/${spec.action}`, soft: true });
              this.setup.add(`"${n.name}" transcribes the audio from "${origin.name}" with the platform Whisper; no OpenAI key needed.`);
              return this.emitFileConnector(n, spec.connector, 'Audio', spec.action, params, fileJs, pred);
            }
            this.fileGap(n, `audio.${op}`, `${spec.connector}/${spec.action}`, origin);
          }
        }
        return this.emitConnector(n, spec.connector, 'Audio', spec.action, params, pred);
      }
      if (resource === 'assistant') {
        return this.emitLlm(n, 'NodeCdecliAgent', n.name, { model, sessionId }, 'message', chatInput(), pred);
      }
      if (resource === 'file') {
        const op = p.operation || 'upload';
        const spec = M.OPENAI_MEDIA.file[op] || M.OPENAI_MEDIA.file.upload;
        const params = pickParams(spec.params, p);
        if (spec.action === 'OPENAI_UPLOAD_FILE') {
          if (!params.file) params.file = M.param(p, 'binaryPropertyName') || 'data';
          if (!params.purpose) params.purpose = M.param(p, 'options.purpose') || 'assistants';
        }
        this.report.approximate.push({ node: n.name, n8n: `file.${op}`, action: `${spec.connector}/${spec.action}`, soft: true });
        this.setup.add(`"${n.name}" used OpenAI file (${op}); mapped to ${spec.connector}/${spec.action} — wire file bytes/base64 into the file param.`);
        return this.emitConnector(n, spec.connector, 'OpenAI files', spec.action, params, pred, { approximate: true, soft: true });
      }
      const messages = p.messages?.values || p.messages?.messages || p.prompt?.messages || [];
      const systems = messages.filter((m) => m?.role === 'system').map((m) => m.content);
      const users = messages.filter((m) => m?.role !== 'system').map((m) => m.content);
      const text = users.length ? joinExpr(users) : p.operation === 'edit' ? p.input : p.prompt && typeof p.prompt === 'string' ? p.prompt : '={{ $json.chatInput }}';
      const system = systems.length ? joinExpr(systems) : p.operation === 'edit' ? p.instruction : undefined;
      const inputs = { system: system || undefined, model: M.rl(p.modelId) ?? M.rl(p.model) ?? model };
      if (typeof inputs.model !== 'string' || inputs.model.startsWith('=')) delete inputs.model;
      if (p.jsonOutput) {
        return this.emitGenerateObject(n, text, system, { type: 'object', additionalProperties: true }, inputs.model, pred);
      }
      return this.emitLlm(n, 'NodeCdecliChatCompletion', n.name, inputs, 'message', text, pred);
    }
    if (t === '@n8n/n8n-nodes-langchain.informationExtractor') {
      const schema = schemaFromExtractor(p) || { type: 'object', additionalProperties: true };
      return this.emitGenerateObject(n, p.text ?? '={{ $json.chatInput }}', p.options?.systemPromptTemplate, schema, model, pred);
    }
    if (t === '@n8n/n8n-nodes-langchain.textClassifier' || t === '@n8n/n8n-nodes-langchain.sentimentAnalysis' || t === 'n8n-nodes-base.googleCloudNaturalLanguage' || t === 'n8n-nodes-base.awsComprehend') {
      let categories;
      let field = 'category';
      if (t === '@n8n/n8n-nodes-langchain.textClassifier') {
        categories = (p.categories?.categories || []).map((c) => c?.category).filter(Boolean);
      } else {
        field = 'sentiment';
        categories = String(p.options?.categories || 'Positive, Neutral, Negative').split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (p.options?.fallback === 'other') categories.push('other');
      const descriptions = (p.categories?.categories || []).map((c) => (c?.description ? `- ${c.category}: ${c.description}` : `- ${c.category}`)).join('\n');
      const schema = { type: 'object', properties: { [field]: { type: 'string', enum: categories, description: `One of: ${categories.join(', ')}` } }, required: [field], additionalProperties: false };
      const system = `Classify the input into exactly one ${field}.${descriptions ? '\n' + descriptions : ''}${p.options?.systemPromptTemplate ? '\n' + p.options.systemPromptTemplate : ''}`;
      const unit = this.emitGenerateObject(n, p.inputText ?? p.text ?? p.content ?? '={{ $json.chatInput }}', system, schema, model, pred);
      // One Branch per category so each original output keeps its own path.
      if (categories.length > 1) return this.branchChain(n, unit, categories.map((c, i) => ({ label: `${field} = ${c}`, js: `return String(source?.${field} ?? '') === ${JSON.stringify(c)};`, index: i })), unit.lastNode, null);
      return unit;
    }
    if (t === '@n8n/n8n-nodes-langchain.chainSummarization') {
      const custom = p.options?.summarizationMethodAndPrompts?.values?.prompt;
      const system = custom ? String(custom).replace(/\{text\}/g, '').trim() : 'Write a concise summary of the following content. Keep every important fact and name.';
      return this.emitLlm(n, 'NodeCdecliChatCompletion', n.name, { system, model }, 'message', '={{ $json }}', pred);
    }
    if (t === '@n8n/n8n-nodes-langchain.chainRetrievalQa') {
      const base = String(p.options?.systemPromptTemplate || 'Answer the question using only the provided context. If the context is empty, say you do not know.').replace(/^=/, '');
      const system = `=${base}\n\nContext:\n{{ $json.context || $json.documents || $json.text || '' }}`;
      this.approximateStep(n, 'chainRetrievalQa', 'Retriever output should arrive as context/documents/text on the upstream payload.', { soft: true });
      return this.emitLlm(n, 'NodeCdecliChatCompletion', n.name, { system, model }, 'message', chatInput(), pred, { approximate: true, soft: true });
    }
    return this.buildStub(n, 'unsupported LLM node');
  }

  /**
   * OpenAI image analysis: one OPENAI_CREATE_RESPONSE call with an input_text
   * and an input_image item (a URL, or a data: URL built from base64 content the
   * previous step hands over), then a Transform that returns the n8n shape
   * (`{ content }`) so downstream steps read the answer where they did before.
   */
  emitVision(n, p, pred, model) {
    const text = p.text ?? 'What is in this image?';
    const base64 = p.inputType === 'base64';
    // An image the previous yantra-storage HTTP_SEND step downloaded arrives as bodyBase64.
    const fromSend = pred?.unit?.flags?.httpSend ? ' ?? $json.bodyBase64' : '';
    const images = base64
      ? [`={{ 'data:' + ($json.mimeType || $json.mime_type || 'image/jpeg') + ';base64,' + ($json.data ?? $json.base64${fromSend} ?? '') }}`]
      : String(p.imageUrls ?? '={{ $json.url ?? $json.image_url }}')
          .split(/,(?![^{]*\}\})/)
          .map((u) => u.trim())
          .filter(Boolean)
          .map((u) => (u.startsWith('=') || !String(p.imageUrls ?? '').startsWith('=') ? u : `=${u}`));
    const detail = p.options?.detail;
    const content = [{ type: 'input_text', text }, ...images.map((u) => ({ type: 'input_image', image_url: u, ...(detail ? { detail } : {}) }))];
    const modelId = M.rl(p.modelId) ?? model;
    this.approximateStep(
      n,
      'image.analyze',
      base64 ? 'Vision call through OpenAI Responses (input_image as a data: URL); the previous step must hand over the image as base64 in `data`.' : 'Vision call through OpenAI Responses with the image URL as an input_image item.',
      { soft: true },
    );
    const call = this.emitConnector(
      n,
      'openai',
      'OpenAI',
      'OPENAI_CREATE_RESPONSE',
      { model: typeof modelId === 'string' && modelId && !modelId.startsWith('=') ? modelId : 'gpt-4o-mini', input: [{ role: 'user', content }] },
      pred,
    );
    const shape = this.transformNode(
      n,
      'vision-shape',
      `${n.name}: answer`,
      "// The Responses API answer as the n8n image-analysis output ({ content }).\nconst __r = source?.data ?? source;\nconst __text = __r?.output_text ?? (__r?.output || []).flatMap((o) => o?.content || []).map((c) => c?.text || '').join('');\nreturn { content: __text, text: __text };",
      { key: 'result', nodeType: 'NodeCdeConnector', unit: call },
    );
    return this.chainUnits(n.name, [call, this.simpleUnit(n.name, 'data', shape)]);
  }

  emitGenerateObject(n, prompt, system, schema, model, pred) {
    // The final pass adds LLMChain's output mode and connected Chat Model.
    const inputs = { system: system || undefined, schema, model };
    return this.emitLlm(n, 'NodeCdeGenerateObject', n.name, inputs, 'prompt', prompt, pred);
  }

  /**
   * A chain of (Transform -> Branch) pairs. `rules[i].js` computes a boolean
   * from `source`; TRUE goes to output rules[i].index, FALSE to the next rule
   * and finally to `fallbackIndex` (or nowhere).
   */
  branchChain(n, headUnit, rules, dataNode, fallbackIndex, pred) {
    // An unmatched status inside a bounded check must terminate or fail,
    // rather than leave NodeRepeatUntil waiting forever for NEXT.
    if (fallbackIndex == null && this.repeatBody?.has(n.name)) fallbackIndex = Math.max(...rules.map((r) => r.index)) + 1;
    const exits = [];
    let prevTrigger = headUnit ? headUnit.exits[0].trigger : null;
    let entry = headUnit ? headUnit.entry : null;
    const dataIns = headUnit ? [...(headUnit.dataInAll || [headUnit.dataIn])] : [];
    rules.forEach((r, i) => {
      const cond = this.transformNode(n, `cond${i}`, `${n.name}: ${r.label}`, r.js, headUnit ? { key: DATA_OUTPUT[dataNode.type], nodeType: dataNode.type } : pred);
      const branch = this.addNode(`branch${i}`, n, 'NodeBranch', `${n.name}: ${r.label}?`, {});
      if (dataNode) this.addEdge(this.sock(dataNode, DATA_OUTPUT[dataNode.type]), this.sock(cond, 'source'));
      else dataIns.push(() => this.sock(cond, 'source'));
      if (prevTrigger) this.addEdge(prevTrigger, this.sock(cond, 'RUN'));
      else entry = this.sock(cond, 'RUN');
      this.addEdge(this.sock(cond, 'onDone'), this.sock(branch, 'RUN'));
      this.addEdge(this.sock(cond, 'transformed'), this.sock(branch, 'condition'));
      exits[r.index] = { trigger: this.sock(branch, 'TRUE'), data: 'inherit' };
      prevTrigger = this.sock(branch, 'FALSE');
    });
    if (fallbackIndex !== null && fallbackIndex !== undefined) exits[fallbackIndex] = { trigger: prevTrigger, data: 'inherit' };
    for (let i = 0; i < exits.length; i++) exits[i] ??= { trigger: null, data: 'inherit' };
    return {
      name: n.name,
      kind: 'branch',
      entry,
      dataIn: dataIns.length ? (idx) => (dataIns.length === 1 ? dataIns[0]?.(idx) : null) : null,
      dataInAll: dataIns.filter(Boolean),
      exits,
      flags: {},
      lastNode: dataNode || headUnit?.lastNode,
    };
  }

  buildVector(n, pred) {
    const p = n.parameters || {};
    const mode = p.mode || 'load';
    this.foldHelpers(n);
    if (n.type === '@n8n/n8n-nodes-langchain.vectorStorePinecone' || n.type === '@n8n/n8n-nodes-langchain.vectorStoreQdrant' || n.type === '@n8n/n8n-nodes-langchain.vectorStoreInMemory') {
      return this.emitPineconeStore(n, pred, mode);
    }
    if (n.type === '@n8n/n8n-nodes-langchain.vectorStoreSupabase' || n.type === '@n8n/n8n-nodes-langchain.vectorStorePGVector') {
      const table = M.rl(p.tableName) || M.rl(p.table) || 'documents';
      const topK = Number(p.topK) || 4;
      if (mode === 'insert') {
        this.setup.add(`"${n.name}": set the Supabase project ref on SUPABASE_INSERT_ROW. content, embedding, and metadata come from the upstream item.`);
        return this.emitConnector(
          n,
          'supabase',
          'Supabase',
          'SUPABASE_INSERT_ROW',
          {
            table,
            fields: {
              content: '={{ $json.pageContent ?? $json.content ?? $json.text }}',
              embedding: '={{ $json.embedding }}',
              metadata: '={{ $json.metadata }}',
            },
          },
          pred,
        );
      }
      const tableName = String(table);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
        this.setup.add(`"${n.name}": Supabase vector search needs a simple table name before SUPABASE_SEARCH_ROWS can run.`);
        this.approximateStep(n, `${n.type.replace(/^.*\./, '')}.${mode}`, 'Vector query table name is not a simple identifier.');
        return this.emitConnector(
          n,
          'supabase',
          'Supabase',
          'SUPABASE_BETA_RUN_SQL_QUERY',
          { ref: '', query: `SELECT * FROM ${tableName} ORDER BY embedding <-> $1 LIMIT ${topK}; -- bind the query embedding` },
          pred,
          { approximate: true },
        );
      }
      this.setup.add(`"${n.name}": set the Supabase project ref on SUPABASE_SEARCH_ROWS. The query embedding comes from the upstream item.`);
      return this.emitConnector(
        n,
        'supabase',
        'Supabase',
        'SUPABASE_SEARCH_ROWS',
        {
          table: tableName,
          embedding: '={{ $json.embedding || $json.vector || $json.query }}',
          limit: topK,
        },
        pred,
      );
    }
    return this.buildStub(n, `no Yantra connector for ${n.type.replace(/^.*\./, '')} (${mode}); see CONTRIBUTING.md "Blocked n8n node types"`);
  }

  /**
   * Default vector store: a Pinecone index with integrated embedding. Pinecone
   * embeds the record text itself, so the n8n embeddings sub-node is not needed,
   * and one upsert / one search action replaces the n8n store for Qdrant,
   * in-memory and Pinecone alike. Insert turns the upstream documents into
   * records (`_id`, `text`, flat metadata); load searches by text and returns
   * n8n-shaped `{ document: { pageContent, metadata }, score }` items.
   */
  emitPineconeStore(n, pred, mode) {
    const p = n.parameters || {};
    const kind = n.type.replace(/^.*vectorStore/, '');
    const plainName = (v) => (typeof v === 'string' && v.startsWith('=') && !/\{\{/.test(v) ? v.slice(1) : v);
    const ns =
      kind === 'InMemory'
        ? plainName(p.memoryKey?.value ?? p.memoryKey) || 'vector_store_key'
        : kind === 'Qdrant'
          ? plainName(M.rl(p.qdrantCollection) || M.rl(p.collection))
          : plainName(p.options?.pineconeNamespace);
    const namespace = ns && ns !== 'COLLECTION' ? ns : this.setupVar({ key: 'pineconeNamespace', label: 'Pinecone namespace for this collection', type: 'text', example: 'documents' }, n.name);
    const indexHost = this.setupVar({ key: 'pineconeIndexHost', label: 'Pinecone index host (create the index with integrated embedding and field map text=text)', type: 'url', example: 'my-index-abc123.svc.aped-4627-b74a.pinecone.io' }, n.name);
    const from = { Qdrant: 'a Qdrant collection', InMemory: 'an in-memory vector store', Pinecone: 'a Pinecone index with a separate embeddings node' }[kind];
    const upsert = mode === 'insert' || mode === 'update';
    this.approximateStep(
      n,
      `vectorStore${kind}.${mode}`,
      `The original used ${from}; here the default vector store is a Pinecone index with integrated embedding (${upsert ? 'upsert records' : 'search records by text'}), so Pinecone embeds the text itself.`,
      { soft: true },
    );
    this.setup.add(`"${n.name}": create a Pinecone index with integrated embedding (for example llama-text-embed-v2, field map text=text) and set pineconeIndexHost; ${kind === 'Qdrant' ? 'the Qdrant collection became' : 'the store uses'} the namespace ${JSON.stringify(namespace)}.`);
    if (upsert) {
      const records = new X.RawJs(
        [
          '(() => {',
          '  const __docs = __items.flatMap((d) => (Array.isArray(d) ? d : [d]));',
          '  return __docs.map((d) => {',
          "    const text = typeof d === 'string' ? d : d?.pageContent ?? d?.text ?? d?.content ?? d?.chunk ?? JSON.stringify(d);",
          "    const meta = d && typeof d === 'object' ? (d.metadata && typeof d.metadata === 'object' ? d.metadata : d) : {};",
          '    const flat = {};',
          "    for (const [k, v] of Object.entries(meta)) if (!['pageContent', 'text', '_id'].includes(k) && ['string', 'number', 'boolean'].includes(typeof v)) flat[k] = v;",
          '    return { ...flat, _id: String(d?.id ?? meta.id ?? crypto.randomUUID()), text: String(text) };',
          '  });',
          '})()',
        ].join('\n'),
      );
      return this.emitConnector(n, 'pinecone', 'Pinecone', 'PINECONE_UPSERT_RECORDS_NAMESPACE', { index_host: indexHost, namespace, records }, pred);
    }
    const prompt = p.prompt ?? '={{ $json.chatInput ?? $json.query ?? $json.text }}';
    const search = this.emitConnector(n, 'pinecone', 'Pinecone', 'PINECONE_SEARCH_RECORDS_NAMESPACE', { index_host: indexHost, namespace, query: { top_k: Number(p.topK) || 4, inputs: { text: prompt } } }, pred);
    const shape = this.transformNode(
      n,
      'vector-shape',
      `${n.name}: documents`,
      "// Pinecone hits as n8n vector-store documents.\nconst __res = source?.data ?? source;\nconst __hits = __res?.result?.hits ?? __res?.hits ?? [];\nreturn __hits.map((h) => ({ document: { pageContent: String(h.fields?.text ?? ''), metadata: h.fields ?? {} }, score: h._score }));",
      { key: 'result', nodeType: 'NodeCdeConnector', unit: search },
    );
    return this.chainUnits(n.name, [search, this.simpleUnit(n.name, 'data', shape)]);
  }

  buildData(n, pred) {
    const p = n.parameters || {};
    const t = n.type;
    switch (t) {
      case 'n8n-nodes-base.set':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'set', n.name, setBody(p), pred));
      case 'n8n-nodes-base.code':
      case 'n8n-nodes-base.function':
      case 'n8n-nodes-base.functionItem': {
        if ((p.language || 'javaScript').toLowerCase().startsWith('python')) {
          this.approximateStep(n, 'code.python', 'Python Code has no Transform runtime; payload passes through unchanged.', { soft: true });
          this.setup.add(
            `"${n.name}": Python Code was not executed — port the logic to JavaScript Transform or run it in an agent sandbox.`,
          );
          return this.simpleUnit(
            n.name,
            'data',
            this.transformNode(n, 'code', n.name, '// Original n8n node was Python Code; no Python runtime on Transform.\nreturn source;', pred),
            { approximate: true, soft: true },
          );
        }
        let code = String(p.jsCode ?? p.functionCode ?? p.code ?? '');
        // A Code step that only renames another step's binary file: pass that step's file on under the new name.
        const renamed = renamedBinary(code);
        if (renamed) {
          const body = [
            `// n8n renamed the binary file of "${renamed.from}" to ${renamed.fileName} and passed that file on.`,
            "// On Yantra the file is base64 bytes or a file URL on that step's output; the new name travels as filename.",
            `const __src = ${this.stepRefJs(renamed.from)};`,
            `return __src && typeof __src === 'object' && !Array.isArray(__src) ? { ...__src, filename: ${JSON.stringify(renamed.fileName)} } : __src;`,
          ].join('\n');
          return this.simpleUnit(n.name, 'data', this.transformNode(n, 'code', n.name, body, pred));
        }
        // Transform has no module system; strip allowlisted requires and leave the rest as soft passthrough.
        if (/\brequire\s*\(/.test(code)) {
          const rewritten = rewriteAllowlistedRequires(code);
          if (!rewritten) {
            this.approximateStep(
              n,
              'code.require',
              'Transform has no module system; payload passes through — port require() logic by hand.',
              { soft: true },
            );
            this.setup.add(
              `"${n.name}": original Code used require()/bundled modules; this Transform is a passthrough. Port the logic to plain JS or a connector.`,
            );
            return this.simpleUnit(
              n.name,
              'data',
              this.transformNode(
                n,
                'code',
                n.name,
                `// Original Code used require()/modules; Transform has no module system — payload passes through.\nreturn source;`,
                pred,
              ),
              { approximate: true, soft: true },
            );
          }
          code = rewritten;
          this.approximateStep(n, 'code.require', 'Allowlisted require() calls were rewritten or dropped for Transform (no module system).', { soft: true });
        }
        if (/\bawait\b/.test(code) || /\$http\b|\bfetch\(/.test(code)) {
          const split = trySplitAsyncHttpCode(n, code, p, pred, this);
          if (split) return split;
          this.approximateStep(
            n,
            'code.async',
            'Transform cannot run await/fetch; payload passes through — move HTTP into a NodeHttpRequest step.',
            { soft: true },
          );
          this.setup.add(
            `"${n.name}": original Code used await/fetch; this Transform is a passthrough. Split HTTP into a request step and keep sync logic here.`,
          );
          return this.simpleUnit(
            n.name,
            'data',
            this.transformNode(
              n,
              'code',
              n.name,
              `// Original Code used await/fetch; Transform has no async HTTP — payload passes through.\nreturn source;`,
              pred,
            ),
            { approximate: true, soft: true },
          );
        }
        // node:crypto beyond WebCrypto: fail closed and report (never a fake digest).
        const cryptoFns = cryptoUsage(String(p.jsCode ?? p.functionCode ?? p.code ?? ''));
        let flags = {};
        if (cryptoFns.length) {
          code = `${cryptoPrelude(cryptoFns)}\n${code}`;
          const signature = cryptoFns.filter((f) => SIGNATURE_CRYPTO.has(f));
          const other = cryptoFns.filter((f) => !SIGNATURE_CRYPTO.has(f));
          if (signature.length) {
            // A webhook signature check over the raw request body (Meta X-Hub-Signature-256, Shopify HMAC, ...).
            const hook = [...this.byName.values()].find((x) => x.type === 'n8n-nodes-base.webhook' && x.parameters?.options?.rawBody && code.includes(x.name));
            const header = /['"](x-hub-signature-256|x-shopify-hmac-sha256|x-[\w-]*signature[\w-]*|x-[\w-]*hmac[\w-]*)['"]/i.exec(code)?.[1];
            const reason = hook && /createHmac/.test(code)
              ? `checks the ${header ? `${header} ` : ''}HMAC over the raw request body of the webhook "${hook.name}"; the Yantra start node passes the webhook body as parsed JSON with no raw bytes, and re-serialised JSON does not match the sender's bytes, so the check cannot be faithful until the webhook trigger exposes the raw body (yantra-storage YANTRA_STORAGE_VERIFY_SIGNATURE can then verify it)`
              : undefined;
            this.approximateStep(
              n,
              'code.crypto',
              `uses crypto.${signature.join(', crypto.')}, which the Transform runtime does not provide; the step stops the run instead of faking a digest.${reason ? ` It ${reason}.` : ' Verify signatures before the workflow (webhook connector) or move hashing into a yantra-storage HASH / HMAC / VERIFY_SIGNATURE step.'}`,
              { blocker: 'signature-verification', reason },
            );
          }
          if (other.length) this.approximateStep(n, 'code.crypto', `uses crypto.${other.join(', crypto.')} (encryption / random bytes), which the Transform runtime does not provide; the step stops the run when it gets there.`);
          flags = { approximate: true };
        }
        // Pass rewritten code through parameters for codeBody.
        const p2 = code === String(p.jsCode ?? p.functionCode ?? p.code ?? '') ? p : { ...p, jsCode: code };
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'code', n.name, codeBody(n, p2), pred), flags);
      }
      case 'n8n-nodes-base.if': {
        const rule = { label: 'condition', js: `return Boolean(${conditionJs(p)});`, index: 0 };
        const unit = this.branchChain(n, null, [rule], null, 1, pred);
        return unit;
      }
      case 'n8n-nodes-base.switch': {
        const { rules, fallback } = switchRules(p);
        if (!rules.length) return this.buildStub(n, 'switch without rules');
        return this.branchChain(n, null, rules, null, fallback, pred);
      }
      case 'n8n-nodes-base.filter':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'filter', n.name, `return __items.filter(($json) => Boolean(${conditionJs(p)}));`, pred));
      case 'n8n-nodes-base.merge': {
        if (this.repeatBody?.has(n.name) || [...this.itemLoops.values()].some((p) => p.native && p.body.has(n.name))) return this.buildLoopMerge(n, pred);
        const node = this.addNode('merge', n, 'NodeSync', n.name, {});
        this.setup.add(`"${n.name}" merged two branches; NodeSync waits for both inputs and exposes them as data1/data2 (the original merge mode was ${p.mode || 'append'}).`);
        return { name: n.name, kind: 'sync', entry: null, dataIn: (idx) => this.sock(node, idx === 1 ? 'data2' : 'data1'), exits: [{ trigger: this.sock(node, 'onDone'), data: this.dataExit(node) }], flags: {}, lastNode: node };
      }
      case 'n8n-nodes-base.splitOut':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'split', n.name, splitOutBody(p, this.batchInputMany), pred));
      case 'n8n-nodes-base.itemLists':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'items', n.name, itemListsBody(p), pred));
      case 'n8n-nodes-base.splitInBatches': {
        const plan = this.itemLoops.get(n.name);
        if (plan?.native) return this.buildItemLoop(n, pred, plan);
        if (plan?.takeOnly) {
          const size = X.toJs(plan.batchSize);
          const unit = this.simpleUnit(n.name, 'data', this.transformNode(n, 'batches', n.name,
            `// No body returns to this batch node in the original: emit only the first batch.\nconst size = Number(${size});\nif (!Number.isInteger(size) || size < 1) throw new Error('Batch size must be a positive integer');\nconst batch = __items.slice(0, size);\nreturn batch.length === 1 ? batch[0] : batch;`, pred));
          this.setup.add(`"${n.name}" has no body return in the original; it selects its first batch instead of repeating.`);
          return unit;
        }
        this.approximateStep(
          n,
          `splitInBatches.${p.batchSize || 1}`,
          plan?.earlyExit
            ? 'This loop can end the workflow from inside its body. Preserve its successful early exit with a conditional-loop conversion; NodeLoop has no break port.'
            : 'This batch loop resets its input while iterating and requires a conditional-loop conversion.',
          { soft: !!plan?.earlyExit },
        );
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'batches', n.name, '// Conditional batch loop pending conversion (reset or successful early exit).\nreturn source;', pred), { approximate: true, soft: !!plan?.earlyExit });
      }
      case 'n8n-nodes-base.aggregate':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'aggregate', n.name, aggregateBody(p), pred));
      case 'n8n-nodes-base.summarize':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'summarize', n.name, summarizeBody(p), pred));
      case 'n8n-nodes-base.limit':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'limit', n.name, `return ${p.keep === 'lastItems' ? `__items.slice(-${Number(p.maxItems) || 1})` : `__items.slice(0, ${Number(p.maxItems) || 1})`};`, pred));
      case 'n8n-nodes-base.removeDuplicates':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'dedupe', n.name, dedupeBody(p), pred));
      case 'n8n-nodes-base.sort':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'sort', n.name, sortBody(p), pred));
      case 'n8n-nodes-base.renameKeys':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'rename', n.name, renameBody(p), pred));
      case 'n8n-nodes-base.dateTime':
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'date', n.name, dateTimeBody(p), pred));
      case 'n8n-nodes-base.markdown': {
        const toMd = (p.mode || 'markdownToHtml') === 'htmlToMarkdown';
        this.approximateStep(
          n,
          `markdown.${toMd ? 'htmlToMarkdown' : 'markdownToHtml'}`,
          toMd ? 'HTML to Markdown is a plain tag strip on Yantra.' : 'Markdown to HTML is a minimal converter on Yantra.',
          { soft: true },
        );
        this.setup.add(`"${n.name}": ${toMd ? 'HTML to Markdown is a plain tag strip' : 'Markdown to HTML is a minimal converter'} on Yantra; swap in a connector if you need full fidelity.`);
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'markdown', n.name, markdownBody(p, toMd), pred), { approximate: true, soft: true });
      }
      case 'n8n-nodes-base.html': {
        if (p.operation === 'generateHtmlTemplate' || p.html) {
          return this.simpleUnit(n.name, 'data', this.transformNode(n, 'html', n.name, `return { html: ${X.toJs('=' + String(p.html || ''))} };`, pred));
        }
        const values = (p.extractionValues?.values || []).filter((v) => v?.key);
        if ((p.operation === 'extractHtmlContent' || p.operation === undefined) && values.length) return this.buildHtmlExtract(n, p, values, pred);
        return this.buildStub(n, 'HTML extraction with CSS selectors needs a DOM; use a connector such as yantra-web-extract or firecrawl');
      }
      case 'n8n-nodes-base.extractFromFile': {
        const op = p.operation || 'csv';
        const PARSE_MIME = {
          pdf: 'application/pdf',
          xls: 'application/vnd.ms-excel',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          html: 'text/html',
          ods: 'application/vnd.oasis.opendocument.spreadsheet',
          rtf: 'application/rtf',
        };
        if (PARSE_MIME[op]) {
          const fileId = M.param(p, 'options.fileId') ?? M.param(p, 'fileId') ?? '={{ $json.id ?? $json.file_id ?? $json.fileId }}';
          const resolved = fileId != null && fileId !== '' && !(typeof fileId === 'string' && fileId.includes('REPLACE'));
          this.approximateStep(
            n,
            `extractFromFile.${op}`,
            'Parsed via googlesuper/GOOGLESUPER_PARSE_FILE; the file must live on Google Drive (upload first if the previous step only has bytes/base64).',
            { soft: !!resolved },
          );
          this.setup.add(
            `"${n.name}": GOOGLESUPER_PARSE_FILE needs a Drive file_id (and googlesuper credential). If the upstream step only has file bytes, upload with GOOGLESUPER_CREATE_FILE_FROM_TEXT / Drive upload first, then parse.`,
          );
          return this.emitConnector(
            n,
            'googlesuper',
            'Google Drive parse',
            'GOOGLESUPER_PARSE_FILE',
            { file_id: fileId, mime_type: PARSE_MIME[op] },
            pred,
            { approximate: !resolved },
          );
        }
        const body = extractFromFileBody(p);
        if (!body) return this.buildStub(n, `extracting ${op} files needs a parser; upload the file to Google Drive and use googlesuper/GOOGLESUPER_PARSE_FILE, or a document connector`);
        this.approximateStep(n, `extractFromFile.${op}`, 'Files flow as text or base64 fields on Yantra, not binary attachments; check the previous step hands over the file content.', { soft: true });
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'file', n.name, body, pred), { approximate: true, soft: true });
      }
      case 'n8n-nodes-base.readPDF':
        return this.emitReadPdf(n, pred);
      case 'n8n-nodes-base.convertToFile': {
        const body = convertToFileBody(p);
        if (!body) return this.buildStub(n, `converting to ${p.operation} needs a file encoder`);
        this.approximateStep(n, `convertToFile.${p.operation || 'csv'}`, 'The file is a `{ data, fileName, mimeType }` object (text, or base64 for toBinary); point the next step at `data`.', { soft: true });
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'file', n.name, body, pred), { approximate: true, soft: true });
      }
      case 'n8n-nodes-base.spreadsheetFile': {
        const fmt = (p.fileFormat || 'csv').toLowerCase();
        const body = convertToFileBody({ ...p, operation: fmt === 'json' ? 'toJson' : 'csv' });
        this.approximateStep(n, `spreadsheetFile.${p.operation || 'toFile'}`, `Spreadsheet export approximated as a ${fmt} file object; point the next step at data.`, { soft: true });
        this.setup.add(`"${n.name}": spreadsheetFile became a Transform that builds { data, fileName, mimeType } (${fmt}).`);
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'file', n.name, body, pred), { approximate: true, soft: true });
      }
      case 'n8n-nodes-gcf.gcf': {
        const op = p.operation || 'encode';
        const input = JSON.stringify(p.inputData || 'data');
        const output = JSON.stringify(p.outputField || (op === 'encode' ? 'data' : 'decoded'));
        const body =
          op === 'decode'
            ? `// gcf decode: base64 JSON → object.\nconst __raw = $json?.[${input}] ?? $json?.data ?? $json;\nconst __text = typeof __raw === 'string' ? __raw : String(__raw ?? '');\nlet __decoded;\ntry { __decoded = JSON.parse(Buffer.from(__text, 'base64').toString('utf8')); } catch { __decoded = __text; }\nreturn { ...$json, [${output}]: __decoded };`
            : `// gcf encode: object → base64 JSON (lossless payload bag).\nconst __src = $json?.[${input}] ?? $json;\nconst __b64 = Buffer.from(JSON.stringify(__src ?? null), 'utf8').toString('base64');\nreturn { ...$json, [${output}]: __b64 };`;
        this.approximateStep(n, `gcf.${op}`, 'GCF encode/decode approximated as base64 JSON Transform (no native GCF runtime).');
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'gcf', n.name, body, pred), { approximate: true });
      }
      case 'n8n-nodes-base.executeWorkflow': {
        const wf = M.rl(p.workflowId) || M.rl(p.source) || M.rl(p.workflowId?.value) || '';
        this.approximateStep(n, 'executeWorkflow', 'Sub-workflow calls are not imported automatically; compose the child graph by hand or paste its steps inline.', { soft: true });
        this.setup.add(
          `"${n.name}" called another n8n workflow${wf ? ` (${wf})` : ''}; on Yantra, open that workflow as its own template (or rebuild it) and replace this passthrough with a call into it.`,
        );
        return this.simpleUnit(
          n.name,
          'data',
          this.transformNode(
            n,
            'subflow',
            n.name,
            `// executeWorkflow: compose the subflow manually${wf ? ` (original workflow: ${String(wf).slice(0, 120)})` : ''}.\nreturn source;`,
            pred,
          ),
          { approximate: true, soft: true },
        );
      }
      case 'n8n-nodes-base.readWriteFile':
      case 'n8n-nodes-base.readBinaryFile':
      case 'n8n-nodes-base.writeBinaryFile':
      case 'n8n-nodes-base.moveBinaryData': {
        const body = fileIoBody(n.type, p);
        this.approximateStep(n, n.type.replace(/^.*\./, ''), 'Local filesystem / binary helpers become `{ data, fileName, mimeType }` fields on Yantra; there is no host disk.', { soft: true });
        this.setup.add(`"${n.name}": Yantra steps exchange file content as text or base64 fields, not paths on disk. Point this at the upstream file payload.`);
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'file', n.name, body, pred), { approximate: true, soft: true });
      }
      case 'n8n-nodes-base.compression': {
        this.approximateStep(n, 'compression', 'Zip/unzip needs the agent sandbox or an external tool; this step passes the payload through.', { soft: true });
        this.setup.add(`"${n.name}" compressed or extracted an archive in n8n; use a sandbox agent (or a file connector) for zip/unzip on Yantra.`);
        return this.simpleUnit(
          n.name,
          'data',
          this.transformNode(n, 'zip', n.name, `// compression (${p.operation || 'compress'}): handle archives in a sandbox agent.\nreturn source;`, pred),
          { approximate: true, soft: true },
        );
      }
      case 'n8n-nodes-base.crypto': {
        const action = String(p.action || p.type || 'hash').toLowerCase();
        const body = cryptoBody(p);
        const exact = action === 'generate' || isBase64Crypto(p);
        if (!exact && (action === 'hash' || action === 'hmac')) {
          const digest = this.emitCryptoDigest(n, pred, action);
          if (digest) return digest;
        }
        if (exact) {
          this.approximateStep(n, `crypto.${action}`, action === 'generate' ? 'crypto.generate becomes crypto.randomUUID().' : 'Base64 encode/decode runs in the Transform.', { soft: true });
        } else {
          // Never fake a digest: a stand-in value would let a signature check pass or fail at random.
          const reason = this.cryptoGap;
          this.cryptoGap = undefined;
          this.approximateStep(
            n,
            `crypto.${action}`,
            reason ? `${reason}.` : 'The Transform runtime has no synchronous digest/HMAC, so this step stops the run with an error. Verify the signature before the workflow (for example in the webhook connector) or compute the hash in a connector step, then remove this step.',
            { blocker: 'signature-verification', reason },
          );
        }
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'crypto', n.name, body, pred), exact ? { approximate: true, soft: true } : { approximate: true });
      }
      case 'n8n-nodes-base.wait':
        if (this.repeatBody?.has(n.name)) return buildRepeatWait(this, n, pred);
        this.setup.add(`"${n.name}" paused the original (${p.resume === 'webhook' ? 'until a webhook call' : `${p.amount ?? p.time ?? 1} ${p.unit || 'seconds'}`}); Yantra has no delay node, so this step passes data straight through.`);
        this.approximateStep(n, 'wait', 'Wait/delay is a soft passthrough; add a schedule or external delay if timing matters.', { soft: true });
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'wait', n.name, `// The original waited here (${p.resume === 'webhook' ? 'for a webhook' : `${p.amount ?? p.time ?? 1} ${p.unit || 'seconds'}`}).\nreturn source;`, pred), { approximate: true, soft: true });
      case 'n8n-nodes-base.executeCommand': {
        const cmd = p.command || p.executeCommand || '';
        this.approximateStep(n, 'executeCommand', 'Host shell commands are not run in Transform; use an agent sandbox shell if you need the original command.', { soft: true });
        this.setup.add(
          `"${n.name}": original command was ${JSON.stringify(String(cmd).slice(0, 200))} — run equivalent logic in an agent sandbox shell (not SSH).`,
        );
        return this.simpleUnit(
          n.name,
          'data',
          this.transformNode(n, 'exec', n.name, `// executeCommand was not run on Yantra.\n// Original: ${JSON.stringify(String(cmd).slice(0, 120))}\nreturn source;`, pred),
          { approximate: true, soft: true },
        );
      }
      case 'n8n-nodes-base.executionData':
        this.approximateStep(n, 'executionData', 'Execution metadata has no Yantra equivalent; payload passes through.', { soft: true });
        return this.simpleUnit(n.name, 'data', this.transformNode(n, 'meta', n.name, `// Execution metadata has no equivalent; pass data through.\nreturn source;`, pred), { approximate: true, soft: true });
      case 'n8n-nodes-base.dataTable': {
        this.approximateStep(n, `dataTable.${p.operation || 'row'}`, 'n8n Data Table has no Yantra connector; rows pass through. Persist with Sheets/Airtable/Baserow if needed.', { soft: true });
        this.setup.add(`"${n.name}": Data Table was not persisted — wire a real store if you need durable rows.`);
        return this.simpleUnit(
          n.name,
          'data',
          this.transformNode(n, 'datatable', n.name, `// n8n Data Table (${p.operation || 'row'}) — pass through.\nreturn source;`, pred),
          { approximate: true, soft: true },
        );
      }
      case '@n8n/n8n-nodes-langchain.code': {
        this.approximateStep(n, 'langchain.code', 'LangChain Code node has no Transform runtime; payload passes through.', { soft: true });
        this.setup.add(`"${n.name}": LangChain Code was not executed — port to JS Transform or an agent sandbox.`);
        return this.simpleUnit(
          n.name,
          'data',
          this.transformNode(n, 'code', n.name, '// Original was LangChain Code; no runtime here.\nreturn source;', pred),
          { approximate: true, soft: true },
        );
      }
      default:
        return this.buildStub(n, `${t.replace(/^.*\./, '')} is not portable to a Transform`);
    }
  }

  /**
   * n8n Crypto hash / hmac: yantra-storage YANTRA_STORAGE_HASH / YANTRA_STORAGE_HMAC
   * (the Transform runtime has no digest). The HMAC key is a workflow secret,
   * never a literal from the original. A Transform then sets the digest on the
   * item under the original property name, like n8n. Hashing the raw request
   * body of a webhook is not possible faithfully: the Yantra start node passes
   * the body as parsed JSON, so that stays a signature-verification blocker.
   */
  emitCryptoDigest(n, pred, action) {
    const p = n.parameters || {};
    const algorithm = String(p.type || 'MD5').toLowerCase().replace(/-/g, '');
    const allowed = action === 'hmac' ? ['sha256', 'sha1', 'sha512', 'sha384'] : ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
    if (!allowed.includes(algorithm)) {
      // No connector digest for this algorithm: the step stays fail-closed, with the reason.
      this.cryptoGap = `${action === 'hmac' ? 'HMAC' : 'hash'} ${algorithm.toUpperCase()} has no yantra-storage action (${allowed.join(', ')} only), so the Transform stops the run instead of faking a digest`;
      return null;
    }
    const actionId = action === 'hmac' ? 'YANTRA_STORAGE_HMAC' : 'YANTRA_STORAGE_HASH';
    const params = { algorithm, encoding: p.encoding === 'base64' ? 'base64' : 'hex' };
    if (action === 'hmac') {
      const secret = p.secret;
      if (typeof secret === 'string' && X.containsExpression(secret)) params.secret = secret;
      else params.secret = `{{${this.reg.secret({ key: 'HMAC_SECRET', label: `HMAC key for the Crypto step "${n.name}"`, headerFormat: 'read by the HMAC step as its key', node: n.name })}}}`;
    }
    let prelude = '';
    if (p.binaryData) {
      const origin = this.binaryOrigin(n.name);
      const start = origin.ok ? null : [...this.byName.values()].find((x) => x.name === origin.name && x.type === 'n8n-nodes-base.webhook');
      if (!origin.ok || origin.mode === 'url') {
        const reason = start
          ? `${action === 'hmac' ? 'computes an HMAC over' : 'hashes'} the raw request body of the webhook "${start.name}"; the Yantra start node passes the webhook body as parsed JSON with no raw bytes, and re-serialised JSON does not match the sender's bytes, so the digest cannot be computed faithfully until the webhook trigger exposes the raw body (yantra-storage ${actionId} / YANTRA_STORAGE_VERIFY_SIGNATURE then take it as payload)`
          : `${origin.reason || 'has no file bytes upstream'}; ${actionId} needs the bytes as base64`;
        this.report.approximate.push({ node: n.name, n8n: `crypto.${action}`, action: `yantra-storage/${actionId}`, blocker: 'signature-verification', reason });
        this.setup.add(`"${n.name}" (crypto.${action}): ${reason}.`);
        params.payload = "={{ JSON.stringify($json.body ?? $json) }}";
      } else {
        prelude = FILE_REF;
        params.payload = new X.RawJs(`${this.fileRefJs(origin, p.binaryPropertyName || 'data')}.contentBase64`);
        params.payloadEncoding = 'base64';
      }
    } else {
      params.payload = p.value ?? '';
    }
    if (!this.report.approximate.some((a) => a.node === n.name)) {
      this.report.approximate.push({ node: n.name, n8n: `crypto.${action}`, action: `yantra-storage/${actionId}`, soft: true });
      this.setup.add(`"${n.name}" computes the ${algorithm.toUpperCase()} ${action === 'hmac' ? 'HMAC' : 'hash'} with yantra-storage ${actionId}${action === 'hmac' ? ' (key from the HMAC_SECRET workflow secret unless the original built it from data)' : ''}.`);
    }
    const hasRaw = Object.values(params).some((v) => v instanceof X.RawJs);
    const call = this.emitConnector(n, 'yantra-storage', 'Yantra storage', actionId, hasRaw ? new X.RawJs(X.toJs(params)) : params, pred, prelude ? { prelude } : {});
    // n8n Crypto keeps the item and adds the digest under dataPropertyName.
    const inName = (this.incoming.get(n.name) || [])[0]?.src;
    const input = inName ? this.stepRefJs(inName) : '{}';
    const shape = this.transformNode(
      n,
      'crypto-shape',
      `${n.name}: digest`,
      [
        `// n8n Crypto keeps the input fields and sets the digest on ${JSON.stringify(p.dataPropertyName || 'data')}.`,
        "const __r = source && typeof source === 'object' && source.data && typeof source.data === 'object' ? source.data : source;",
        `const __in = ${input};`,
        `return { ...(__in && typeof __in === 'object' && !Array.isArray(__in) ? __in : {}), ${JSON.stringify(p.dataPropertyName || 'data')}: __r?.digest };`,
      ].join('\n'),
      { key: 'result', nodeType: 'NodeCdeConnector', unit: call },
    );
    return this.chainUnits(n.name, [call, this.simpleUnit(n.name, 'data', shape)]);
  }

  /**
   * n8n Read PDF (binary PDF -> text): pdf-co/PDF_CO_PDF_TO_TEXT with `inline`
   * returns the text. It reads the PDF from a URL; a PDF that only exists as
   * bytes is first uploaded to pdf.co (its base64 upload over yantra-storage
   * HTTP_SEND). A Transform hands on `{ text }` like Read PDF.
   */
  emitReadPdf(n, pred) {
    const p = n.parameters || {};
    const prop = p.binaryPropertyName || 'data';
    const origin = this.binaryOrigin(n.name);
    const shapeJs =
      "// The PDF text the way n8n Read PDF returned it ({ text }).\nconst __r = source && typeof source === 'object' && source.data && typeof source.data === 'object' ? source.data : source;\nreturn { ...(__r && typeof __r === 'object' ? __r : {}), text: typeof __r === 'string' ? __r : __r?.body ?? __r?.text ?? '' };";
    const finish = (units) => {
      const last = units[units.length - 1];
      const shape = this.transformNode(n, 'pdf-shape', `${n.name}: text`, shapeJs, { key: 'result', nodeType: 'NodeCdeConnector', unit: last });
      return this.chainUnits(n.name, [...units, this.simpleUnit(n.name, 'data', shape)]);
    };
    if (!origin.ok || origin.mode === 'url') {
      if (!origin.ok) this.fileGap(n, 'readPDF', 'pdf-co/PDF_CO_PDF_TO_TEXT', origin);
      else {
        this.report.approximate.push({ node: n.name, n8n: 'readPDF', action: 'pdf-co/PDF_CO_PDF_TO_TEXT', soft: true });
        this.setup.add(`"${n.name}" extracts the PDF text with pdf.co from the file URL of "${origin.name}".`);
      }
      const ref = origin.ok ? origin : { hops: 1, name: n.name, mode: 'url' };
      return finish([this.emitFileConnector(n, 'pdf-co', 'PDF.co', 'PDF_CO_PDF_TO_TEXT', { inline: true }, this.fileParamsJs(ref, prop, { url: 'url' }), pred)]);
    }
    // Bytes only: upload them to pdf.co (base64 upload), then convert the returned URL.
    const key = this.reg.secret({ key: 'PDFCO_API_KEY', label: 'PDF.co API key', host: 'api.pdf.co', headerFormat: 'x-api-key: <secret>', node: n.name });
    const upload = this.emitConnector(
      n,
      'yantra-storage',
      'Yantra storage',
      'YANTRA_STORAGE_HTTP_SEND',
      new X.RawJs(
        `(() => { const __f = ${this.fileRefJs(origin, prop)}; return { "url": "https://api.pdf.co/v1/file/upload/base64", "method": "POST", "headers": { "x-api-key": "{{${key}}}" }, "bodyType": "form", "fields": { "file": __f.contentBase64 ?? '', "name": __f.filename }, "responseType": "json" }; })()`,
      ),
      pred,
      { prelude: FILE_REF },
      'upload',
    );
    const toText = this.emitConnector(
      n,
      'pdf-co',
      'PDF.co',
      'PDF_CO_PDF_TO_TEXT',
      new X.RawJs("(() => { const __r = source && typeof source === 'object' && source.data && typeof source.data === 'object' ? source.data : source; const __u = __r?.bodyJson?.url; if (!__u) throw new Error('pdf.co upload returned no url: ' + JSON.stringify(__r?.bodyJson ?? __r?.status ?? null)); return { \"url\": __u, \"inline\": true }; })()"),
      { key: 'result', nodeType: 'NodeCdeConnector', unit: upload },
    );
    this.report.approximate.push({ node: n.name, n8n: 'readPDF', action: 'pdf-co/PDF_CO_PDF_TO_TEXT', soft: true });
    this.setup.add(`"${n.name}" uploads the PDF bytes from "${origin.name}" to pdf.co (PDFCO_API_KEY workflow secret) and extracts the text with PDF_CO_PDF_TO_TEXT.`);
    return finish([upload, toText]);
  }

  /** A step that runs but not exactly like the original: report it so the template is needs-setup. */
  approximateStep(n, what, note, { soft = false, blocker, reason } = {}) {
    this.report.approximate.push({ node: n.name, n8n: what, action: 'NodeTransform', soft: soft || undefined, blocker, reason });
    this.setup.add(`"${n.name}" (${what}): ${note}`);
  }

  /**
   * HTML extraction by CSS selector has no DOM on Yantra; a structured-output
   * step reads the page and returns the same keys the selectors produced.
   */
  buildHtmlExtract(n, p, values, pred) {
    const prop = String(p.dataPropertyName || 'data').replace(/^=/, '').trim() || 'data';
    // n8n wraps a text HTTP response as `{ data }`; Yantra's HTTP step emits the body itself.
    const html = pred?.nodeType === 'NodeHttpRequest' && prop === 'data' ? '{{ $json }}' : `{{ $json[${JSON.stringify(prop)}] }}`;
    const properties = {};
    for (const v of values) {
      const what = v.returnValue === 'attribute' ? `the "${v.attribute || 'href'}" attribute` : v.returnValue === 'html' ? 'the inner HTML' : 'the text';
      const description = `${what} of the element(s) matching the CSS selector ${String(v.cssSelector || '').replace(/^=/, '').trim()}`;
      // n8n sometimes stores a plain key in expression mode (`=headlines`).
      const key = String(v.key).startsWith('=') && !String(v.key).includes('{{') ? String(v.key).slice(1) : v.key;
      properties[key] = v.returnArray ? { type: 'array', items: { type: 'string' }, description: `Every match: ${description}` } : { type: 'string', description: `First match: ${description}` };
    }
    const schema = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
    const system = 'Extract values from the HTML page the way the given CSS selectors would. Copy text exactly as it appears in the page. Use an empty string or an empty array when nothing matches.';
    // Structured extract with a concrete schema is runnable with an LLM credential — soft note only.
    this.approximateStep(n, 'html.extractHtmlContent', 'CSS selectors become a structured-output LLM extract; verify results on a real page.', { soft: true });
    this.setup.add(`"${n.name}" extracted HTML with CSS selectors; on Yantra a structured-output step reads the page instead. Check the result on a real page, and trim very large pages before this step.`);
    return this.emitGenerateObject(n, `=HTML page:\n${html}`, system, schema, undefined, pred);
  }

  buildEnd(n) {
    if (n.type === 'n8n-nodes-base.stopAndError' && [...(this.repeatLoops?.values() || [])].some((p) => p.exits.some((e) => e.dst === n.name))) {
      return this.simpleUnit(n.name, 'end', this.transformNode(n, 'stop', `Stop: ${n.name}`,
        `throw new Error(String(${X.toJs(n.parameters?.errorMessage || n.parameters?.errorObject || 'Conditional workflow failed')}));`, this.predInfo(n.name)));
    }
    const node = this.addNode('end', n, 'NodeEnd', n.type === 'n8n-nodes-base.stopAndError' ? `Stop: ${n.name}` : 'End', {});
    return { name: n.name, kind: 'end', entry: null, dataIn: () => this.sock(node, 'result'), exits: [], flags: {}, lastNode: node };
  }

  buildStub(n, reason) {
    const p = n.parameters || {};
    let dump = JSON.stringify(p, (k, v) => (typeof v === 'string' && v.length > 600 ? v.slice(0, 600) + '... [truncated]' : v), 2) || '{}';
    const lines = dump.split('\n');
    if (lines.length > 60) dump = lines.slice(0, 60).join('\n') + '\n... [truncated]';
    const body = `// TODO(yantra): no direct equivalent for n8n node "${n.name}" (${n.type}): ${reason}.\n// Original parameters:\n${dump.split('\n').map((l) => '// ' + l).join('\n')}\nreturn source;`;
    const node = this.addNode('stub', n, 'NodeTransform', `TODO: ${n.name}`, { mode: 'jsCode', jsCode: body }, { stub: true, reason, parameters: p });
    this.report.unmapped.push({ node: n.name, type: n.type, reason });
    this.setup.add(`"${n.name}" (${n.type.replace(/^.*\./, '')}) is a TODO stub: ${reason}.`);
    return this.simpleUnit(n.name, 'stub', node, { stub: true });
  }

  buildUnit(n) {
    const cls = M.classify(n.type);
    const pred = this.predInfo(n.name);
    switch (cls) {
      case 'start':
        return this.buildStart(n);
      case 'cron':
        return this.buildCron(n);
      case 'webhook':
        return this.buildWebhook(n, M.WEBHOOK_TRIGGERS[n.type]);
      case 'end':
        return this.buildEnd(n);
      case 'http':
        return this.buildHttp(n, pred);
      case 'llm':
        return this.buildLlm(n, pred);
      case 'vector':
        return this.buildVector(n, pred);
      case 'data':
        return this.buildData(n, pred);
      case 'service':
        return this.buildService(n, M.SERVICES[n.type], pred);
      default:
        return this.buildStub(n, 'no mapping for this node type yet');
    }
  }

  reaches(from, to, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return this.edgesKept.some((e) => e.src === from && this.reaches(e.dst, to, seen));
  }

  buildLoopMerge(n, pred) {
    const incoming = this.incoming.get(n.name) || [];
    const p = n.parameters || {};
    const owners = [...this.itemLoops.entries()].filter(([, plan]) => plan.native && plan.body.has(n.name))
      .concat([...this.repeatLoops.entries()].filter(([, plan]) => plan.body.has(n.name)));
    const outside = (e) => !owners.some(([name, plan]) => name === e.src || plan.body.has(e.src));
    const driver = incoming.find((e) => !outside(e) && incoming.every((other) => outside(other) || this.reaches(other.src, e.src)));
    if (driver && (p.mode === 'combine' || p.mode === 'chooseBranch' || incoming.length === 1)) {
      const ordered = [...incoming].sort((a, b) => a.inIdx - b.inIdx);
      const initializers = ordered.filter(outside);
      let initialization;
      if (initializers.length) {
        const owner = [...owners].sort((a, b) => a[1].body.size - b[1].body.size)[0][0];
        const simple = initializers.every((e) => {
          const init = this.units.get(e.src);
          return init?.entry && init.exits.length === 1 && init.exits[0].trigger &&
            (this.incoming.get(e.src) || []).every((edge) => this.units.get(edge.src)?.kind === 'start') &&
            this.edgesKept.filter((edge) => edge.src === e.src).every((edge) => edge.dst === n.name);
        });
        if (!simple) throw new Error(`Loop merge ${n.name} needs an explicit initialization plan`);
        for (const e of initializers) {
          const init = this.units.get(e.src);
          const snapshot = this.addNode('loop-initialized', this.byName.get(e.src), 'NodeTransform', `Initialized: ${e.src}`, { mode: 'jsCode', jsCode: 'return source;' });
          this.addEdge(init.exits[0].trigger, this.sock(snapshot, 'RUN'));
          this.addEdge(this.resolveData(init, e.outIdx), this.sock(snapshot, 'source'));
          init.exits = [{ trigger: this.sock(snapshot, 'onDone'), data: this.dataExit(snapshot) }];
          init.lastNode = snapshot;
          init.kind = 'initialized';
        }
        initialization = { owner, names: initializers.map((e) => e.src) };
      }
      const expressions = ordered.map((e) => {
        if (e === driver) return 'source';
        const d = this.resolveData(this.units.get(e.src), e.outIdx);
        const node = this.nodes.find((node) => node.nodeId === d?.nodeId);
        return node ? `ctx.steps?.[${JSON.stringify(node.inputs?.action || node.label)}]?.[${JSON.stringify(d.socket)}]` : 'undefined';
      });
      let body;
      if (p.mode === 'combine' && !['combineByPosition', 'mergeByPosition'].includes(p.combineBy || p.combinationMode || 'combineByPosition')) {
        body = "throw new Error('This loop merge needs an explicit field-matching implementation');";
        this.approximateStep(n, 'merge.loop', 'The loop merge uses field matching; configure an explicit per-item join.');
      } else if (p.mode === 'chooseBranch') {
        body = `const ctx = {{ctx}};\nreturn ${expressions[(p.output || 1) - 1] || 'source'};`;
      } else {
        body = `const ctx = {{ctx}};\nconst inputs = [${expressions.join(', ')}];\nconst lists = inputs.map((value) => Array.isArray(value) ? value : value == null ? [] : [value]);\nconst merged = Array.from({ length: Math.min(...lists.map((values) => values.length)) }, (_, i) => Object.assign({}, ...lists.map((values) => values[i])));\nreturn merged.length === 1 ? merged[0] : merged;`;
      }
      const node = this.addNode('merge', n, 'NodeTransform', n.name, { mode: 'jsCode', jsCode: body });
      const unit = this.simpleUnit(n.name, 'data', node);
      unit.mergeDriver = driver;
      unit.loopInitializers = initialization;
      return unit;
    }
    // An append merge of exclusive branches is a continuation for whichever
    // branch ran. A data-watching NodeSync would wait for inactive branches,
    // lose the loop's run id, or reuse a previous iteration's input.
    const branchChoices = (edge) => {
      const choices = new Map();
      for (const b of this.byName.values()) {
        if (!['n8n-nodes-base.if', 'n8n-nodes-base.switch', '@n8n/n8n-nodes-langchain.textClassifier'].includes(b.type)) continue;
        const ports = this.edgesKept.filter((e) => e.src === b.name &&
          (e === edge || (e.dst !== n.name && this.reaches(e.dst, edge.src)))).map((e) => e.outIdx);
        if (ports.length) choices.set(b.name, new Set(ports));
      }
      return choices;
    };
    const choices = incoming.map(branchChoices);
    const exclusive = incoming.every((_, i) => incoming.every((__, j) => i === j ||
      [...choices[i]].some(([branch, ports]) => choices[j].has(branch) && [...ports].every((port) => !choices[j].get(branch).has(port)))));
    if ((!p.mode || p.mode === 'append') && exclusive) {
      return this.simpleUnit(n.name, 'data', this.addNode('merge', n, 'NodeTransform', n.name, { mode: 'jsCode', jsCode: 'return source;' }));
    }
    // Serialize disjoint linear branches with a nested loop. Its completion
    // retains the outer item run id, unlike a data-watching NodeSync.
    if (incoming.length === 2 && ((!p.mode || p.mode === 'append') || (p.mode === 'combine' && ['combineByPosition', 'mergeByPosition'].includes(p.combineBy || p.combinationMode || 'combineByPosition')))) {
      for (const name of this.order) {
        const fork = this.edgesKept.filter((e) => e.src === name);
        const ports = [...new Set(fork.map((e) => e.outIdx))];
        for (const port of ports) {
          const branches = fork.filter((e) => e.outIdx === port);
          if (branches.length !== 2) continue;
          const routes = [...incoming].sort((a, b) => a.inIdx - b.inIdx).map((ret) => branches.find((e) => {
            let at = e.dst;
            const seen = new Set();
            while (at !== ret.src && !seen.has(at)) {
              seen.add(at);
              const next = this.edgesKept.filter((x) => x.src === at);
              if (next.length !== 1 || next[0].dst === n.name) return false;
              at = next[0].dst;
            }
            return at === ret.src && this.edgesKept.filter((x) => x.src === at).length === 1;
          }));
          if (routes.some((e) => !e) || routes[0] === routes[1]) continue;
          const merge = this.addNode('merge', n, 'NodeTransform', n.name, { mode: 'jsCode', jsCode: !p.mode || p.mode === 'append'
            ? 'return source.flatMap((value) => Array.isArray(value) ? value : [value]);'
            : 'const lists = source.map((v) => Array.isArray(v) ? v : [v]);\nconst merged = Array.from({ length: Math.min(...lists.map((v) => v.length)) }, (_, i) => Object.assign({}, ...lists.map((v) => v[i])));\nreturn merged.length === 1 ? merged[0] : merged;' });
          const unit = this.simpleUnit(n.name, 'data', merge);
          unit.mergeFork = { routes, returns: [...incoming].sort((a, b) => a.inIdx - b.inIdx), n };
          return unit;
        }
      }
    }
    this.approximateStep(n, 'merge.loop', 'Parallel loop branches need a trigger-driven join before returning to NEXT; this step stops instead of reusing stale data.');
    return this.simpleUnit(n.name, 'data', this.addNode('merge', n, 'NodeTransform', n.name, {
      mode: 'jsCode', jsCode: "throw new Error('Configure a trigger-driven join for the parallel loop branches before returning to NEXT');",
    }));
  }

  buildItemLoop(n, pred, plan) {
    const size = X.toJs(plan.batchSize);
    const prepare = this.transformNode(n, 'loop-input', `Items: ${n.name}`,
      `// Preserve the original batch boundaries; NodeLoop runs each batch sequentially.\nconst size = Number(${size});\nif (!Number.isInteger(size) || size < 1) throw new Error('Batch size must be a positive integer');\nif (size === 1) return __items;\nconst batches = [];\nfor (let i = 0; i < __items.length; i += size) batches.push(__items.slice(i, i + size));\nreturn batches;`, pred);
    const loop = this.addNode('loop', n, 'NodeLoop', n.name, {});
    // Publish the current item through Transform's stable label. References
    // to $('Loop') inside the body must never read the full input or last batch.
    const item = this.addNode('loop-item', n, 'NodeTransform', `Item: ${n.name}`, { mode: 'jsCode', jsCode: 'return source;' });
    const done = this.addNode('loop-results', n, 'NodeTransform', `Results: ${n.name}`, {
      mode: 'jsCode', jsCode: '// n8n done emits the returned items, without the batch envelope.\nreturn source.flatMap((value) => Array.isArray(value) ? value : [value]);',
    });
    this.addEdge(this.sock(prepare, 'onDone'), this.sock(loop, 'RUN'));
    this.addEdge(this.sock(prepare, 'transformed'), this.sock(loop, 'items'));
    this.addEdge(this.sock(loop, 'onItem'), this.sock(item, 'RUN'));
    this.addEdge(this.sock(loop, 'item'), this.sock(item, 'source'));
    this.addEdge(this.sock(loop, 'onDone'), this.sock(done, 'RUN'));
    this.addEdge(this.sock(loop, 'results'), this.sock(done, 'source'));
    const exits = [];
    exits[plan.bodyIndex] = { trigger: this.sock(item, 'onDone'), data: this.dataExit(item), many: String(plan.batchSize).replace(/^=/, '') !== '1' };
    exits[plan.doneIndex] = { trigger: this.sock(done, 'onDone'), data: this.dataExit(done), many: true };
    this.setup.add(`"${n.name}" uses NodeLoop: process each item/batch, return through NEXT, and continue only after all results are collected.`);
    return { name: n.name, kind: 'loop', entry: this.sock(prepare, 'RUN'), dataIn: () => this.sock(prepare, 'source'), exits,
      lastNode: item, loopNode: loop, doneNode: done, plan, flags: {} };
  }

  wireLoopFork(unit) {
    const { routes, returns, n } = unit.mergeFork;
    const prepare = this.addNode('fork-input', n, 'NodeTransform', `Branches: ${n.name}`, {
      mode: 'jsCode', jsCode: 'return [0, 1].map((branch) => ({ branch, item: source }));',
    });
    const loop = this.addNode('fork-loop', n, 'NodeLoop', `Join: ${n.name}`, {});
    const condition = this.addNode('fork-condition', n, 'NodeTransform', `First branch: ${n.name}`, { mode: 'jsCode', jsCode: 'return source.branch === 0;' });
    const branch = this.addNode('fork-branch', n, 'NodeBranch', `Select branch: ${n.name}`, {});
    const source = this.units.get(routes[0].src);
    this.addEdge(source.exits[routes[0].outIdx].trigger, this.sock(prepare, 'RUN'));
    this.addEdge(this.resolveData(source, routes[0].outIdx), this.sock(prepare, 'source'));
    this.addEdge(this.sock(prepare, 'onDone'), this.sock(loop, 'RUN'));
    this.addEdge(this.sock(prepare, 'transformed'), this.sock(loop, 'items'));
    this.addEdge(this.sock(loop, 'onItem'), this.sock(condition, 'RUN'));
    this.addEdge(this.sock(loop, 'item'), this.sock(condition, 'source'));
    this.addEdge(this.sock(condition, 'onDone'), this.sock(branch, 'RUN'));
    this.addEdge(this.sock(condition, 'transformed'), this.sock(branch, 'condition'));
    routes.forEach((route, i) => {
      const entry = this.units.get(route.dst);
      const gate = this.addNode(`fork-item-${i}`, n, 'NodeTransform', `Branch ${i + 1}: ${n.name}`, {
        mode: 'jsCode', jsCode: `const ctx = {{ctx}};\nreturn ctx.steps[${JSON.stringify(loop.label)}].item.item;`,
      });
      this.addEdge(this.sock(branch, i === 0 ? 'TRUE' : 'FALSE'), this.sock(gate, 'RUN'));
      this.addEdge(this.sock(gate, 'onDone'), entry.entry);
      // Inline inputs were compiled against the original fork's output. The
      // inserted gate now publishes that same payload through `transformed`.
      const previous = this.resolveData(source, route.outIdx);
      const entryNode = this.nodes.find((node) => node.nodeId === entry.entry?.nodeId);
      if (previous?.key && entryNode?.inputs) {
        const token = new RegExp(`\\{\\{last\\.${previous.key}(?=[.}])`, 'g');
        entryNode.inputs = JSON.parse(JSON.stringify(entryNode.inputs).replace(token, '{{last.transformed'));
      }
      const dataIns = entry.dataInAll || (entry.dataIn ? [entry.dataIn] : []);
      for (const input of dataIns) this.addEdge(this.sock(gate, 'transformed'), input(route.inIdx));
      const end = this.units.get(returns[i].src);
      const exit = end.exits[Math.min(returns[i].outIdx, end.exits.length - 1)];
      this.addEdge(exit.trigger, this.sock(loop, 'NEXT'));
      this.addEdge(this.resolveData(end, returns[i].outIdx), this.sock(loop, 'result'));
    });
    this.addEdge(this.sock(loop, 'onDone'), unit.entry);
    this.addEdge(this.sock(loop, 'results'), unit.dataIn(0));
  }

  wireLoopInitializers(unit) {
    const { owner, names } = unit.loopInitializers;
    const loop = this.units.get(owner);
    const capture = this.addNode('loop-capture', this.byName.get(owner), 'NodeTransform', `Before loop: ${owner}`, { mode: 'jsCode', jsCode: 'return source;' });
    this.addEdge(this.sock(capture, 'transformed'), loop.dataIn(0));
    let trigger = this.sock(capture, 'onDone');
    for (const name of names) {
      const init = this.units.get(name);
      this.addEdge(trigger, init.entry);
      trigger = init.exits[0].trigger;
    }
    this.addEdge(trigger, loop.entry);
    loop.entry = this.sock(capture, 'RUN');
    loop.dataIn = () => this.sock(capture, 'source');
  }

  // -- assembly --------------------------------------------------------------

  buildBatchBodyUnit(n) {
    const incoming = this.incoming.get(n.name) || [];
    const many = incoming.some((e) => this.units.get(e.src)?.exits[e.outIdx]?.many);
    const inBatch = [...this.itemLoops.values()].some((p) => p.native && p.body.has(n.name) && String(p.batchSize).replace(/^=/, '') !== '1');
    const type = n.type.replace(/^n8n-nodes-base\./, '');
    const scalar = ['http', 'service', 'llm'].includes(M.classify(n.type)) ||
      ['convertToFile', 'extractFromFile', 'editImage', 'moveBinaryData', 'markdown', 'html', 'dateTime'].includes(type);
    if (!inBatch || !many || !scalar) {
      this.batchInputMany = inBatch && many;
      let unit;
      try { unit = this.buildUnit(n); } finally { this.batchInputMany = false; }
      if (unit.kind !== 'loop') {
        const outputsMany = ['splitOut', 'itemLists'].includes(type) || (many && !['aggregate', 'summarize'].includes(type));
        for (const exit of unit.exits) if (exit) exit.many = outputsMany;
      }
      return unit;
    }
    const synthetic = { ...n, name: `Each item: ${n.name}`, type: 'synthetic' };
    const loop = this.buildItemLoop(synthetic, this.predInfo(n.name), { bodyIndex: 1, doneIndex: 0, batchSize: 1 });
    this.predOverride = { name: n.name, pred: { key: 'transformed', nodeType: 'NodeTransform', unit: loop } };
    let body;
    try { body = this.buildUnit(n); } finally { this.predOverride = null; }
    if (!body.entry || body.exits.length !== 1 || !body.exits[0].trigger) throw new Error(`Cannot map batch body ${n.name}: needs one completion path`);
    this.addEdge(loop.exits[1].trigger, body.entry);
    for (const input of body.dataInAll || (body.dataIn ? [body.dataIn] : [])) this.addEdge(loop.exits[1].data, input(0));
    this.addEdge(body.exits[0].trigger, this.sock(loop.loopNode, 'NEXT'));
    this.addEdge(body.exits[0].data, this.sock(loop.loopNode, 'result'));
    return { ...loop, name: n.name, kind: 'mapped', exits: [loop.exits[0]], lastNode: loop.doneNode, flags: body.flags };
  }

  convert() {
    this.prepare();
    for (const name of this.order) {
      const n = this.byName.get(name);
      const plan = this.repeatLoops.get(name);
      if (plan) beginRepeat(this, n, plan);
      this.units.set(name, this.buildBatchBodyUnit(n));
      if (plan) this.predOverride = null;
    }
    if (this.units.size === 0) return null;

    const forkEdges = new Set([...this.units.values()].flatMap((u) => u.mergeFork ? [...u.mergeFork.routes, ...u.mergeFork.returns] : []));
    const initialized = new Set([...this.units.values()].flatMap((u) => u.loopInitializers?.names || []));
    for (const unit of this.units.values()) if (unit.loopInitializers) this.wireLoopInitializers(unit);
    // Wire the n8n edges.
    for (const e of this.edgesKept) {
      if (forkEdges.has(e) || initialized.has(e.dst) || this.repeatIntercepts.has(e) || [...this.repeatLoops.values()].some((p) => p.incoming.includes(e))) continue;
      const su = this.units.get(e.src);
      const du = this.units.get(e.dst);
      if (!su || !du || su === du) continue;
      if (du.mergeDriver && du.mergeDriver !== e) continue;
      const exit = su.exits[Math.min(e.outIdx, su.exits.length - 1)];
      if (!exit) continue;
      if (exit.trigger && du.entry) this.addEdge(exit.trigger, du.entry);
      const dsrc = this.resolveData(su, e.outIdx);
      if (dsrc && !dsrc.start) {
        const targets = du.dataInAll?.length ? du.dataInAll.map((f) => f(e.inIdx)) : du.dataIn ? [du.dataIn(e.inIdx)] : [];
        for (const din of targets) if (din) this.addEdge({ nodeId: dsrc.nodeId, socket: dsrc.socket }, din);
      }
    }
    for (const unit of this.units.values()) if (unit.mergeFork) this.wireLoopFork(unit);
    wireRepeats(this);

    // A completed body advances its owning loop, never starts it again.
    // Branch returns use an adapter so an unselected branch cannot overwrite
    // another return path's result through a shared data socket.
    for (const e of this.loopReturns) {
      if (this.repeatIntercepts.has(e)) continue;
      const source = this.units.get(e.src);
      const target = this.units.get(e.dst);
      const exit = source?.exits[Math.min(e.outIdx, source.exits.length - 1)];
      if (!exit?.trigger || !target?.loopNode) throw new Error(`Cannot return ${e.src} to item loop ${e.dst}`);
      const data = this.resolveData(source, e.outIdx);
      const ret = this.addNode(`loop-return-${e.outIdx}-${e.dst}`, this.byName.get(e.src), 'NodeTransform', `Return: ${e.src}`, {
        mode: 'jsCode', jsCode: 'return source;',
      });
      this.addEdge(exit.trigger, this.sock(ret, 'RUN'));
      if (data && !data.start) this.addEdge(data, this.sock(ret, 'source'));
      this.addEdge(this.sock(ret, 'onDone'), this.sock(target.loopNode, 'NEXT'));
      this.addEdge(this.sock(ret, 'transformed'), this.sock(target.loopNode, 'result'));
    }

    // Every unit with a trigger input needs something to start it.
    const triggered = new Set(this.edges.filter((e) => NODE_TYPES[e.targetNodeType].inputs[e.targetInput]?.trigger).map((e) => e.target));
    let start = this.startUnit;
    for (const unit of [...this.units.values()]) {
      if (!unit.entry || triggered.has(unit.entry.nodeId)) continue;
      if ((this.incoming.get(unit.name) || []).length) continue;
      if (!start) {
        const node = this.addNode('start', { name: '__start', type: 'synthetic' }, 'NodeStart', 'Start', {});
        start = { name: '__start', kind: 'start', entry: null, dataIn: null, exits: [{ trigger: this.sock(node, 'trigger'), data: null }], flags: {}, lastNode: node };
        this.startUnit = start;
      }
      this.addEdge(start.exits[0].trigger, unit.entry);
    }
    if (!this.nodes.some((n) => ['NodeStart', 'NodeCron', 'NodeCdeWebhookTrigger'].includes(n.type))) {
      const node = this.addNode('start', { name: '__start', type: 'synthetic' }, 'NodeStart', 'Start', {});
      this.startUnit = { name: '__start', kind: 'start', entry: null, dataIn: null, exits: [{ trigger: this.sock(node, 'trigger'), data: null }], flags: {}, lastNode: node };
    }

    // Terminal units hand their result to an End node.
    const outgoing = new Set([...this.edgesKept, ...this.loopReturns, ...this.repeatReturns].map((e) => e.src));
    let endCount = 0;
    for (const unit of this.units.values()) {
      if (unit.kind === 'loop') {
        if (!this.edgesKept.some((e) => e.src === unit.name && e.outIdx === unit.plan.doneIndex) &&
            ![...this.loopReturns].some((e) => e.src === unit.name && e.outIdx === unit.plan.doneIndex)) {
          const node = this.addNode(`end${endCount++}`, { name: `__end:${unit.name}`, type: 'synthetic' }, 'NodeEnd', endCount > 1 ? `End ${endCount}` : 'End', {});
          this.addEdge(this.sock(unit.doneNode, 'transformed'), this.sock(node, 'result'));
        }
        continue;
      }
      if (unit.kind === 'end' || unit.kind === 'start' || outgoing.has(unit.name)) continue;
      const exit = unit.exits[0];
      if (!exit?.data || exit.data === 'inherit') continue;
      const node = this.addNode(`end${endCount++}`, { name: `__end:${unit.name}`, type: 'synthetic' }, 'NodeEnd', endCount > 1 ? `End ${endCount}` : 'End', {});
      this.addEdge({ nodeId: exit.data.nodeId, socket: exit.data.socket }, this.sock(node, 'result'));
    }

    // Every literal a person must replace becomes a declared setup value or secret.
    this.liftLiterals();

    // Workflow Configs: project/environment scope, run-input defaults, setup values and secret references.
    const cfgInputs = { projectId: '', environmentTagId: '' };
    const initialContext = { ...this.seeds, ...this.reg.context() };
    if (Object.keys(initialContext).length) cfgInputs.initialContext = initialContext;
    this.addNode('configs', { name: '__configs', type: 'synthetic' }, 'NodeWorkflowConfigs', 'Workflow Configs', cfgInputs);
    this.setup.add('Select the Project and Environment on the Workflow Configs node (the ids from `cdecli auth status`), then connect a credential for each connector below.');
    for (const c of [...this.connectors].sort()) {
      if (!M.isSystemConnector(c)) this.setup.add(`Connect ${c}: \`cdecli credential create -n "${c}" -p ${c} --template <formId> --secret <key>=<value>\` (see \`cdecli credential templates\`).`);
    }

    this.layout();
    return this.assemble();
  }

  /**
   * Placeholders, author ids and personal email addresses left in any step
   * input become `{{key}}` tokens backed by declared setup values; placeholders
   * that stand in for credentials become workflow secrets. The original values
   * never ship (quality.mjs scanLiterals finds the same literals).
   */
  liftLiterals() {
    const isRef = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$workflowSecret === 'string';
    for (const node of this.nodes) {
      if (node.type === 'NodeWorkflowConfigs' || !node.inputs) continue;
      const nodeName = this.report.nodes[node.nodeId]?.n8n || node.label;
      const url = node.type === 'NodeHttpRequest' ? String(node.inputs.url || '').replace(/^=/, '') : '';
      const host = /^https?:\/\/([^/?#:\s{}]+)/.exec(url.replace(/\{\{[\s\S]*?\}\}/g, 'X'))?.[1]?.toLowerCase() || '';
      const walk = (v, path) => {
        if (typeof v === 'string') {
          if (['connectorName', 'connectorLabel', 'action', 'type', 'mode'].includes(path)) return v;
          return liftString(path, v, (f, ctxKey) => {
            if (isSecretPlaceholder(f, path, ctxKey)) {
              const plan = authPlan(host, '', null);
              const words = f.text.replace(/[<>[\]]/g, '').replace(/[-_ ]+/g, '_').split('_').filter((w) => w && !/^(?:YOUR|REPLACE|WITH|INSERT|HERE|CHANGE|ME|CHANGEME|THE|TUA|LA)$/i.test(w)).join('_');
              const svc = (serviceName(host) || camel(ctxKey || '') || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
              // Name it after the field it was assigned to (`webhookSecret` -> WEBHOOK_SECRET), else its words, else the service.
              const key = plan?.key || (ctxKey && SECRET_NAME.test(ctxKey) ? upperSnake(ctxKey) : words && !/^(?:API_?KEY|TOKEN|KEY|SECRET)$/i.test(words) ? words.toUpperCase() : `${svc ? `${svc}_` : ''}${/token/i.test(words) ? 'TOKEN' : 'API_KEY'}`);
              const leafKey = String(path).split('.').pop();
              const ctx = this.reg.secret({
                key,
                label: plan?.label || `${key.replace(/_/g, ' ').toLowerCase()}`,
                host: host || undefined,
                headerFormat: plan ? headerFormat(plan) : node.type === 'NodeTransform' ? 'read inside the step code' : `${leafKey}: <secret>`,
                node: nodeName,
              });
              return `{{${ctx}}}`;
            }
            return this.setupVar({ ...literalVarName(f, path, ctxKey), literal: f.text }, nodeName);
          });
        }
        if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
        if (v && typeof v === 'object' && !isRef(v) && !(v instanceof X.RawJs)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)]));
        return v;
      };
      node.inputs = walk(node.inputs, '');
      // A Set-style config step that leaves a credential empty (`out["api_key"] = "";`).
      if (node.type === 'NodeTransform' && typeof node.inputs.jsCode === 'string') {
        node.inputs.jsCode = node.inputs.jsCode.replace(/(out\[\s*")([^"\]]+)("\s*\]\s*=\s*)""(\s*;)/g, (all, a, name, b, c) => {
          if (!SECRET_NAME.test(name)) return all;
          const ctx = this.reg.secret({ key: name, label: `${name.replace(/[_-]+/g, ' ')} (left empty in the original Set step)`, headerFormat: 'read inside the step code', node: nodeName });
          return `${a}${name}${b}"{{${ctx}}}"${c}`;
        });
      }
    }
  }

  layout() {
    const layer = new Map(this.nodes.map((n) => [n.nodeId, 0]));
    const preds = new Map(this.nodes.map((n) => [n.nodeId, []]));
    for (const e of this.edges) preds.get(e.target).push(e.source);
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      for (const e of this.edges.filter((e) => !isLoopReturn(e))) {
        const l = layer.get(e.source) + 1;
        if (l > layer.get(e.target)) {
          layer.set(e.target, l);
          changed = true;
        }
      }
    }
    const rows = new Map();
    for (const n of this.nodes) {
      if (n.type === 'NodeWorkflowConfigs') continue;
      const l = layer.get(n.nodeId);
      const row = rows.get(l) || 0;
      n.position = { x: 80 + l * 380, y: 100 + row * 260 };
      rows.set(l, row + 1);
    }
    const maxRows = Math.max(1, ...rows.values());
    const cfg = this.nodes.find((n) => n.type === 'NodeWorkflowConfigs');
    cfg.position = { x: 80, y: 100 + maxRows * 260 };
  }

  assemble() {
    const nodeTypes = [...new Set(this.nodes.map((n) => n.type))].sort();
    // Steps a person has to understand: n8n nodes minus notes; Yantra nodes
    // minus the End nodes and the Workflow Configs node the converter adds.
    const n8nSteps = (this.n8n.nodes || []).filter((n) => n?.type && n.type !== 'n8n-nodes-base.stickyNote' && !n.disabled).length;
    const yantraSteps = this.nodes.filter((n) => n.type !== 'NodeWorkflowConfigs' && n.type !== 'NodeEnd').length;
    const foldedHelpers = this.report.folded.filter((f) => f.as || f.model !== undefined || /langchain\.(lm|memory|outputParser|embeddings|textSplitter|document|retriever|tool)/.test(f.type)).map((f) => f.node);
    const unitCount = [...this.units.values()].filter((u) => u.kind !== 'start').length;
    const stubCount = this.report.unmapped.length;
    const coverage = unitCount ? Math.round(((unitCount - stubCount) / unitCount) * 100) / 100 : 1;
    const nodesJson = JSON.stringify(this.nodes);
    if (nodesJson.includes('<<n8n:')) this.setup.add('Values marked `<<n8n: ...>>` were JavaScript expressions the converter could not turn into run-context tokens; replace them by hand.');
    if (nodesJson.includes('TODO(yantra)')) this.setup.add('Some Transform conditions still contain TODO(yantra) for unsupported n8n operators; review those Branch/IF steps.');
    // Plain dashes everywhere, including text carried over from the originals.
    const dashes = (v) => {
      if (typeof v === 'string') return v.replace(/[–—]/g, '-');
      if (Array.isArray(v)) return v.map(dashes);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dashes(x)]));
      return v;
    };
    const wf = dashes({
      name: this.info.name,
      workflowSlug: this.info.slug,
      description: this.info.description,
      isPublic: true,
      nodes: this.nodes,
      edges: this.edges,
      template: {
        schemaVersion: 2,
        category: this.info.category,
        categoryLabel: this.info.categoryLabel,
        department: this.info.department,
        connectors: [...this.connectors].sort(),
        setupVars: this.reg.vars.size ? this.reg.setupVars() : undefined,
        setupSecrets: this.reg.secrets.size ? this.reg.setupSecrets() : undefined,
        activation: this.nodes.some((n) => n.type === 'NodeCron') ? `cdecli cron activate ${this.info.slug}` : undefined,
        nodeTypes,
        comparison: { n8nSteps, yantraSteps, foldedHelpers },
        source: {
          repo: sources.upstream.repo,
          path: this.info.sourcePath,
          commit: sources.upstream.commit,
          n8nName: this.n8n.name,
        },
        aliases: this.info.aliases?.length ? this.info.aliases : undefined,
        conversion: {
          tool: 'scripts/convert-n8n.mjs',
          status: 'needs-setup',
          coverage,
          unmapped: this.report.unmapped,
          approximate: this.report.approximate,
          folded: this.report.folded,
          removedEdges: this.report.removedEdges,
          loopPolicy: this.loopPolicy || undefined,
          triggers: this.report.triggers,
          hints: [...this.setup],
        },
        notes: this.report.notes,
        nodes: this.report.nodes,
      },
    });
    // Keep the graph builder's text/object expression handling, then migrate
    // its final graph through the same code used for the saved templates.
    migrateLlmChains(wf);
    simplifyLlmHelpers(wf);
    return applyQuality(wf, this.info.path);
  }
}

/**
 * Write the quality verdict (lib/quality.mjs) into the template: tier,
 * blockers, the setup list, and the legacy conversion.status derived from the
 * tier. Keys are placed so the JSON reads top-down: verdict first, detail after.
 */
function applyQuality(wf, relPath) {
  const q = evaluate(wf, { catalog: catalogFull, verified, path: relPath });
  const { template } = wf;
  template.conversion.status = q.status;
  const ordered = {};
  for (const [k, v] of Object.entries(template)) {
    if (k === 'conversion') {
      ordered.tier = q.tier;
      ordered.blockers = q.blockers;
      ordered.setup = q.setup;
    }
    ordered[k] = v;
  }
  wf.template = ordered;
  return wf;
}

// ---------------------------------------------------------------------------
// Generators for data nodes (return jsCode bodies; `source` / `__items` shims come from the prelude)
// ---------------------------------------------------------------------------

const GET_HELPER = "const __get = (o, p) => String(p).split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);\n";
const SET_HELPER = "const __set = (o, p, v) => { const ks = String(p).split('.'); let c = o; for (const k of ks.slice(0, -1)) { if (c[k] == null || typeof c[k] !== 'object') c[k] = {}; c = c[k]; } c[ks[ks.length - 1]] = v; return o; };\n";
const ITEMS = 'const __items = Array.isArray(source) ? source : source == null ? [] : [source];\n';

function joinExpr(parts) {
  const exprs = parts.filter((p) => p !== undefined && p !== null && p !== '');
  if (exprs.length === 1) return exprs[0];
  if (exprs.every((p) => !X.isExpression(p))) return exprs.join('\n\n');
  return '=' + exprs.map((p) => (X.isExpression(p) ? p.slice(1) : p)).join('\n\n');
}

function pickParams(spec, p) {
  const out = {};
  for (const [k, s] of Object.entries(spec)) {
    const v = typeof s === 'function' ? s(p) : M.param(p, s);
    if (v !== undefined && v !== '' && v !== null) out[k] = v;
  }
  return out;
}

function setBody(p) {
  const includeOther = p.includeOtherFields ?? (p.keepOnlySet === undefined ? false : !p.keepOnlySet);
  if (p.mode === 'raw') {
    // Set node in JSON mode: `jsonOutput` is JSON text with {{ }} expressions, evaluated per item.
    const raw = p.jsonOutput ?? '{}';
    return [
      `// Set fields from JSON (n8n Set node, JSON mode)${includeOther ? ', keeping the other input fields' : ''}: once per input item, like n8n.`,
      'const __out = __items.map(($json) => {',
      '  const __in = $json && typeof $json === "object" && !Array.isArray($json) ? $json : {};',
      `  const __raw = ${X.toJs(raw)};`,
      "  let __obj;",
      "  try { __obj = typeof __raw === 'string' ? JSON.parse(__raw) : __raw; } catch (e) { throw new Error('Set node JSON is not valid JSON: ' + e.message); }",
      `  return ${includeOther ? '{ ...__in, ...__obj }' : '__obj'};`,
      '});',
      'return __out.length === 1 ? __out[0] : __out;',
    ].join('\n');
  }
  const assignments = collectSetAssignments(p);
  const dotted = p.options?.dotNotation !== false && assignments.some((a) => a.name.includes('.'));
  const cast = (type, js) => {
    switch (type) {
      case 'number':
        return `Number(${js})`;
      case 'boolean':
        return `((v) => v === true || v === 'true')(${js})`;
      case 'array':
      case 'object':
        return `((v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } })(${js})`;
      default:
        return js;
    }
  };
  const lines = [];
  lines.push(`// Set fields (n8n Set node)${includeOther ? ', keeping the other input fields' : ''}: once per input item, like n8n.`);
  if (dotted) lines.push(SET_HELPER.trim());
  lines.push('const __out = __items.map(($json) => {');
  lines.push('  const __in = $json && typeof $json === "object" && !Array.isArray($json) ? $json : {};');
  lines.push(`  const out = ${includeOther ? '{ ...__in }' : '{}'};`);
  for (const a of assignments) {
    lines.push('  ' + (dotted && a.name.includes('.') ? `__set(out, ${JSON.stringify(a.name)}, ${cast(a.type, X.toJs(a.value))});` : `out[${JSON.stringify(a.name)}] = ${cast(a.type, X.toJs(a.value))};`));
  }
  lines.push('  return out;');
  lines.push('});');
  lines.push('return __out.length === 1 ? __out[0] : __out;');
  return lines.join('\n');
}

/** Assignments from an n8n Set node (all historical parameter shapes). */
function collectSetAssignments(p) {
  const assignments = [];
  if (Array.isArray(p.assignments?.assignments)) {
    for (const a of p.assignments.assignments) if (a?.name) assignments.push({ name: a.name, value: a.value, type: a.type });
  } else if (p.values && typeof p.values === 'object') {
    for (const [type, arr] of Object.entries(p.values)) for (const a of arr || []) if (a?.name) assignments.push({ name: a.name, value: a.value, type });
  } else if (Array.isArray(p.fields?.values)) {
    for (const a of p.fields.values) if (a?.name) assignments.push({ name: a.name, value: a.stringValue ?? a.numberValue ?? a.booleanValue ?? a.arrayValue ?? a.objectValue, type: a.type });
  }
  return assignments;
}

/**
 * When `$('SetNode').json.field` points at a constant Set assignment, return the
 * literal string so HTTP URLs can drop <<n8n:>> markers.
 */
function staticSetLiteral(n8nNode, path) {
  if (!n8nNode || n8nNode.type !== 'n8n-nodes-base.set' || !path) return null;
  const top = path.split('.')[0];
  const a = collectSetAssignments(n8nNode.parameters || {}).find((x) => x.name === path || x.name === top);
  if (!a) return null;
  let v = a.value;
  if (v == null) return null;
  if (typeof v === 'string') {
    // n8n often stores plain constants as "=value" (expression mode, no {{ }}).
    if (v.startsWith('=') && !/\{\{/.test(v)) v = v.slice(1);
    else if (v.startsWith('=') || X.containsExpression(v)) return null;
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** All constant fields on a Set node as a plain object (for `$('Name')` shims). */
function staticSetObject(n8nNode) {
  if (!n8nNode || n8nNode.type !== 'n8n-nodes-base.set') return null;
  const out = {};
  for (const a of collectSetAssignments(n8nNode.parameters || {})) {
    if (!a?.name) continue;
    let v = a.value;
    if (v == null) continue;
    if (typeof v === 'string') {
      if (v.startsWith('=') && !/\{\{/.test(v)) v = v.slice(1);
      else if (v.startsWith('=') || X.containsExpression(v)) continue;
    } else if (typeof v !== 'number' && typeof v !== 'boolean') continue;
    out[a.name] = v;
  }
  return Object.keys(out).length ? out : null;
}

function fileIoBody(type, p) {
  const name = JSON.stringify(p.fileName || p.filePath || p.options?.fileName || 'file');
  if (type === 'n8n-nodes-base.writeBinaryFile' || (type === 'n8n-nodes-base.readWriteFile' && (p.operation || 'read') === 'write')) {
    return [
      '// Write file: emit a Yantra file object (no host filesystem).',
      FILE_CONTENT,
      `return { data: __text, fileName: ${name}, mimeType: 'application/octet-stream' };`,
    ].join('\n');
  }
  if (type === 'n8n-nodes-base.moveBinaryData') {
    const dest = JSON.stringify(p.destinationKey || p.options?.destinationKey || 'data');
    return `// moveBinaryData: surface binary/file payload as a JSON field.\n${FILE_CONTENT}\nreturn { ...($json && typeof $json === 'object' ? $json : {}), ${dest}: __text };`;
  }
  return `// Read file: expect file content on the previous step (text or base64).\n${FILE_CONTENT}\nreturn { data: __text, fileName: ${name}, mimeType: 'application/octet-stream' };`;
}

function cryptoBody(p) {
  const action = String(p.action || p.type || 'hash').toLowerCase();
  const outKey = JSON.stringify(p.dataPropertyName || 'data');
  const valueJs =
    p.value !== undefined && p.value !== null
      ? X.toJs(typeof p.value === 'string' && !p.value.startsWith('=') ? '=' + JSON.stringify(p.value) : p.value)
      : `($json && ($json.data ?? $json.value ?? $json.text ?? $json))`;
  if (action === 'generate') {
    return [
      '// crypto generate → UUID.',
      `return { ...($json && typeof $json === 'object' && !Array.isArray($json) ? $json : {}), ${outKey}: crypto.randomUUID() };`,
    ].join('\n');
  }
  if (action === 'encode' || action === 'base64' || (action === 'hash' && String(p.type || p.algorithm || '').toLowerCase() === 'base64')) {
    return [
      '// crypto encode → base64 (Buffer shim).',
      `const __v = String(${valueJs} ?? '');`,
      `return { ...($json && typeof $json === 'object' && !Array.isArray($json) ? $json : {}), ${outKey}: Buffer.from(__v, 'utf8').toString('base64') };`,
    ].join('\n');
  }
  if (action === 'decode') {
    return [
      '// crypto decode ← base64 (Buffer shim).',
      `const __v = String(${valueJs} ?? '');`,
      `return { ...($json && typeof $json === 'object' && !Array.isArray($json) ? $json : {}), ${outKey}: Buffer.from(__v, 'base64').toString('utf8') };`,
    ].join('\n');
  }
  // hash / hmac / sign: fail closed. A fake digest would silently pass or fail signature checks.
  return [
    `// crypto ${action} (${String(p.type || p.algorithm || '').toUpperCase() || 'digest'}): the Yantra Transform runtime has no synchronous digest/HMAC.`,
    '// Stop the run instead of returning a fake value; see the template setup list.',
    `throw new Error(${JSON.stringify(`crypto ${action} is not available in the Yantra Transform runtime; verify signatures or compute hashes before this workflow or in a connector step`)});`,
  ].join('\n');
}

/** A literal secret in an auth-like header becomes a placeholder; everything else is kept. */
function redactSecret(name, value) {
  if (typeof value !== 'string' || value.startsWith('=') || value.includes('{{')) return value;
  if (!/^(?:authorization|proxy-authorization)$/i.test(name) && !/token|api-?key|apikey|secret/i.test(name)) return value;
  const m = /^((?:Bearer|Basic|Token)\s+)?(.*)$/i.exec(value.trim());
  const secret = m[2];
  if (/^[A-Za-z0-9_\-.=+/]{20,}$/.test(secret) && !/YOUR|CHANGE|REPLACE|INSERT|EXAMPLE/i.test(secret) && /\d/.test(secret)) return `${m[1] || ''}YOUR_API_KEY`;
  return value;
}

function isBase64Crypto(p) {
  const action = String(p.action || p.type || 'hash').toLowerCase();
  return action === 'encode' || action === 'decode' || action === 'base64' || (action === 'hash' && String(p.type || p.algorithm || '').toLowerCase() === 'base64');
}

// node:crypto functions a Code node may call. WebCrypto's randomUUID /
// getRandomValues exist in the Transform runtime; nothing else does.
const WEB_CRYPTO = new Set(['randomUUID', 'getRandomValues', 'subtle', 'webcrypto']);
const SIGNATURE_CRYPTO = new Set(['createHmac', 'createHash', 'timingSafeEqual', 'createSign', 'createVerify', 'sign', 'verify', 'hash']);

/** node:crypto functions a Code body uses (`crypto.x(`, or destructured from require('crypto')). */
function cryptoUsage(code) {
  const fns = new Set([...code.matchAll(/\bcrypto\s*\.\s*([A-Za-z]+)/g)].map((m) => m[1]));
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"](?:node:)?crypto['"]\s*\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (name) fns.add(name);
    }
  }
  return [...fns].filter((f) => !WEB_CRYPTO.has(f)).sort();
}

/**
 * A `crypto` object for Transform code: WebCrypto where it exists, and every
 * other node:crypto function the code calls throws. Nothing returns a fake digest.
 */
function cryptoPrelude(fns) {
  const missing = fns.map((f) => `${JSON.stringify(f)}: __noCrypto(${JSON.stringify(f)})`).join(', ');
  return [
    "// node:crypto is not available in the Yantra Transform runtime. Calls below fail closed instead of faking a digest.",
    "const __noCrypto = (fn) => () => { throw new Error('crypto.' + fn + ' is not available in the Yantra Transform runtime; verify signatures or hash in a connector step or before the workflow'); };",
    `const crypto = { randomUUID: () => globalThis.crypto.randomUUID(), getRandomValues: (a) => globalThis.crypto.getRandomValues(a), ${missing} };`,
  ].join('\n');
}

const JS_KEYWORDS = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'of', 'true', 'false', 'null', 'undefined']);

/**
 * n8n ran Code nodes in sloppy mode, so `total = 0` created a global. Transform
 * steps run under "use strict"; declare such identifiers up front.
 */
function implicitGlobals(code) {
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  // `let a, b = 1, c;` declares every name in the list.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^;\n]*)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (name) declared.add(name);
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) for (const part of m[1].split(',')) declared.add(part.split(/[:=\s]/).filter(Boolean).pop());
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) for (const part of m[1].split(',')) declared.add(part.replace(/=.*/, '').trim());
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
  const out = new Set();
  const consider = (name) => {
    if (!name || declared.has(name) || JS_KEYWORDS.has(name) || name.startsWith('$') || name.startsWith('__')) return;
    out.add(name);
  };
  for (const m of code.matchAll(/(^|[;{}\n]\s*)([A-Za-z_$][\w$]*)\s*=(?![=>])/gm)) consider(m[2]);
  // `for (item of items)` without a declaration keyword.
  for (const m of code.matchAll(/\bfor\s*\(\s*([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) consider(m[1]);
  return [...out];
}

/** Rewrite or drop allowlisted `require()` so Code can run in Transform. Returns null if any require is unknown. */
function rewriteAllowlistedRequires(code) {
  const mods = [...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  if (!mods.length) return code;
  const baseOf = (m) => m.replace(/^node:/, '').split('/')[0];
  const allowed = new Set(['crypto', 'buffer', 'lodash', 'moment']);
  if (!mods.every((m) => allowed.has(baseOf(m)))) return null;
  // `const { createHmac } = require('crypto')` reads from the Transform's crypto object (see cryptoPrelude).
  let out = code.replace(/((?:const|let|var)\s*\{[^}]*\}\s*=\s*)require\s*\(\s*['"](?:node:)?crypto['"]\s*\)/g, '$1crypto');
  out = out.replace(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"][^'"]+['"]\s*\)\s*;?/g, '/* require($1) removed for Transform */');
  out = out.replace(/\brequire\s*\(\s*['"][^'"]+['"]\s*\)/g, 'undefined');
  const bases = new Set(mods.map(baseOf));
  const prelude = [];
  if (bases.has('lodash') || /\b_\./.test(code)) {
    prelude.push(
      "const _ = { get: (o, p, d) => String(p).split('.').reduce((a, k) => (a == null ? undefined : a[k]), o) ?? d, map: (a, f) => (a || []).map(f), pick: (o, ks) => Object.fromEntries((ks || []).map((k) => [k, o?.[k]])) };",
    );
  }
  if (bases.has('moment')) {
    prelude.push('const moment = (v) => ({ format: () => String(v ?? new Date().toISOString()), toISOString: () => new Date(v || Date.now()).toISOString() });');
  }
  return (prelude.length ? prelude.join('\n') + '\n' : '') + out;
}

/**
 * Detect a single await fetch / $http call and leave a clearer stub path.
 * Full HTTP+Transform split is rare enough that we return null unless the body is trivial.
 */
function trySplitAsyncHttpCode(_n, _code, _p, _pred, _conv) {
  return null;
}

function codeBody(n, p) {
  let code = p.jsCode ?? p.functionCode ?? p.code ?? 'return $input.all();';
  const globals = implicitGlobals(code);
  if (globals.length) code = `let ${globals.join(', ')}; // declared for strict mode (n8n ran this code in sloppy mode)\n${code}`;
  const perItem = p.mode === 'runOnceForEachItem' || n.type === 'n8n-nodes-base.functionItem';
  const legacy = n.type === 'n8n-nodes-base.function' || n.type === 'n8n-nodes-base.functionItem';
  // n8n code returns items as [{ json }]; __unwrap strips the wrapper and a
  // single item becomes the payload itself, so the next step reads it as `$json`.
  // Code that builds n8n binary data keeps it on the item as `binary` (base64 in
  // binary.<prop>.data), where file steps downstream read it (FILE_REF).
  const unwrap = (/\bbinary\b/.test(code)
    ? "const __one = (i) => (i && typeof i === 'object' && 'json' in i ? (i.binary && typeof i.binary === 'object' ? { ...i.json, binary: i.binary } : i.json) : i);\nconst __unwrap = (v) => Array.isArray(v) ? v.map(__one) : v && typeof v === 'object' && 'json' in v && Object.keys(v).length <= 3 ? __one(v) : v;\n"
    : "const __unwrap = (v) => Array.isArray(v) ? v.map((i) => (i && typeof i === 'object' && 'json' in i ? i.json : i)) : v && typeof v === 'object' && 'json' in v && Object.keys(v).length <= 3 ? v.json : v;\n") +
    'const __single = (v) => (Array.isArray(v) && v.length === 1 ? v[0] : v);';
  const indented = code.split('\n').map((l) => '  ' + l).join('\n');
  if (perItem) {
    return `// Ported from n8n ${legacy ? 'Function Item' : 'Code'} node "${n.name}" (run once for each item).\n${unwrap}\nconst __results = __items.map((__item) => {\n  const $json = __item;\n  const item = { json: __item };\n  const $input = { item: { json: __item }, first: () => ({ json: __item }), all: () => [{ json: __item }] };\n  return (() => {\n${indented}\n  })();\n});\nreturn __single(__results.map(__unwrap));`;
  }
  return `// Ported from n8n ${legacy ? 'Function' : 'Code'} node "${n.name}".\n${unwrap}\n${legacy ? 'const items = $input.all();\n' : ''}const __out = (() => {\n${indented}\n})();\nreturn __single(__unwrap(__out));`;
}

function conditionJs(p) {
  const c = p.conditions;
  const parts = [];
  let combinator = '&&';
  if (c && Array.isArray(c.conditions)) {
    combinator = c.combinator === 'or' ? '||' : '&&';
    for (const cond of c.conditions) if (cond) parts.push(opJs(cond.operator?.type || 'string', cond.operator?.operation || 'equals', X.toJs(cond.leftValue), cond.operator?.singleValue ? undefined : X.toJs(cond.rightValue)));
  } else if (c && typeof c === 'object') {
    combinator = p.combineOperation === 'any' ? '||' : '&&';
    for (const [type, arr] of Object.entries(c)) for (const cond of arr || []) if (cond) parts.push(opJs(type, cond.operation || 'equal', X.toJs(cond.value1), X.toJs(cond.value2)));
  }
  if (!parts.length) return 'true';
  return parts.map((x) => `(${x})`).join(` ${combinator} `);
}

function opJs(type, op, L, R) {
  // n8n stores some filter operations with its expression prefix (`=equal`).
  if (typeof op === 'string' && op.startsWith('=')) op = op.slice(1);
  const s = (v) => `String(${v} ?? '')`;
  switch (`${type}.${op}`) {
    case 'string.equals':
    case 'string.equal':
      return `${s(L)} === ${s(R)}`;
    case 'string.notEquals':
    case 'string.notEqual':
      return `${s(L)} !== ${s(R)}`;
    case 'string.contains':
      return `${s(L)}.includes(${s(R)})`;
    case 'string.notContains':
      return `!${s(L)}.includes(${s(R)})`;
    case 'string.startsWith':
      return `${s(L)}.startsWith(${s(R)})`;
    case 'string.notStartsWith':
      return `!${s(L)}.startsWith(${s(R)})`;
    case 'string.endsWith':
      return `${s(L)}.endsWith(${s(R)})`;
    case 'string.notEndsWith':
      return `!${s(L)}.endsWith(${s(R)})`;
    case 'string.regex':
      return `new RegExp(${s(R)}).test(${s(L)})`;
    case 'string.notRegex':
      return `!new RegExp(${s(R)}).test(${s(L)})`;
    case 'string.empty':
    case 'string.isEmpty':
      return `${s(L)}.trim() === ''`;
    case 'string.notEmpty':
    case 'string.isNotEmpty':
      return `${s(L)}.trim() !== ''`;
    case 'number.equals':
    case 'number.equal':
      return `Number(${L}) === Number(${R})`;
    case 'number.notEquals':
    case 'number.notEqual':
      return `Number(${L}) !== Number(${R})`;
    case 'number.gt':
    case 'number.larger':
      return `Number(${L}) > Number(${R})`;
    case 'number.gte':
    case 'number.largerEqual':
      return `Number(${L}) >= Number(${R})`;
    case 'number.lt':
    case 'number.smaller':
      return `Number(${L}) < Number(${R})`;
    case 'number.lte':
    case 'number.smallerEqual':
      return `Number(${L}) <= Number(${R})`;
    case 'boolean.true':
      return `(${L}) === true || (${L}) === 'true'`;
    case 'boolean.false':
      return `(${L}) === false || (${L}) === 'false'`;
    case 'boolean.equals':
    case 'boolean.equal':
      return `Boolean(${L}) === Boolean(${R})`;
    case 'boolean.notEquals':
    case 'boolean.notEqual':
      return `Boolean(${L}) !== Boolean(${R})`;
    case 'dateTime.after':
      return `new Date(${L}) > new Date(${R})`;
    case 'dateTime.before':
      return `new Date(${L}) < new Date(${R})`;
    case 'dateTime.afterOrEquals':
      return `new Date(${L}) >= new Date(${R})`;
    case 'dateTime.beforeOrEquals':
      return `new Date(${L}) <= new Date(${R})`;
    case 'dateTime.equals':
    case 'dateTime.equal':
      return `new Date(${L}).getTime() === new Date(${R}).getTime()`;
    case 'array.contains':
      return `(Array.isArray(${L}) ? ${L} : []).includes(${R})`;
    case 'array.notContains':
      return `!(Array.isArray(${L}) ? ${L} : []).includes(${R})`;
    case 'array.lengthEquals':
      return `(Array.isArray(${L}) ? ${L} : []).length === Number(${R})`;
    case 'array.lengthNotEquals':
      return `(Array.isArray(${L}) ? ${L} : []).length !== Number(${R})`;
    case 'array.lengthGt':
      return `(Array.isArray(${L}) ? ${L} : []).length > Number(${R})`;
    case 'array.lengthGte':
      return `(Array.isArray(${L}) ? ${L} : []).length >= Number(${R})`;
    case 'array.lengthLt':
      return `(Array.isArray(${L}) ? ${L} : []).length < Number(${R})`;
    case 'array.lengthLte':
      return `(Array.isArray(${L}) ? ${L} : []).length <= Number(${R})`;
    default:
      // Empty operator (n8n sometimes emits `string.` with no op) → treat as equals / truthy.
      if (!op || op === '') {
        if (R === undefined) return `Boolean(${L})`;
        if (type === 'string' || type === 'number' || type === 'boolean' || type === 'dateTime') {
          return opJs(type, type === 'dateTime' ? 'equal' : 'equals', L, R);
        }
      }
      if (op === 'exists' || op === 'notExists') return `(${L}) ${op === 'exists' ? '!=' : '=='} null`;
      if (op === 'empty' || op === 'notEmpty') {
        const empty = `((v) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v).length === 0))(${L})`;
        return op === 'empty' ? empty : `!${empty}`;
      }
      return `Boolean(${L}) /* TODO(yantra): unsupported operator ${type}.${op} */`;
  }
}

function switchRules(p) {
  const rules = [];
  let fallback = null;
  if (Array.isArray(p.rules?.values)) {
    p.rules.values.forEach((r, i) => {
      if (!r) return;
      const label = r.renameOutput && r.outputKey ? r.outputKey : `rule ${i + 1}`;
      rules.push({ label, js: `return Boolean(${conditionJs({ conditions: r.conditions })});`, index: i });
    });
    const fb = p.options?.fallbackOutput;
    if (fb === 'extra') fallback = rules.length;
    else if (typeof fb === 'number') fallback = fb;
  } else if (Array.isArray(p.rules?.rules)) {
    const type = p.dataType || 'string';
    const L = X.toJs(p.value1);
    p.rules.rules.forEach((r, i) => {
      if (!r) return;
      const op = r.operation || (type === 'string' ? 'equal' : 'equal');
      rules.push({ label: `rule ${i + 1}`, js: `return Boolean(${opJs(type, op, L, X.toJs(r.value2))});`, index: r.output ?? i });
    });
    if (typeof p.fallbackOutput === 'number') fallback = p.fallbackOutput;
  }
  return { rules, fallback };
}

function splitOutBody(p, allItems = false) {
  const field = String(p.fieldToSplitOut || '').split(',')[0].trim();
  const include = p.include === 'allOtherFields' || p.include === 'selectedOtherFields';
  return `${GET_HELPER}// Split out "${field}" into one item per element.\n${allItems ? 'return __items.flatMap((__base) => {' : 'const __base = __items[0] ?? {};'}\nconst __v = __get(__base, ${JSON.stringify(field)});\nconst __arr = Array.isArray(__v) ? __v : __v == null ? [] : [__v];\nreturn __arr.map((x) => ${include ? `({ ...__base, ${JSON.stringify(field)}: x })` : `(x && typeof x === 'object' && !Array.isArray(x) ? x : { ${JSON.stringify(field)}: x })`});${allItems ? '\n});' : ''}`;
}

function itemListsBody(p) {
  switch (p.operation || 'splitOutItems') {
    case 'splitOutItems':
      return splitOutBody(p);
    case 'aggregateItems':
      return aggregateBody(p);
    case 'removeDuplicates':
      return dedupeBody(p);
    case 'sort':
      return sortBody(p);
    case 'limit':
      return `return __items.slice(0, ${Number(p.maxItems) || 1});`;
    case 'summarize':
      return summarizeBody(p);
    case 'concatenateItems':
      return aggregateBody({ ...p, aggregate: p.aggregate || 'aggregateAllItemData' });
    default:
      return `// TODO(yantra): item lists operation "${p.operation}" is not ported.\nreturn source;`;
  }
}

function aggregateBody(p) {
  if ((p.aggregate || 'individualFields') === 'aggregateAllItemData') {
    return `return { ${JSON.stringify(p.destinationFieldName || 'data')}: __items };`;
  }
  const fields = p.fieldsToAggregate?.fieldToAggregate || [];
  const parts = fields.filter((f) => f?.fieldToAggregate).map((f) => {
    const field = f.fieldToAggregate.replace(/\[['"]([^'"]+)['"]\]/g, '.$1').replace(/^\./, '');
    const output = f.renameField && f.outputFieldName ? f.outputFieldName : field.split('.').at(-1);
    return `  ${JSON.stringify(output)}: __items.map((i) => __get(i, ${JSON.stringify(field)}))${p.options?.mergeLists ? '.flat()' : ''},`;
  });
  return `${GET_HELPER}return {\n${parts.join('\n')}\n};`;
}

function summarizeBody(p) {
  const fields = (p.fieldsToSummarize?.values || []).filter((f) => f?.field);
  const splitBy = String(p.fieldsToSplitBy || '').split(',').map((s) => s.trim()).filter(Boolean);
  const agg = fields.map((f) => `{ field: ${JSON.stringify(f.field)}, aggregation: ${JSON.stringify(f.aggregation || 'count')}, separateBy: ${JSON.stringify(f.separateBy || ',')} }`);
  return `${GET_HELPER}// Summarize (n8n Summarize node): ${fields.map((f) => `${f.aggregation || 'count'} of ${f.field}`).join(', ') || 'count'}${splitBy.length ? `, grouped by ${splitBy.join(', ')}` : ''}.
const __fields = [${agg.join(', ')}];
const __splitBy = ${JSON.stringify(splitBy)};
const __summarize = (rows) => {
  const out = {};
  for (const f of __fields) {
    const vals = rows.map((r) => __get(r, f.field)).filter((v) => v !== undefined && v !== null && v !== '');
    const nums = vals.map(Number).filter((n) => !Number.isNaN(n));
    const key = (f.aggregation === 'concatenate' ? 'concatenated' : f.aggregation) + '_' + f.field;
    switch (f.aggregation) {
      case 'count': out[key] = vals.length; break;
      case 'countUnique': out[key] = new Set(vals.map((v) => JSON.stringify(v))).size; break;
      case 'sum': out[key] = nums.reduce((a, b) => a + b, 0); break;
      case 'average': out[key] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; break;
      case 'min': out[key] = nums.length ? Math.min(...nums) : null; break;
      case 'max': out[key] = nums.length ? Math.max(...nums) : null; break;
      case 'append': out[key] = vals; break;
      case 'concatenate': out[key] = vals.join(f.separateBy); break;
      default: out[key] = vals;
    }
  }
  return out;
};
if (!__splitBy.length) return [__summarize(__items)];
const __groups = new Map();
for (const r of __items) {
  const k = __splitBy.map((f) => JSON.stringify(__get(r, f))).join('|');
  if (!__groups.has(k)) __groups.set(k, []);
  __groups.get(k).push(r);
}
return [...__groups.values()].map((rows) => ({ ...Object.fromEntries(__splitBy.map((f) => [f, __get(rows[0], f)])), ...__summarize(rows) }));`;
}

function dedupeBody(p) {
  const compare = p.compare || 'allFields';
  if (compare === 'selectedFields') {
    const fields = String(p.fieldsToCompare || '').split(',').map((s) => s.trim()).filter(Boolean);
    return `${GET_HELPER}const __seen = new Set();\nreturn __items.filter((i) => { const k = JSON.stringify(${JSON.stringify(fields)}.map((f) => __get(i, f))); if (__seen.has(k)) return false; __seen.add(k); return true; });`;
  }
  if (compare === 'allFieldsExcept') {
    const fields = String(p.fieldsToExclude || '').split(',').map((s) => s.trim()).filter(Boolean);
    return `const __seen = new Set();\nreturn __items.filter((i) => { const c = { ...i }; for (const f of ${JSON.stringify(fields)}) delete c[f]; const k = JSON.stringify(c); if (__seen.has(k)) return false; __seen.add(k); return true; });`;
  }
  return `const __seen = new Set();\nreturn __items.filter((i) => { const k = JSON.stringify(i); if (__seen.has(k)) return false; __seen.add(k); return true; });`;
}

function sortBody(p) {
  if (p.type === 'random') return `return [...__items].sort(() => Math.random() - 0.5);`;
  const fields = (p.sortFieldsUi?.sortField || []).filter((f) => f?.fieldName);
  if (!fields.length) return `// TODO(yantra): sort by code is not ported.\nreturn source;`;
  const cmp = fields.map((f) => `{ const a = __get(x, ${JSON.stringify(f.fieldName)}); const b = __get(y, ${JSON.stringify(f.fieldName)}); if (a !== b) return (a > b ? 1 : -1) * ${f.order === 'descending' ? -1 : 1}; }`).join('\n  ');
  return `${GET_HELPER}return [...__items].sort((x, y) => {\n  ${cmp}\n  return 0;\n});`;
}

function renameBody(p) {
  const keys = (p.keys?.key || []).filter((k) => k?.currentKey && k?.newKey);
  return `return __items.map((i) => { const o = { ...i }; ${keys.map((k) => `if (${JSON.stringify(k.currentKey)} in o) { o[${JSON.stringify(k.newKey)}] = o[${JSON.stringify(k.currentKey)}]; delete o[${JSON.stringify(k.currentKey)}]; }`).join(' ')} return o; });`;
}

function dateTimeBody(p) {
  const out = JSON.stringify(p.outputFieldName || 'date');
  const op = p.operation || 'formatDate';
  const ms = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000, months: 2592000000, years: 31536000000 };
  switch (op) {
    case 'getCurrentDate':
      return `return { ...$json, ${out}: new Date().toISOString() };`;
    case 'addToDate':
    case 'subtractFromDate': {
      const sign = op === 'addToDate' ? '+' : '-';
      return `// Date math (n8n ${op}). Format strings are not applied.\nconst __d = new Date(${X.toJs(p.magnitude ?? p.date)});\nreturn { ...$json, ${out}: new Date(__d.getTime() ${sign} Number(${X.toJs(p.duration ?? 0)}) * ${ms[p.timeUnit] || 86400000}).toISOString() };`;
    }
    case 'extractDate':
      return `const __d = new Date(${X.toJs(p.date)});\nconst __part = { year: __d.getFullYear(), month: __d.getMonth() + 1, day: __d.getDate(), hour: __d.getHours(), minute: __d.getMinutes(), second: __d.getSeconds() }[${JSON.stringify(p.part || 'day')}];\nreturn { ...$json, ${out}: __part };`;
    default:
      return `// Date formatting (n8n ${op}): ISO output, the original format string "${p.format || p.toFormat || ''}" is not applied.\nreturn { ...$json, ${out}: new Date(${X.toJs(p.date ?? p.value)}).toISOString() };`;
  }
}

// Files have no binary channel on Yantra: a step hands file content over as a
// string (text, or base64 for binary), either bare or under `data` / `content`.
/**
 * Required content params the original n8n node left blank (the author meant
 * the person to write them). They become declared setup values; content the
 * original filled from data is never replaced by a static value.
 */
const BLANK_CONTENT_VARS = {
  'whatsapp/WHATSAPP_SEND_MESSAGE': { text: { key: 'whatsappMessage', label: 'WhatsApp message text (the original node left it blank)', type: 'text', example: 'Thanks, we received your message.' } },
  'googlesuper/GOOGLESUPER_SEND_EMAIL': { body: { key: 'emailBody', label: 'Email body (the original node left it blank)', type: 'text', example: 'Hello, ...' } },
};

// ---------------------------------------------------------------------------
// Binary files (n8n `binary` data) on Yantra: base64 bytes or a file URL
// ---------------------------------------------------------------------------

/** n8n node types a binary file passes through unchanged (n8n keeps `binary` on the item). */
const BINARY_PASS_TYPES = new Set([
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.wait',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.set',
  'n8n-nodes-base.removeDuplicates',
  'n8n-nodes-base.aggregate',
  'n8n-nodes-base.itemLists',
]);

/** n8n nodes that read a binary file from an upstream step and have a Yantra file mapping. */
function binaryConsumer(n) {
  const p = n.parameters || {};
  const t = n.type;
  if (t === 'n8n-nodes-base.httpRequest' && p.sendBody) {
    if (p.contentType === 'binaryData') return true;
    if (p.contentType === 'multipart-form-data' && (p.bodyParameters?.parameters || []).some((x) => x?.parameterType === 'formBinaryData')) return true;
  }
  if (t === 'n8n-nodes-base.telegram' && p.binaryData === true) return true;
  if (t === 'n8n-nodes-base.jira' && p.resource === 'issueAttachment' && (p.operation ?? 'add') === 'add') return true;
  if ((t === '@n8n/n8n-nodes-langchain.openAi' || t === 'n8n-nodes-base.openAi') && p.resource === 'audio' && ['transcribe', 'translate'].includes(p.operation)) return true;
  if (t === 'n8n-nodes-base.dropbox' && p.binaryData === true) return true;
  if (t === 'n8n-nodes-base.googleDrive' && ((p.operation ?? 'upload') === 'upload' || (p.operation === 'update' && p.changeFileContent))) return true;
  if (t === 'n8n-nodes-base.readPDF') return true;
  return false;
}

/**
 * Can yantra-storage HTTP_SEND reach this URL? It only sends to public https
 * hosts, so a plain-http or private host (a self-hosted Gotenberg or Stirling
 * PDF on the LAN, Ollama on 127.0.0.1) is refused on purpose.
 */
function httpFileReachable(url) {
  const u = String(url ?? '').replace(/^=/, '').trim();
  if (/^http:\/\//i.test(u)) return { ok: false, why: `is a plain-http request (${u.slice(0, 60)}); yantra-storage HTTP_SEND only reaches public https hosts` };
  const host = /^https:\/\/([^/?#:{}\s]+)/i.exec(u)?.[1];
  if (host && (!host.includes('.') || /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host))) {
    return { ok: false, why: `calls the private host ${host}; yantra-storage HTTP_SEND only reaches public https hosts` };
  }
  return { ok: true };
}

/** Transform body: the HTTP_SEND result the way the n8n HTTP node handed its response on. */
function httpSendShape(fullResponse) {
  return [
    '// The response the way the n8n HTTP node handed it on: the parsed body; a file body is { bodyBase64, filename, mimeType }.',
    "const __r = source && typeof source === 'object' && source.data && typeof source.data === 'object' && 'status' in source.data ? source.data : source;",
    'const __body = __r?.bodyBase64 !== undefined ? { bodyBase64: __r.bodyBase64, filename: __r.filename, mimeType: __r.contentType, bytes: __r.bytes } : __r?.bodyJson !== undefined ? __r.bodyJson : __r?.bodyText;',
    fullResponse ? 'return { body: __body, headers: __r?.headers ?? {}, statusCode: __r?.status };' : 'return __body;',
  ].join('\n');
}

/**
 * Does an n8n HTTP Request hand a file on (n8n turns a media response into
 * binary data)? A file response format, a media Accept header, a plain
 * download (GET without a body) or an API known to answer with media.
 */
function httpReturnsFile(p) {
  if (p.options?.response?.response?.responseFormat === 'file') return true;
  const accept = (p.headerParameters?.parameters || []).find((h) => /^accept$/i.test(h?.name || ''))?.value;
  if (typeof accept === 'string' && /^(?:audio|image|video)\/|^application\/(?:pdf|octet-stream|zip)/i.test(accept)) return true;
  if (/image-api\.photoroom\.com|api\.remove\.bg|api\.elevenlabs\.io\/v1\/text-to-speech|\/api\/v1\/convert\//i.test(String(p.url ?? ''))) return true;
  return !p.sendBody && String(p.method || p.requestMethod || 'GET').toUpperCase() === 'GET';
}

/** A Code node that only renames another step's binary file and passes that item on. */
function renamedBinary(code) {
  const m = /^\s*\$\(\s*(['"])(.+?)\1\s*\)\.item\.binary\.([A-Za-z_$][\w$]*)\.fileName\s*=\s*(['"`])([^'"`$]*)\4\s*;?\s*return\s+\$\(\s*(['"])(.+?)\6\s*\)\.item\s*;?\s*$/.exec(String(code));
  return m && m[2] === m[7] ? { from: m[2], prop: m[3], fileName: m[5] } : null;
}

/**
 * Transform prelude: `__fileRef(value, prop)` finds the file on an upstream
 * step's output and returns `{ contentBase64 | fileUrl, filename, mimeType }`.
 * It reads n8n-style `binary.<prop>` (Code steps), the yantra-storage HTTP_SEND
 * `bodyBase64`, Drive downloads (`downloaded_file_content.s3url`), generated
 * image / audio URLs and `{ data, fileName, mimeType }` file objects (text
 * content is base64-encoded). It never invents a file: no file, no run.
 */
const FILE_REF = [
  '// The upstream file as { contentBase64 | fileUrl, filename, mimeType }: n8n binary data travels as base64 bytes or a file URL on Yantra.',
  "const __b64 = (t) => { const b = new TextEncoder().encode(String(t)); let s = ''; for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]); return btoa(s); };",
  'const __fileRef = (v, prop) => {',
  "  const s = (x) => (typeof x === 'string' && x !== '' ? x : undefined);",
  '  let r = Array.isArray(v) ? v[0] : v;',
  "  const bin = r && typeof r === 'object' && r.binary && typeof r.binary === 'object' ? r.binary[prop] ?? Object.values(r.binary)[0] : undefined;",
  "  if (bin && s(bin.data)) return { contentBase64: bin.data, filename: s(r.filename) ?? s(bin.fileName) ?? 'file', mimeType: s(bin.mimeType) };",
  "  if (r && typeof r === 'object' && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) r = { ...r, ...r.data };",
  '  const dl = r?.downloaded_file_content ?? r?.file;',
  "  const filename = s(r?.filename) ?? s(r?.fileName) ?? s(dl?.name) ?? s(r?.name) ?? 'file';",
  '  const mimeType = s(r?.mimeType) ?? s(r?.contentType) ?? s(dl?.mimetype) ?? s(r?.mimetype);',
  '  if (s(r?.bodyBase64)) return { contentBase64: r.bodyBase64, filename, mimeType };',
  '  const url = s(dl?.s3url) ?? s(r?.s3url) ?? s(r?.fileUrl) ?? s(r?.imageUrl) ?? s(r?.imageUrls?.[0]) ?? s(r?.audioUrl) ?? s(r?.videoUrl) ?? s(r?.secure_url);',
  '  if (url) return { fileUrl: url, filename, mimeType };',
  "  if (s(r?.data)) return { contentBase64: r.encoding !== 'base64' && /^(?:text\\/|application\\/(?:json|xml|javascript|x-tex))|\\+(?:xml|json)$/.test(mimeType ?? '') ? __b64(r.data) : r.data, filename, mimeType };",
  "  throw new Error('No file on the upstream step: expected file bytes (base64) or a file URL.');",
  '};',
  '',
].join('\n');

const FILE_CONTENT = "const __file = typeof source === 'string' ? source : source?.data ?? source?.content ?? source?.body ?? source;\nconst __text = typeof __file === 'string' ? __file : JSON.stringify(__file ?? '');";

const CSV_PARSE = [
  'const __rows = [];',
  "let __row = [], __cell = '', __q = false;",
  'for (let i = 0; i < __text.length; i++) {',
  '  const c = __text[i];',
  "  if (__q) { if (c === '\"' && __text[i + 1] === '\"') { __cell += '\"'; i++; } else if (c === '\"') __q = false; else __cell += c; continue; }",
  "  if (c === '\"') __q = true;",
  '  else if (c === __sep) { __row.push(__cell); __cell = \'\'; }',
  "  else if (c === '\\n' || c === '\\r') { if (c === '\\r' && __text[i + 1] === '\\n') i++; __row.push(__cell); __rows.push(__row); __row = []; __cell = ''; }",
  '  else __cell += c;',
  '}',
  "if (__cell !== '' || __row.length) { __row.push(__cell); __rows.push(__row); }",
].join('\n');

function extractFromFileBody(p) {
  const op = p.operation || 'csv';
  const key = JSON.stringify(p.destinationKey || 'data');
  if (op === 'text') return `// Read the file content as text.\n${FILE_CONTENT}\nreturn { ${key}: __text };`;
  if (op === 'fromJson') return `// Parse the file content as JSON.\n${FILE_CONTENT}\nconst __parsed = typeof __file === 'string' ? JSON.parse(__file) : __file;\nreturn ${p.destinationKey ? `{ ${key}: __parsed }` : '__parsed'};`;
  if (op === 'binaryToPropery') return `// Hand the file content (text or base64) on as a field.\n${FILE_CONTENT}\nreturn { ${key}: __text };`;
  if (op === 'csv') {
    const sep = JSON.stringify(p.options?.delimiter || ',');
    const header = p.options?.headerRow !== false;
    return `// Parse CSV rows${header ? ' into objects keyed by the header row' : ''}.\n${FILE_CONTENT}\nconst __sep = ${sep};\n${CSV_PARSE}\n${
      header ? 'const [__head = [], ...__body] = __rows;\nreturn __body.filter((r) => r.some((v) => v !== \'\')).map((r) => Object.fromEntries(__head.map((h, i) => [h, r[i] ?? \'\'])));' : 'return __rows.map((r) => Object.fromEntries(r.map((v, i) => [`column_${i + 1}`, v])));'
    }`;
  }
  return null;
}

function convertToFileBody(p) {
  const op = p.operation || 'csv';
  const o = p.options || {};
  const prop = p.sourceProperty || 'data';
  const value = typeof prop === 'string' && prop.startsWith('=') ? X.toJs(prop) : `$json${prop.split('.').map((k) => { const m = /^(.+?)((?:\[\d+\])*)$/.exec(k); return `?.[${JSON.stringify(m[1])}]${m[2].replace(/\[(\d+)\]/g, '?.[$1]')}`; }).join('')}`;
  const file = (data, name, mime) => `return { data: ${data}, fileName: ${o.fileName ? X.toJs(String(o.fileName).startsWith('=') ? o.fileName : '=' + o.fileName) : JSON.stringify(name)}, mimeType: ${JSON.stringify(o.mimeType || mime)} };`;
  if (op === 'toText') return `// Text file from a field.\nconst __v = ${value};\n${file("typeof __v === 'string' ? __v : JSON.stringify(__v, null, 2)", 'file.txt', 'text/plain')}`;
  if (op === 'toJson') return `// JSON file from the items.\n${file('JSON.stringify(source, null, 2)', 'file.json', 'application/json')}`;
  if (op === 'toBinary') return `// The field already holds base64 file content.\nconst __v = ${value};\n${file("typeof __v === 'string' ? __v : JSON.stringify(__v)", 'file', 'application/octet-stream').replace(/ \};$/, ", encoding: 'base64' };")}`;
  if (op === 'csv') {
    return [
      '// CSV file from the items.',
      'const __list = Array.isArray(source) ? source : [source];',
      'const __cols = [...new Set(__list.flatMap((r) => Object.keys(r ?? {})))];',
      "const __cell = (v) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[\",\\n\\r]/.test(s) ? '\"' + s.replace(/\"/g, '\"\"') + '\"' : s; };",
      "const __csv = [__cols.map(__cell).join(','), ...__list.map((r) => __cols.map((c) => __cell(r?.[c])).join(','))].join('\\n');",
      file('__csv', 'file.csv', 'text/csv'),
    ].join('\n');
  }
  return null;
}

function markdownBody(p, toMd) {
  const out = JSON.stringify(p.destinationKey || (toMd ? 'data' : 'data'));
  const input = X.toJs(toMd ? p.html : p.markdown);
  if (toMd) return `return { ...$json, ${out}: String(${input} ?? '').replace(/<style[\\s\\S]*?<\\/style>|<script[\\s\\S]*?<\\/script>/gi, '').replace(/<br\\s*\\/?>/gi, '\\n').replace(/<\\/p>/gi, '\\n\\n').replace(/<[^>]+>/g, '').trim() };`;
  return `const __md = String(${input} ?? '');\nconst __html = __md.replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>').replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>').replace(/\\*(.+?)\\*/g, '<em>$1</em>').replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2">$1</a>').replace(/\\n{2,}/g, '</p><p>');\nreturn { ...$json, ${out}: '<p>' + __html + '</p>' };`;
}

function cronInputs(type, p) {
  const two = (n) => String(Number(n) || 0);
  if (type === 'n8n-nodes-base.interval') {
    const unit = p.unit || 'seconds';
    const mult = { seconds: 1, minutes: 60, hours: 3600 }[unit] || 1;
    return { interval: (Number(p.interval) || 60) * mult };
  }
  if (type === 'n8n-nodes-base.cron') {
    const item = p.triggerTimes?.item?.[0] || {};
    switch (item.mode) {
      case 'everyMinute':
        return { cronExpression: '* * * * *' };
      case 'everyHour':
        return { cronExpression: `${two(item.minute)} * * * *` };
      case 'everyDay':
        return { cronExpression: `${two(item.minute)} ${two(item.hour)} * * *` };
      case 'everyWeek':
        return { cronExpression: `${two(item.minute)} ${two(item.hour)} * * ${two(item.weekday)}` };
      case 'everyMonth':
        return { cronExpression: `${two(item.minute)} ${two(item.hour)} ${Number(item.dayOfMonth) || 1} * *` };
      case 'everyX':
        return item.unit === 'hours' ? { cronExpression: `0 */${Number(item.value) || 1} * * *` } : { cronExpression: `*/${Number(item.value) || 1} * * * *` };
      case 'custom':
        return { cronExpression: item.cronExpression || '*/5 * * * *' };
      default:
        return { cronExpression: '0 9 * * *' };
    }
  }
  const rule = p.rule?.interval?.[0] || {};
  const m = two(rule.triggerAtMinute);
  const h = two(rule.triggerAtHour);
  switch (rule.field || 'days') {
    case 'seconds':
      return { interval: Number(rule.secondsInterval) || 60 };
    case 'minutes':
      return { cronExpression: `*/${Number(rule.minutesInterval) || 1} * * * *` };
    case 'hours':
      return { cronExpression: `${m} */${Number(rule.hoursInterval) || 1} * * *` };
    case 'days':
      return { cronExpression: `${m} ${h} ${Number(rule.daysInterval) > 1 ? `*/${Number(rule.daysInterval)}` : '*'} * *` };
    case 'weeks': {
      const days = Array.isArray(rule.triggerAtDay) && rule.triggerAtDay.length ? rule.triggerAtDay.join(',') : '1';
      return { cronExpression: `${m} ${h} * * ${days}` };
    }
    case 'months':
      return { cronExpression: `${m} ${h} ${Number(rule.triggerAtDayOfMonth) || 1} ${Number(rule.monthsInterval) > 1 ? `*/${Number(rule.monthsInterval)}` : '*'} *` };
    case 'cronExpression':
      return { cronExpression: rule.expression || '*/5 * * * *' };
    default:
      return { cronExpression: '0 9 * * *' };
  }
}

function schemaFromParser(p) {
  const type = p.schemaType || (p.jsonSchemaExample ? 'fromJson' : p.jsonSchema || p.inputSchema ? 'manual' : 'fromJson');
  try {
    if (type === 'manual') return JSON.parse(p.inputSchema || p.jsonSchema);
    if (p.jsonSchemaExample) return inferSchema(JSON.parse(p.jsonSchemaExample));
    if (p.jsonSchema) return JSON.parse(p.jsonSchema);
  } catch {
    return { type: 'object', additionalProperties: true };
  }
  return null;
}

function schemaFromExtractor(p) {
  const type = p.schemaType || 'fromAttributes';
  if (type === 'fromAttributes') {
    const attrs = (p.attributes?.attributes || []).filter((a) => a?.name);
    if (!attrs.length) return null;
    const properties = {};
    const required = [];
    for (const a of attrs) {
      properties[a.name] = { type: ['string', 'number', 'boolean', 'array', 'object'].includes(a.type) ? a.type : 'string', description: a.description || undefined };
      if (a.required) required.push(a.name);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }
  return schemaFromParser(p);
}

function inferSchema(value) {
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferSchema(value[0]) : {} };
  if (value && typeof value === 'object') {
    const properties = {};
    for (const [k, v] of Object.entries(value)) properties[k] = inferSchema(v);
    return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

// ---------------------------------------------------------------------------
// Fuzzy action and parameter matching for services without an explicit map
// ---------------------------------------------------------------------------

const SYNONYMS = {
  send: ['SEND', 'POST', 'CREATE', 'PUBLISH'],
  post: ['POST', 'SEND', 'CREATE', 'PUBLISH'],
  get: ['GET', 'FETCH', 'RETRIEVE', 'READ'],
  getall: ['LIST', 'GETALL', 'GET_ALL', 'FETCH', 'SEARCH', 'QUERY'],
  getmany: ['LIST', 'GETALL', 'GET_ALL', 'FETCH', 'SEARCH'],
  list: ['LIST', 'GETALL', 'GET_ALL'],
  create: ['CREATE', 'ADD', 'INSERT', 'POST', 'NEW'],
  add: ['ADD', 'CREATE', 'INSERT'],
  insert: ['INSERT', 'CREATE', 'ADD'],
  update: ['UPDATE', 'EDIT', 'PATCH', 'MODIFY', 'SET'],
  edit: ['EDIT', 'UPDATE', 'PATCH'],
  upsert: ['UPSERT', 'UPDATE', 'CREATE', 'ADD'],
  delete: ['DELETE', 'REMOVE', 'ARCHIVE'],
  remove: ['REMOVE', 'DELETE'],
  search: ['SEARCH', 'FIND', 'QUERY', 'LIST', 'LOOKUP'],
  find: ['FIND', 'SEARCH', 'LOOKUP', 'GET'],
  query: ['QUERY', 'SEARCH', 'EXECUTE', 'RUN'],
  execute: ['EXECUTE', 'RUN', 'QUERY'],
  executequery: ['EXECUTE', 'QUERY', 'RUN', 'SQL'],
  run: ['RUN', 'EXECUTE', 'START'],
  append: ['APPEND', 'ADD', 'CREATE'],
  read: ['READ', 'GET', 'FETCH', 'LIST', 'BATCH_GET'],
  upload: ['UPLOAD', 'CREATE_FILE', 'CREATE'],
  download: ['DOWNLOAD', 'GET', 'READ'],
  reply: ['REPLY', 'RESPOND', 'COMMENT'],
  complete: ['COMPLETE', 'CLOSE'],
  close: ['CLOSE', 'COMPLETE', 'RESOLVE'],
  move: ['MOVE'],
  copy: ['COPY', 'DUPLICATE'],
  share: ['SHARE', 'PERMISSION'],
  generate: ['GENERATE', 'CREATE', 'RUN'],
  analyze: ['ANALYZE', 'ANALYSE', 'DETECT'],
  transcribe: ['TRANSCRIBE', 'SPEECH_TO_TEXT', 'TRANSCRIPT'],
  translate: ['TRANSLATE'],
};

function words(s) {
  return String(s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toUpperCase()
    .split(' ')
    .filter(Boolean);
}

function fuzzyAction(actions, resource, operation) {
  const ids = Object.keys(actions || {});
  if (!ids.length) return null;
  const opWords = words(operation);
  const resWords = words(resource).filter((w) => !['ALL', 'A', 'AN', 'THE'].includes(w));
  const opSyn = new Set(opWords.flatMap((w) => SYNONYMS[w.toLowerCase()] || [w]));
  let best = null;
  let bestScore = 0;
  for (const id of ids) {
    const parts = id.split('_').slice(1);
    const joined = parts.join('_');
    let score = 0;
    let opHit = false;
    let resHit = false;
    for (const syn of opSyn) if (joined.includes(syn)) {
      score += 3;
      opHit = true;
      break;
    }
    for (const w of resWords) if (parts.includes(w) || parts.includes(w + 'S') || (w.endsWith('S') && parts.includes(w.slice(0, -1)))) {
      score += 2;
      resHit = true;
    }
    if (!opHit) continue;
    // Prefer matches that also hit the resource word when the n8n node names one.
    if (resWords.length && !resHit) continue;
    score -= parts.length * 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  // Require a stronger match than a lone operation synonym (cuts weak approximate noise).
  return bestScore >= 5 ? best : null;
}

function normKey(k) {
  return String(k).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function matchParams(actionParams, p) {
  const flat = {};
  const skip = new Set(['resource', 'operation', 'authentication', 'requestOptions', 'returnAll', 'simple', 'simplify']);
  const visit = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (skip.has(k)) continue;
      const val = M.rl(v);
      if (val && typeof val === 'object' && !Array.isArray(val) && ['additionalFields', 'updateFields', 'options', 'filters', 'fields', 'otherOptions'].includes(k)) visit(val, prefix);
      else if (val !== undefined && val !== null && val !== '') flat[k] = val;
    }
  };
  visit(p, '');
  const out = {};
  const keys = actionParams.map((k) => k.replace(/^\*/, ''));
  for (const [k, v] of Object.entries(flat)) {
    const nk = normKey(k);
    const hit = keys.find((ak) => normKey(ak) === nk) || keys.find((ak) => normKey(ak).endsWith(nk) || nk.endsWith(normKey(ak)));
    if (hit && out[hit] === undefined) out[hit] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Some upstream exports have the template title pasted after the closing
// brace. Keep the workflow object and drop the trailing text.
function parseExport(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const at = /non-whitespace character after JSON at position (\d+)/.exec(e.message);
    if (!at) throw e;
    return JSON.parse(text.slice(0, Number(at[1])));
  }
}

function convertWorkflow(n8n, info) {
  const converter = new Converter(n8n, info);
  return converter.convert();
}

function main() {
  if (!fs.existsSync(path.join(upstream, 'README.md'))) {
    console.error(`upstream checkout not found at ${upstream} (run npm run sync)`);
    process.exit(2);
  }
  const meta = readmeMetadata();
  const categories = new Map(sources.categories.map((c) => [c.upstream, c]));
  const skipped = [];
  const ignored = [];
  const aliased = [];
  const written = [];
  const slugs = new Set();
  const generatedDirs = new Set();

  // Hand-authored templates (template.conversion.tool === 'hand') replace the
  // mechanical conversion of the upstream file they name: the converter never
  // regenerates or deletes them.
  const handAuthored = new Map();
  for (const cat of categories.values()) {
    const dir = path.join(root, cat.slug);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const wf = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (wf.template?.conversion?.tool === 'hand') {
        handAuthored.set(wf.template.source?.path?.normalize('NFC'), `${cat.slug}/${f}`);
        slugs.add(`${cat.slug}/${path.basename(f, '.json')}`);
      }
    }
  }

  // Plan: parse every upstream file, find byte-identical duplicates (same
  // workflow published twice), assign slugs. A duplicate is converted once;
  // its would-be path is recorded as an alias of the canonical template.
  const plan = [];
  for (const [upstreamDir, cat] of categories) {
    const dir = path.join(upstream, upstreamDir);
    if (!fs.existsSync(dir)) continue;
    generatedDirs.add(cat.slug);
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      const rel = `${upstreamDir}/${f}`;
      if (only && !rel.includes(only)) continue;
      if (handAuthored.has(rel.normalize('NFC'))) {
        written.push({ path: handAuthored.get(rel.normalize('NFC')), status: 'ready', hand: true });
        continue;
      }
      let n8n;
      try {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        if (!text.trim()) {
          ignored.push({ path: rel, reason: 'empty upstream file; no workflow content to convert' });
          continue;
        }
        n8n = parseExport(text);
      } catch (e) {
        skipped.push({ path: rel, reason: `invalid JSON: ${e.message.split('\n')[0]}` });
        continue;
      }
      if (!Array.isArray(n8n?.nodes) || !n8n.nodes.length) {
        skipped.push({ path: rel, reason: 'not an n8n workflow export' });
        continue;
      }
      const m = meta.get(rel) || {};
      const name = clean(m.title || n8n.name || path.basename(f, '.json'));
      const hash = crypto.createHash('sha1').update(JSON.stringify({ nodes: n8n.nodes, connections: n8n.connections })).digest('hex');
      plan.push({ rel, f, cat, n8n, m, name, hash });
    }
  }
  // Canonical copy of a duplicate group: the file whose name matches the
  // workflow's own name, else the shortest path.
  const groups = new Map();
  for (const e of plan) groups.set(e.hash, [...(groups.get(e.hash) || []), e]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Prefer the file whose name shares the most words with the workflow's own name.
    const words = (x) => new Set(String(x || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
    const score = (e) => {
      const a = words(path.basename(e.f, '.json'));
      const b = words(e.n8n.name);
      const shared = [...a].filter((w) => b.has(w)).length;
      return -(shared / Math.max(1, new Set([...a, ...b]).size));
    };
    const canonical = [...group].sort((x, y) => score(x) - score(y) || x.rel.length - y.rel.length || x.rel.localeCompare(y.rel))[0];
    for (const e of group) if (e !== canonical) e.duplicateOf = canonical;
  }
  // Slugs: canonical entries first, so a duplicate takes the next free slug.
  const ordered = [...plan.filter((e) => !e.duplicateOf), ...plan.filter((e) => e.duplicateOf)];
  for (const e of ordered) {
    let slug = slugify(e.name);
    let i = 2;
    while (slugs.has(`${e.cat.slug}/${slug}`)) slug = `${slugify(e.name).slice(0, 66)}-${i++}`;
    slugs.add(`${e.cat.slug}/${slug}`);
    e.slug = slug;
    if (e.duplicateOf) {
      (e.duplicateOf.aliases ||= []).push({ path: `${e.cat.slug}/${slug}.json`, source: e.rel });
      aliased.push({ path: e.rel, canonical: e.duplicateOf.rel, alias: `${e.cat.slug}/${slug}.json`, target: `${e.duplicateOf.cat.slug}/${e.duplicateOf.slug}.json` });
    }
  }

  for (const e of plan) {
    if (e.duplicateOf) continue;
    const { rel, cat, n8n, m, name, slug } = e;
    const description = clean(m.description || n8n.meta?.description || `Converted from the n8n template "${n8n.name || name}".`);
    const outRel = `${cat.slug}/${slug}.json`;
    const converter = new Converter(n8n, {
      slug,
      name,
      description,
      category: cat.slug,
      categoryLabel: cat.label,
      department: m.department || '',
      sourcePath: rel,
      path: outRel,
      aliases: (e.aliases || []).map((a) => ({ path: a.path, source: { path: a.source, commit: sources.upstream.commit } })),
    });
    let wf;
    try {
      wf = converter.convert();
    } catch (err) {
      skipped.push({ path: rel, reason: `conversion failed: ${err.message}` });
      if (only) console.error(err);
      continue;
    }
    if (!wf) {
      skipped.push({ path: rel, reason: 'no executable nodes (notes only)' });
      continue;
    }
    const outDir = path.join(root, cat.slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(root, outRel), JSON.stringify(wf, null, 2) + '\n');
    written.push({ path: outRel, status: wf.template.conversion.status, tier: wf.template.tier, coverage: wf.template.conversion.coverage, nodes: wf.nodes.length });
  }

  // Remove generated files that no longer correspond to an upstream template.
  if (!only) {
    for (const dirSlug of generatedDirs) {
      const dir = path.join(root, dirSlug);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const rel = `${dirSlug}/${f}`;
        if (!written.some((w) => w.path === rel)) {
          const wf = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (wf.template?.conversion?.tool === 'scripts/convert-n8n.mjs') fs.unlinkSync(path.join(dir, f));
        }
      }
    }
  }

  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cache', 'conversion-report.json'), JSON.stringify({ written, aliased, ignored, skipped }, null, 2));
  const tiers = {};
  for (const w of written) if (!w.hand) tiers[w.tier] = (tiers[w.tier] || 0) + 1;
  const hand = written.filter((w) => w.hand).length;
  console.log(`converted ${written.length - hand} templates (${Object.entries(tiers).map(([k, v]) => `${v} ${k}`).join(', ')}), kept ${hand} hand-authored; ${aliased.length} duplicate aliases, ${ignored.length} empty upstream ${ignored.length === 1 ? 'file' : 'files'} ignored${skipped.length ? `; skipped ${skipped.length}` : ''}`);
  for (const s of ignored) console.log(`  ignored ${s.path}: ${s.reason}`);
  for (const s of skipped) console.log(`  skipped ${s.path}: ${s.reason}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { convertWorkflow, Converter };
