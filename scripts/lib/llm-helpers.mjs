// Remove generated prompt adapters only when their text and execution source
// can be represented exactly by run-context inputs. Unknown shapes stay wired.
import { NODE_TYPES } from './yantra-nodes.mjs';

const unknown = { type: 'unknown' };
const string = { type: 'string' };
const object = (properties = {}) => ({ type: 'object', properties });
const isBuilder = (n) => n?.type === 'NodeTransform' && /^(Prompt|System): /.test(n.label) && n.inputs?.jsCode?.includes('const __promptValue =');
const isWriter = (n) => n?.type === 'NodeUpdateContext' && /^Save (Prompt|System): /.test(n.label);
const aiTypes = new Set(['NodeLlmChain', 'NodeCdecliAgent']);
const prelude = '// n8n compatibility shims (generated). `source` is the upstream node output.\nconst __items = Array.isArray(source) ? source : source == null ? [] : [source];\nconst $json = __items[0] ?? source;\n';
const textReturn = "typeof __promptValue === 'string' ? __promptValue : JSON.stringify(__promptValue ?? '')";

function schemaShape(schema) {
  if (!schema || typeof schema.type !== 'string' || schema.$ref || schema.nullable) return unknown;
  if (schema.type === 'object') return object(Object.fromEntries((schema.required || [])
    .map((key) => [key, schemaShape(schema.properties?.[key])])));
  return { type: schema.type };
}

function field(shape, parts) {
  for (const part of parts) shape = shape.type === 'object' ? shape.properties?.[part] || unknown : unknown;
  return shape;
}

// Only simple identifiers are portable through Yantra's run-context tokens.
function jsonPath(expression) {
  const match = /^\(?\$json((?:\.[A-Za-z_$][\w$]*|\['[A-Za-z_$][\w$]*'\]|\["[A-Za-z_$][\w$]*"\])*)\)?$/.exec(expression);
  return match ? match[1].replace(/\[['"]([^'"]+)['"]\]/g, '.$1').split('.').filter(Boolean) : null;
}

function literalShape(expression, sourceShape) {
  try {
    const value = JSON.parse(expression);
    if (value === null || typeof value !== 'object') return { type: value === null ? 'null' : typeof value };
  } catch { /* Expressions are inspected, never executed during cleanup. */ }
  const parts = jsonPath(expression);
  if (parts) return field(sourceShape, parts);
  // A complete generated template literal always returns text, even when its
  // interpolations require JavaScript. Leave that work in the upstream Set.
  if (/^`(?:\\[\s\S]|[^`])*`$/.test(expression)) return string;
  return unknown;
}

function shapeReader(wf) {
  const byId = new Map(wf.nodes.map((n) => [n.nodeId, n]));
  return function shapeOf(n, socket, seen = new Set()) {
    if (!n || seen.has(n.nodeId)) return unknown;
    seen = new Set(seen).add(n.nodeId);
    if (n.type === 'NodeLlmChain' && socket === 'object') return schemaShape(n.inputs?.schema);
    if (NODE_TYPES[n.type]?.outputs[socket]?.type === 'string') return string;
    if (n.type !== 'NodeTransform' || socket !== 'transformed') return unknown;
    const code = n.inputs?.jsCode || '';
    const sources = wf.edges.filter((e) => e.target === n.nodeId && e.targetInput === 'source');
    let source = sources.length === 1 ? shapeOf(byId.get(sources[0].source), sources[0].sourceOutput, seen) : unknown;
    const runs = wf.edges.filter((e) => e.target === n.nodeId && e.targetInput === 'RUN');
    if (!sources.length && code.startsWith('// This step follows the Start node:') && runs.length === 1 &&
        byId.get(runs[0].source)?.type === 'NodeStart' &&
        !Object.hasOwn(n.inputs, 'source')) source = object();
    // Set maps each input item and collapses a singleton. Never assume an API
    // response or an arbitrary Transform returns one object instead of a list.
    if (!['string', 'object', 'number', 'boolean'].includes(source.type)) return unknown;
    if (!code.includes('// Set fields (n8n Set node)') || !code.endsWith('return __out.length === 1 ? __out[0] : __out;') || code.includes('__set(')) return unknown;
    const assignments = code.match(/const out = (?:\{\}|\{ \.\.\.__in \});\n([\s\S]*)  return out;\n\}\);/)?.[1];
    if (!assignments) return unknown;
    const fields = {};
    const assignment = /  out\[("(?:[^"\\]|\\.)*")\] = ([\s\S]*?);\n/g;
    let end = 0;
    for (const m of assignments.matchAll(assignment)) {
      if (m.index !== end) return unknown;
      fields[JSON.parse(m[1])] = literalShape(m[2], source);
      end = m.index + m[0].length;
    }
    return end === assignments.length ? object(fields) : unknown;
  };
}

function promptToken(expression, shape, output) {
  const parts = jsonPath(expression);
  if (parts) return field(shape, parts).type === 'string' ? `{{last.${[output, ...parts].join('.')}}}` : null;
  // Simple text interpolation is also supported. Objects/arrays must retain
  // JavaScript coercion (which differs from run-context JSON serialization).
  if (!expression.startsWith('`') || !expression.endsWith('`')) return null;
  const text = expression.slice(1, -1);
  let result = '', i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', '`': '`', '$': '$' };
      if (!Object.hasOwn(escapes, text[i + 1])) return null;
      result += escapes[text[i + 1]]; i += 2;
    } else if (text.startsWith('${', i)) {
      const end = text.indexOf('}', i + 2);
      if (end < 0) return null;
      const path = jsonPath(text.slice(i + 2, end));
      if (!path || !['string', 'number', 'integer', 'boolean'].includes(field(shape, path).type)) return null;
      result += `{{last.${[output, ...path].join('.')}}}`; i = end + 1;
    } else {
      if (text[i] === '`' || text.startsWith('{{', i)) return null;
      result += text[i++];
    }
  }
  // A lone token preserves its type at runtime, so numeric coercion still
  // needs the builder when there is no surrounding text.
  if (/^\{\{[^{}]+\}\}$/.test(result)) {
    const path = jsonPath(text.slice(2, -1));
    if (!path || field(shape, path).type !== 'string') return null;
  }
  return result;
}

