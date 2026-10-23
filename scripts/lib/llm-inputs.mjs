// Conservative, offline checks of LLM prompt inputs. Unknown API responses and
// arbitrary JavaScript are not treated as proof that a field exists or is absent.
import { NODE_TYPES } from './yantra-nodes.mjs';

const unknown = { type: 'unknown' };
const missing = { type: 'missing' };
const object = (properties, open = false) => ({ type: 'object', properties, open });
const tokens = (s) => [...String(s || '').matchAll(/\{\{\s*([\w$.[\]-]+)\s*\}\}/g)].map((m) => m[1]);
function fromSchema(s) {
  if (!s || typeof s.type !== 'string') return unknown;
  if (s.type === 'object') return object(Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, fromSchema(v)])), s.additionalProperties !== false);
  if (s.type === 'array') return { type: 'array', items: fromSchema(s.items) };
  return { type: s.type };
}
function get(shape, parts) {
  for (const key of parts) {
    if (shape.type === 'unknown' || shape.type === 'missing') return shape;
    if (shape.type === 'object') shape = shape.properties[key] || (shape.open ? unknown : missing);
    else if (shape.type === 'array') shape = /^\d+$/.test(key) ? shape.items : key === 'length' ? { type: 'number' } : missing;
    else if (shape.type === 'string') shape = key === 'length' ? { type: 'number' } : /^\d+$/.test(key) ? shape : missing;
    else return missing;
  }
  return shape;
}

export function auditLlmInputs(wf) {
  const byId = new Map((wf.nodes || []).map((n) => [n.nodeId, n]));
  const edges = wf.edges || [];
  const memo = new Map();
  const incoming = (n, key) => edges.find((e) => e.target === n.nodeId && e.targetInput === key);
  function shapeOf(n, socket, seen = new Set()) {
    if (!n || seen.has(n.nodeId)) return unknown;
    const cacheKey = `${n.nodeId}:${socket}`;
    if (memo.has(cacheKey)) return memo.get(cacheKey);
    seen = new Set(seen).add(n.nodeId);
    let shape = unknown;
    const source = () => { const e = incoming(n, 'source'); return e ? shapeOf(byId.get(e.source), e.sourceOutput, seen) : unknown; };
    if (n.type === 'NodeLlmChain' && socket === 'object') shape = fromSchema(n.inputs?.schema);
    else if (NODE_TYPES[n.type]?.outputs[socket]?.type === 'string') shape = { type: 'string' };
    else if (n.type === 'NodeTransform' && socket === 'transformed') {
      const code = n.inputs?.jsCode || '';
      if (code.includes('const __promptValue =')) {
        const key = /return \{ "(llm_(?:prompt|system)_[a-f0-9]{10})":/.exec(code)?.[1];
        shape = key ? object({ [key]: { type: 'string' } }) : { type: 'string' };
      }
      else if (code.includes('// Set fields (n8n Set node)')) {
        const fields = {};
        for (const m of code.matchAll(/^\s*out\[("(?:[^"\\]|\\.)*")\] = (.*);$/gm)) {
          const name = JSON.parse(m[1]);
          const copy = /^\(\$json\.([\w$.]+)\)$/.exec(m[2]);
          let upstream = source();
          if (upstream.type === 'array') upstream = upstream.items;
          fields[name] = copy ? get(upstream, copy[1].split('.')) : unknown;
        }
        if (Object.keys(fields).length) shape = object(fields, code.includes('const out = { ...__in }') || code.includes('__set(out,'));
      } else if (/return source;\s*$/.test(code)) shape = source();
      else if (/return __items\.(slice|filter)\(/.test(code)) {
        const s = source(); shape = { type: 'array', items: s.type === 'array' ? s.items : s };
      }
    } else if (n.type === 'NodeSync') {
      const e = incoming(n, socket);
      if (e) shape = shapeOf(byId.get(e.source), e.sourceOutput, seen);
    }
    memo.set(cacheKey, shape);
    return shape;
  }

  const rows = [];
  for (const chain of wf.nodes || []) {
    if (chain.type !== 'NodeLlmChain') continue;
    const row = { nodeId: chain.nodeId, label: chain.label, checked: 0, unknown: 0, problems: [] };
    const report = (socket, origin, path, shape) => {
      if (shape.type === 'missing') {
        const detail = `${socket} reads ${path}, which ${origin?.label || 'its source'} does not produce`;
        if (!row.problems.some((p) => p.detail === detail)) row.problems.push({ socket, source: origin?.label, path, detail });
      } else if (shape.type === 'unknown') row.unknown++;
      else row.checked++;
    };
    for (const socket of ['prompt', 'system', 'messages']) {
      let wire = incoming(chain, socket);
      if (!wire && chain.inputs?.[socket] === '{{last.transformed}}') {
        const trigger = incoming(chain, 'RUN');
        if (byId.get(trigger?.source)?.type === 'NodeTransform') wire = { source: trigger.source, sourceOutput: 'transformed' };
      }
      // Follow explicit Update Context writers back to their prompt builders.
      const reference = /^\{\{(llm_(?:prompt|system)_([a-f0-9]{10}))\}\}$/.exec(chain.inputs?.[socket] || '');
      if (!wire && reference) {
        const builder = byId.get(`node_${reference[2]}`);
        const published = builder && edges.some((e) => e.source === builder.nodeId && e.sourceOutput === 'transformed' && e.targetInput === 'patch' && byId.get(e.target)?.type === 'NodeUpdateContext');
        if (!published) {
          report(socket, null, reference[1], missing);
          continue;
        }
        report(socket, builder, reference[1], get(shapeOf(builder, 'transformed'), [reference[1]]));
        wire = { source: builder.nodeId, sourceOutput: 'transformed' };
      }
      if (wire) {
        const builder = byId.get(wire.source);
        if (builder?.type !== 'NodeTransform') { report(socket, builder, wire.sourceOutput, shapeOf(builder, wire.sourceOutput)); continue; }
        const edge = incoming(builder, 'source');
        const origin = edge && byId.get(edge.source);
        let shape = edge ? shapeOf(origin, edge.sourceOutput) : unknown;
        if (shape.type === 'array') shape = shape.items;
        const code = builder.inputs?.jsCode || '';
        const marker = code.search(/\/\/ (?:Prompt|System):/);
        const body = marker < 0 ? code : code.slice(marker);
        // Check required reads; optional fallback probes (context || documents)
        // intentionally accept absent fields and must not cause false blockers.
        const paths = new Set([...body.matchAll(/\$json((?:\.[A-Za-z_$][\w$]*|\[['"][^'"]+['"]\])+)(?![\w$])/g)]
          .filter((m) => !/^\s*(?:\|\||\?\?|\?\.)/.test(body.slice(m.index + m[0].length)))
          .map((m) => m[1].replace(/\[['"]([^'"]+)['"]\]/g, '.$1').slice(1)));
        for (const p of paths) {
          const field = p.split('.')[0];
          report(socket, origin, `$json.${field}`, get(shape, [field]));
        }
        if (!paths.size) row.unknown++;
      } else {
        const value = chain.inputs?.[socket];
        for (const token of tokens(value)) {
          if (!token.startsWith('last.')) { row.unknown++; continue; }
          const edge = incoming(chain, 'RUN');
          const origin = edge && byId.get(edge.source);
          const [, output, ...parts] = token.split('.');
          if (!origin || origin.type === 'NodeBranch') { row.unknown++; continue; }
          const shape = NODE_TYPES[origin.type]?.outputs[output] ? shapeOf(origin, output) : missing;
          report(socket, origin, token, get(shape, parts));
        }
        if (typeof value === 'string' && !value.includes('{{')) row.checked++;
      }
    }
    rows.push(row);
  }
  return rows;
}