/** Mutates only proven redundant prompt groups; returns an audit of all helpers. */
export function simplifyLlmHelpers(wf) {
  const rows = wf.nodes.filter((n) => isBuilder(n) || isWriter(n) || n.type === 'NodeChatModel' || wf.template?.nodes?.[n.nodeId]?.role === 'llm-chain-array')
    .map((n) => ({ nodeId: n.nodeId, label: n.label, type: n.type, action: 'keep', reason: n.type === 'NodeChatModel' ? 'Supplies the provider and model configuration.' :
      wf.template?.nodes?.[n.nodeId]?.role === 'llm-chain-array' ? 'Unwraps structured object output to preserve the original array.' :
        isWriter(n) ? 'Preserves system text while the prompt builder runs.' : 'Requires computation, serialization, or an unproven input shape.' }));
  const removed = new Set();
  for (const chain of wf.nodes.filter((n) => aiTypes.has(n.type))) {
    const byId = new Map(wf.nodes.map((n) => [n.nodeId, n]));
    const incomingRun = (id) => wf.edges.filter((e) => e.target === id && e.targetInput === 'RUN');
    let triggers = incomingRun(chain.nodeId), group = [];
    if (triggers.length !== 1) continue;
    let edge = triggers[0], origin = byId.get(edge.source);
    while ((isBuilder(origin) || isWriter(origin)) && !group.includes(origin)) {
      group.unshift(origin);
      triggers = incomingRun(origin.nodeId);
      if (triggers.length !== 1 || edge.sourceOutput !== 'onDone') break;
      edge = triggers[0]; origin = byId.get(edge.source);
    }
    if (!group.length || !origin || group.includes(origin) || edge.sourceOutput !== 'onDone') continue;
    const ids = new Set(group.map((n) => n.nodeId));
    const builders = group.filter(isBuilder);
    const replacements = {};
    const shapeOf = shapeReader(wf);
    let safe = builders.length > 0;
    for (const b of builders) {
      const code = b.inputs.jsCode;
      const prefix = `${prelude}// ${b.label}.\nconst __promptValue = `;
      const key = `llm_${b.label.startsWith('System:') ? 'system' : 'prompt'}_${b.nodeId.slice(5)}`;
      const suffix = `;\nreturn ${textReturn};`;
      const savedSuffix = `;\nreturn { ${JSON.stringify(key)}: ${textReturn} };`;
      const saved = code.endsWith(savedSuffix);
      if (!code.startsWith(prefix) || !(saved || code.endsWith(suffix)) || Object.keys(b.inputs).some((k) => !['mode', 'jsCode'].includes(k))) { safe = false; break; }
      const sources = wf.edges.filter((e) => e.target === b.nodeId && e.targetInput === 'source');
      if (sources.length !== 1 || sources[0].source !== origin.nodeId) { safe = false; break; }
      const output = sources[0].sourceOutput;
      const expression = code.slice(prefix.length, -(saved ? savedSuffix : suffix).length);
      const value = promptToken(expression, shapeOf(origin, output), output);
      if (value === null) { safe = false; break; }
      const socket = b.label.startsWith('System:') ? 'system' : chain.type === 'NodeCdecliAgent' ? 'message' : 'prompt';
      if (chain.inputs?.[socket] !== (saved ? `{{${key}}}` : '{{last.transformed}}') || Object.hasOwn(replacements, socket)) { safe = false; break; }
      replacements[socket] = value;
      if (saved && !group.some((n) => isWriter(n) && wf.edges.some((e) => e.source === b.nodeId && e.sourceOutput === 'transformed' && e.target === n.nodeId && e.targetInput === 'patch'))) { safe = false; break; }
    }
    if (!safe) continue;
    // Other last-dependent inputs, consumers, or named references would change
    // meaning if a helper disappeared. Keep the whole group in those cases.
    if (Object.entries(chain.inputs || {}).some(([k, v]) => !Object.hasOwn(replacements, k) && /\blast\./.test(JSON.stringify(v)))) continue;
    if (wf.edges.filter((e) => e.target === chain.nodeId && e.targetInput === 'llm').some((e) => /\blast\./.test(JSON.stringify(byId.get(e.source)?.inputs)))) continue;
    if (wf.edges.some((e) => ids.has(e.source) && !ids.has(e.target) && !(e.target === chain.nodeId && e.sourceOutput === 'onDone' && e.targetInput === 'RUN'))) continue;
    if (wf.edges.some((e) => ids.has(e.target) && !ids.has(e.source) && !(e.source === origin.nodeId && ['RUN', 'source'].includes(e.targetInput)))) continue;
    if (group.filter(isWriter).some((n) => Object.keys(n.inputs || {}).length || wf.edges.filter((e) => e.target === n.nodeId && e.targetInput === 'patch').length !== 1)) continue;
    const strings = (value) => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    const otherInputs = wf.nodes.filter((n) => !ids.has(n.nodeId) && n.nodeId !== chain.nodeId).flatMap((n) => strings(n.inputs));
    otherInputs.push(...Object.entries(chain.inputs || {}).filter(([k]) => !Object.hasOwn(replacements, k)).flatMap(([, v]) => strings(v)));
    if (group.some((n) => otherInputs.some((s) => s.includes(n.nodeId.slice(5)) ||
      (s.includes('steps') && (s.includes(JSON.stringify(n.label)) || s.includes(`'${n.label}'`)))))) continue;
    for (const n of group) removed.add(n.nodeId);
    wf.nodes = wf.nodes.filter((n) => !ids.has(n.nodeId));
    wf.edges = wf.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
    wf.edges.push({ ...edge, target: chain.nodeId, targetInput: 'RUN', targetNodeType: chain.type });
    Object.assign(chain.inputs, replacements);
    for (const n of group) if (wf.template?.nodes) delete wf.template.nodes[n.nodeId];
    for (const row of rows.filter((r) => ids.has(r.nodeId))) Object.assign(row, { action: 'remove', reason: 'Reads guaranteed text directly from the immediate upstream output.', consumer: chain.label, inputs: replacements });
  }
  if (removed.size && wf.template) {
    wf.template.nodeTypes = [...new Set(wf.nodes.map((n) => n.type))].sort();
    if (wf.template.comparison) wf.template.comparison.yantraSteps -= removed.size;
  }
  return { removed: removed.size, rows };
}
