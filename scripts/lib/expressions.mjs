// n8n expression handling.
//
// n8n stores an expression as a string that starts with "=" and embeds
// JavaScript inside `{{ ... }}`. Yantra has two places such a value can land:
//
// 1. A `NodeTransform` jsCode body, where the whole expression is real
//    JavaScript again. We keep it verbatim and provide shims for the n8n
//    globals ($json, $input, $('Node'), $now, ...) so most expressions run
//    unchanged with `source` (the upstream output) standing in for the item.
// 2. A static node input (an LLM prompt), where only run-context tokens are
//    available: `{{last.<output>.path}}`, `{{steps.<ACTION>.result.path}}` and
//    `{{<runInput>}}`. Only plain property paths can be expressed this way;
//    anything else is routed through a jsCode builder by the converter.

const EXPR_RE = /\{\{([\s\S]*?)\}\}/g;

/**
 * A value that only JavaScript can produce (never a run-context token). The
 * converter routes any parameter holding one through a params-builder Transform.
 */
export class RawJs {
  constructor(code) {
    this.code = code;
  }
}

export function isExpression(value) {
  return typeof value === 'string' && value.startsWith('=');
}

/** Split an n8n "=..." string into literal and expression segments. */
export function parseExpression(value) {
  const body = value.slice(1);
  const segments = [];
  let last = 0;
  for (const m of body.matchAll(EXPR_RE)) {
    if (m.index > last) segments.push({ text: body.slice(last, m.index) });
    // n8n tolerates a trailing semicolon inside {{ }}; inside `${ }` it is a syntax error.
    segments.push({ expr: m[1].trim().replace(/;+\s*$/, '') });
    last = m.index + m[0].length;
  }
  if (last < body.length) segments.push({ text: body.slice(last) });
  return segments;
}

/** Does a value (string or nested object) contain any n8n expression? */
export function containsExpression(value) {
  if (value instanceof RawJs) return true;
  if (isExpression(value)) return true;
  if (Array.isArray(value)) return value.some(containsExpression);
  if (value && typeof value === 'object') return Object.values(value).some(containsExpression);
  return false;
}

// --- 1. JavaScript mode -----------------------------------------------------

const SHIMS = [
  {
    // n8n runs a node once per item and `$json` is the current item; Yantra
    // passes the whole payload, so `$json` is the first item of a list and the
    // payload itself otherwise. Generators that need every item map over __items.
    test: /\$json\b/,
    code: 'const $json = __items[0] ?? source;',
  },
  {
    test: /\$input\b|\$items\(/,
    code:
      'const $input = { all: () => __items.map((json) => ({ json })), first: () => ({ json: __items[0] }), last: () => ({ json: __items[__items.length - 1] }), item: { json: __items[0] } };\n' +
      'const $items = () => $input.all();',
  },
  {
    test: /\$\(/,
    // Overridden by shimPrelude when a name→payload map is supplied.
    code:
      "// Cross-node references ($('Node')) resolve via __named when known, else the immediate upstream.\n" +
      'const $ = (name) => { const json = (typeof __named !== "undefined" && name in __named) ? __named[name] : source; const items = Array.isArray(json) ? json : json == null ? [] : [json]; const first = items[0] ?? json; return { item: { json: first }, first: () => ({ json: first }), last: () => ({ json: items[items.length - 1] ?? json }), all: () => items.map((j) => ({ json: j })), params: {}, isExecuted: true }; };',
  },
  {
    test: /\$node\b/,
    code: 'const $node = new Proxy({}, { get: () => ({ json: source, parameter: {} }) });',
  },
  {
    test: /\$now\b|\$today\b|\bDateTime\b/,
    code:
      'const __dt = (d) => { const x = new Date(d); Object.defineProperties(x, { year: { get() { return this.getFullYear(); } }, month: { get() { return this.getMonth() + 1; } }, day: { get() { return this.getDate(); } }, hour: { get() { return this.getHours(); } }, minute: { get() { return this.getMinutes(); } }, second: { get() { return this.getSeconds(); } }, millisecond: { get() { return this.getMilliseconds(); } }, weekNumber: { get() { const t = new Date(Date.UTC(this.getFullYear(), this.getMonth(), this.getDate())); const dayNum = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dayNum); const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return Math.ceil((((t - yearStart) / 86400000) + 1) / 7); } } }); x.toISO = () => x.toISOString(); x.toISODate = () => x.toISOString().slice(0, 10); x.toFormat = () => x.toISOString(); x.format = () => x.toISOString(); x.plus = (o) => { const y = new Date(x); if (o?.days) y.setDate(y.getDate() + o.days); if (o?.hours) y.setHours(y.getHours() + o.hours); if (o?.minutes) y.setMinutes(y.getMinutes() + o.minutes); if (o?.months) y.setMonth(y.getMonth() + o.months); if (o?.years) y.setFullYear(y.getFullYear() + o.years); return __dt(y); }; x.minus = (o) => { const n = {}; for (const k of Object.keys(o || {})) n[k] = -(o[k]); return x.plus(n); }; x.startOf = () => x; x.endOf = () => x; x.toMillis = () => x.getTime(); x.toSeconds = () => Math.floor(x.getTime() / 1000); return x; };\n' +
      'const $now = __dt(Date.now()); const $today = __dt(new Date().setHours(0, 0, 0, 0));\n' +
      'const DateTime = { now: () => __dt(Date.now()), fromISO: (s) => __dt(s), fromMillis: (n) => __dt(n), fromSeconds: (n) => __dt(n * 1000), fromJSDate: (d) => __dt(d) };',
  },
  {
    test: /\$env\b/,
    code: 'const $env = {}; // n8n environment variables are not available; read run-context values instead',
  },
  {
    test: /\$credentials\b/,
    code: 'const $credentials = new Proxy({}, { get: () => new Proxy({}, { get: () => "" }) }); // n8n credentials are not available; put secrets in the URL/headers by hand',
  },
  {
    // Legacy Code/Function nodes read the input list from a bare `items`.
    test: /(?<![\w$.])items\b(?![\w$]*\s*(?:=[^=]|:))/,
    declares: /\b(?:const|let|var|function)\s+items\b|\(\s*items\s*[,)]|\bitems\s*=>|\b(?:const|let|var)\s+[^;=]*,\s*items\b/,
    code: 'const items = __items.map((json) => ({ json }));',
  },
  {
    // Legacy Function Item nodes read the current item from a bare `item`.
    test: /(?<![\w$.])item\b(?![\w$]*\s*(?:=[^=]|:))/,
    declares: /\b(?:const|let|var|function)\s+item\b|\(\s*item\s*[,)]|\bitem\s*=>|\bof\s+\w+\)\s*\{[\s\S]*\bitem\b|\b(?:const|let|var)\s+[^;=]*,\s*item\b|\bfor\s*\(\s*(?:const|let|var)\s+item\b/,
    code: 'const item = { json: __items[0] ?? source, binary: {} };',
  },
  {
    // Legacy `$item(i).$node["Name"].json` and `$item(i).json`.
    test: /\$item\(/,
    code: 'const $item = (i = 0) => ({ json: __items[i] ?? source, $node: new Proxy({}, { get: () => ({ json: __items[i] ?? source, parameter: {} }) }) });',
  },
  {
    test: /\$if\(|\$min\(|\$max\(|\$ifEmpty\(/,
    code: 'const $if = (c, a, b) => (c ? a : b); const $min = (...n) => Math.min(...n); const $max = (...n) => Math.max(...n); const $ifEmpty = (v, d) => (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) ? d : v);',
  },
  {
    // n8n keeps static data across runs; a Yantra run starts empty, so the
    // object is fresh on every run (state is not remembered between runs).
    test: /\$getWorkflowStaticData\(/,
    code: 'const __staticData = {}; const $getWorkflowStaticData = () => __staticData; // not persisted between runs on Yantra',
  },
  {
    // Dotted-path subset of JMESPath: `$jmespath(obj, "a.b[0].c")`.
    test: /\$jmespath\(/,
    code: "const $jmespath = (obj, expr) => String(expr).replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean).reduce((a, k) => (a == null ? undefined : a[k]), obj); // dotted paths only",
  },
  {
    // Node's Buffer for the common base64 <-> utf8 round trips.
    test: /\bBuffer\./,
    code:
      "const Buffer = { from: (v, enc) => { const bytes = enc === 'base64' ? Uint8Array.from(atob(String(v)), (c) => c.charCodeAt(0)) : new TextEncoder().encode(String(v)); return { toString: (e) => (e === 'base64' ? btoa(String.fromCharCode(...bytes)) : new TextDecoder().decode(bytes)), length: bytes.length, bytes }; } };",
  },
  {
    test: /\$vars\b/,
    code: 'const $vars = {};',
  },
  {
    test: /\$workflow\b|\$executionId\b|\$execution\b|\$runIndex\b|\$itemIndex\b|\$binary\b|\$prevNode\b|\$parameter\b|\$position\b/,
    code:
      "const $workflow = { id: '', name: '', active: true }; const $execution = { id: '', mode: 'manual', resumeUrl: '' }; const $executionId = $execution.id;\n" +
      "const $runIndex = 0; const $itemIndex = 0; const $binary = {}; const $prevNode = { name: '', outputIndex: 0, runIndex: 0 }; const $parameter = {}; const $position = 0;",
  },
];

// n8n data-transformation functions (subset), one definition per method so a
// Transform carries only the helpers its code calls. Keyed by prototype.
const HELPERS = {
  String: {
    extractUrl: "extractUrl() { const m = this.match(/https?:\\/\\/[^\\s\"'<>]+/); return m ? m[0] : undefined; }",
    extractEmail: "extractEmail() { const m = this.match(/[\\w.+-]+@[\\w-]+\\.[\\w.-]+/); return m ? m[0] : undefined; }",
    extractDomain: 'extractDomain() { try { return new URL(String(this)).hostname; } catch { return undefined; } }',
    toSnakeCase: "toSnakeCase() { return this.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(); }",
    toTitleCase: 'toTitleCase() { return this.replace(/\\w\\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()); }',
    toSentenceCase: 'toSentenceCase() { return this.charAt(0).toUpperCase() + this.slice(1).toLowerCase(); }',
    removeMarkdown: "removeMarkdown() { return this.replace(/[*_~`#>]/g, ''); }",
    removeTags: "removeTags() { return this.replace(/<[^>]+>/g, ''); }",
    isEmpty: 'isEmpty() { return this.trim().length === 0; }',
    isNotEmpty: 'isNotEmpty() { return this.trim().length > 0; }',
    toNumber: 'toNumber() { return Number(this); }',
    toInt: 'toInt() { return parseInt(this, 10); }',
    toFloat: 'toFloat() { return parseFloat(this); }',
    toBoolean: "toBoolean() { return ['true', '1', 'yes'].includes(this.toLowerCase().trim()); }",
    toDateTime: 'toDateTime() { return __dt(String(this)); }',
    urlEncode: 'urlEncode() { return encodeURIComponent(String(this)); }',
    urlDecode: 'urlDecode() { return decodeURIComponent(String(this)); }',
    parseJson: 'parseJson() { try { return JSON.parse(String(this)); } catch { return undefined; } }',
    quote: 'quote() { return JSON.stringify(String(this)); }',
    // n8n hashes with md5/sha; the Transform runtime has no synchronous digest, so fail loudly instead of returning a fake hash.
    hash: "hash() { throw new Error('String.hash() needs a crypto digest, which the Yantra Transform runtime does not provide'); }",
  },
  Number: {
    isEven: 'isEven() { return this % 2 === 0; }',
    isOdd: 'isOdd() { return this % 2 !== 0; }',
    round: 'round(n = 0) { return Number(this.toFixed(n)); }',
    ceil: 'ceil() { return Math.ceil(this); }',
    floor: 'floor() { return Math.floor(this); }',
    toBoolean: 'toBoolean() { return this !== 0; }',
  },
  Array: {
    first: 'first() { return this[0]; }',
    last: 'last() { return this[this.length - 1]; }',
    sum: 'sum() { return this.reduce((a, b) => a + Number(b), 0); }',
    average: 'average() { return this.length ? this.reduce((a, b) => a + Number(b), 0) / this.length : 0; }',
    min: 'min() { return Math.min(...this.map(Number)); }',
    max: 'max() { return Math.max(...this.map(Number)); }',
    unique: 'unique() { return [...new Set(this)]; }',
    compact: "compact() { return this.filter((v) => v !== undefined && v !== null && v !== ''); }",
    pluck: 'pluck(...keys) { return this.map((o) => (keys.length === 1 ? o?.[keys[0]] : Object.fromEntries(keys.map((k) => [k, o?.[k]])))); }',
    randomItem: 'randomItem() { return this[Math.floor(Math.random() * this.length)]; }',
    isEmpty: 'isEmpty() { return this.length === 0; }',
    isNotEmpty: 'isNotEmpty() { return this.length > 0; }',
    toJsonString: 'toJsonString() { return JSON.stringify(this); }',
    merge: 'merge() { return Object.assign({}, ...this); }',
  },
  Object: {
    isEmpty: 'isEmpty() { return Object.keys(this).length === 0; }',
    isNotEmpty: 'isNotEmpty() { return Object.keys(this).length > 0; }',
    hasField: 'hasField(k) { return k in this; }',
    removeField: 'removeField(k) { const o = { ...this }; delete o[k]; return o; }',
    keys: 'keys() { return Object.keys(this); }',
    values: 'values() { return Object.values(this); }',
    toJsonString: 'toJsonString() { return JSON.stringify(this); }',
    urlEncode: 'urlEncode() { return new URLSearchParams(this).toString(); }',
    compact: "compact() { return Object.fromEntries(Object.entries(this).filter(([, v]) => v !== undefined && v !== null && v !== '')); }",
  },
};
const HELPER_NAMES = [...new Set(Object.values(HELPERS).flatMap((h) => Object.keys(h)))];
// Calls on these receivers are JavaScript built-ins or other shims, not n8n helpers.
const BUILTIN_RECEIVER = /(?:\bMath|\bObject|\bJSON|\bNumber|\bArray|\bReflect|\bPromise|\bDate|\bconsole|\bString|\bBuffer|\bcrypto|\bURL|\$input|\$\(\s*(['"])[^'"\n]*\1\s*\))\s*$/;

/** n8n helper methods a body calls (`x.first()`), ignoring built-in receivers such as `Math.max(`. */
export function usedHelpers(jsBody) {
  const used = new Set();
  for (const m of String(jsBody).matchAll(/\.\s*([A-Za-z]+)\s*\(/g)) {
    const name = m[1];
    if (!HELPER_NAMES.includes(name) || used.has(name)) continue;
    const before = jsBody.slice(Math.max(0, m.index - 80), m.index);
    if (BUILTIN_RECEIVER.test(before)) continue;
    used.add(name);
  }
  return used;
}

function helperPrelude(names) {
  if (!names.size) return [];
  const lines = [
    '// n8n data transformation helpers used by this step.',
    "const __def = (proto, fns) => { for (const [k, f] of Object.entries(fns)) if (!(k in proto)) Object.defineProperty(proto, k, { value: f, writable: true, configurable: true }); };",
  ];
  for (const [proto, fns] of Object.entries(HELPERS)) {
    const picked = Object.entries(fns).filter(([k]) => names.has(k)).map(([, code]) => code);
    if (picked.length) lines.push(`__def(${proto}.prototype, { ${picked.join(', ')} });`);
  }
  return lines;
}

/**
 * Build the shim prelude for a jsCode body. Only the shims the body actually
 * references are emitted so simple transforms stay readable.
 * `named` is optional: { [nodeName]: { kind: 'literal'|'step'|'ctx'|'output', value?, key?, socket?, llm? } }.
 */
export function shimPrelude(jsBody, named = {}) {
  const used = SHIMS.filter((s) => s.test.test(jsBody) && !(s.declares && s.declares.test(jsBody)));
  const helpers = usedHelpers(jsBody);
  const needsItems = /__items\b/.test(jsBody) || used.some((s) => s.code.includes('__items'));
  const dtShim = SHIMS.find((s) => s.code.includes('const __dt'));
  const needsDt = helpers.has('toDateTime') && !used.includes(dtShim);
  const needsNamed = /\$\(/.test(jsBody) && named && Object.keys(named).length;
  if (used.length === 0 && !needsItems && !needsNamed && !helpers.size) return '';
  const lines = ['// n8n compatibility shims (generated). `source` is the upstream node output.'];
  if (needsNamed) {
    if (Object.values(named).some((s) => s.kind === 'output')) lines.push('const __namedCtx = {{ctx}};');
    const entries = Object.entries(named).map(([name, spec]) => {
      let val;
      if (spec.kind === 'literal') val = JSON.stringify(spec.value);
      else if (spec.kind === 'ctx') val = '{{ctx}}';
      else if (spec.kind === 'step') val = `{{steps.${spec.key}.result}}`;
      else if (spec.kind === 'output') {
        val = `__namedCtx.steps?.[${JSON.stringify(spec.key)}]?.[${JSON.stringify(spec.socket)}]`;
        // Recreate the n8n answer wrappers used by named-node expressions.
        if (spec.llm === 'text') val = `((text) => ({ text, output: text, content: text, response: { text, output_text: text }, message: { content: text }, choices: [{ message: { content: text }, text }] }))(${val})`;
        else if (spec.llm === 'object') val = `((output) => ({ ...output, output }))(${val})`;
      }
      else val = 'source';
      return `${JSON.stringify(name)}: ${val}`;
    });
    lines.push(`const __named = { ${entries.join(', ')} };`);
  }
  if (needsItems) lines.push('const __items = Array.isArray(source) ? source : source == null ? [] : [source];');
  if (needsDt) lines.push(dtShim.code);
  for (const s of used) lines.push(s.code);
  lines.push(...helperPrelude(helpers));
  return lines.join('\n') + '\n';
}

function escapeTemplate(text) {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** Make an n8n expression fragment compile as JS, or fall back to a string literal. */
function safeExprFragment(expr) {
  let e = String(expr).replace(/\.?<([^>\n]+)>/g, (_, id) => `[${JSON.stringify(id.trim())}]`);
  try {
    // eslint-disable-next-line no-new-func
    new Function(`void (${e})`);
    return e;
  } catch {
    return JSON.stringify(`«${String(expr).trim().slice(0, 120)}»`);
  }
}

/**
 * Convert any n8n parameter value to a JavaScript expression string.
 * Strings starting with "=" become live expressions; everything else is a literal.
 */
export function toJs(value) {
  if (value instanceof RawJs) return value.code;
  if (isExpression(value)) {
    const segments = parseExpression(value);
    // An expression may end in a `// comment`; the newline keeps the closing
    // bracket out of the comment.
    const close = (expr) => {
      const fixed = safeExprFragment(expr);
      return /\/\/|\/\*/.test(fixed) ? `${fixed}\n` : fixed;
    };
    // Bare `{{runInput}}` (no `$`, no call) is a Yantra run-context token. Leave the
    // braces in the generated string so the editor substitutes them; do not emit a
    // free JavaScript identifier.
    const isRunInput = (expr) => /^[A-Za-z_][\w]*$/.test(expr);
    if (segments.length === 1 && segments[0].expr !== undefined) {
      return isRunInput(segments[0].expr) ? JSON.stringify(`{{${segments[0].expr}}}`) : `(${close(segments[0].expr)})`;
    }
    if (segments.length === 0) return "''";
    return (
      '`' +
      segments
        .map((s) => {
          if (s.expr === undefined) return escapeTemplate(s.text);
          if (isRunInput(s.expr)) return `{{${s.expr}}}`;
          return '${' + close(s.expr) + '}';
        })
        .join('') +
      '`'
    );
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(toJs).join(', ') + ']';
  const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${toJs(v)}`);
  return '{ ' + entries.join(', ') + ' }';
}

/** Pretty multi-line object literal for generated `return { ... }` blocks. */
export function toJsObject(obj, indent = '  ') {
  const entries = Object.entries(obj);
  if (entries.length === 0) return '{}';
  return '{\n' + entries.map(([k, v]) => `${indent}${JSON.stringify(k)}: ${toJs(v)},`).join('\n') + '\n}';
}

// --- 2. Token mode ----------------------------------------------------------

// `$json.a.b`, `$json["a"].b`, `$json?.a?.b`, `$input.item.json.a`, …
const JSON_PATH_RE =
  /^\$(?:json|input\.item\.json|input\.first\(\)\.json|input\.last\(\)\.json)((?:\??\.(?:[A-Za-z_$][\w$]*)|\?\.\[[^\]]*\]|\[\s*(?:"[^"]*"|'[^']*'|\d+)\s*\])*)$/;
// `$('Node').item.json.a`, `$("Node").first().json.a`, `$('Node').json.a`, `$node["Node"].json.a`
const NODE_PATH_RE =
  /^(?:\$\(\s*(?:'([^']*)'|"([^"]*)")\s*\)\.(?:item\.|first\(\)\.|last\(\)\.)?json|\$node\[\s*(?:'([^']*)'|"([^"]*)")\s*\]\.json)((?:\??\.(?:[A-Za-z_$][\w$]*)|\?\.\[[^\]]*\]|\[\s*(?:"[^"]*"|'[^']*'|\d+)\s*\])*)$/;

function normalisePath(raw) {
  // .a?.b["c"][0]  ->  a.b.c.0
  const parts = [];
  const re = /\??\.([A-Za-z_$][\w$]*)|\?\.\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]|\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]/g;
  for (const m of raw.matchAll(re)) parts.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7]);
  return parts.join('.');
}

/**
 * Classify a single `{{ expr }}` for token mode.
 * Returns { kind: 'self', path } | { kind: 'node', node, path } | { kind: 'complex' }.
 */
export function classifyExpr(expr) {
  const e = expr.trim();
  let m = e.match(JSON_PATH_RE);
  if (m) return { kind: 'self', path: normalisePath(m[1] || '') };
  m = e.match(NODE_PATH_RE);
  if (m) return { kind: 'node', node: m[1] ?? m[2] ?? m[3] ?? m[4], path: normalisePath(m[5] || '') };
  // $ifEmpty(path, default) with a plain path → treat as the path (default applied at run time by the user if missing).
  m = e.match(/^\$ifEmpty\(\s*(\$json(?:\.[A-Za-z_$][\w$]*|\[\s*(?:"[^"]*"|'[^']*'|\d+)\s*\])*)\s*,/);
  if (m) return classifyExpr(m[1]);
  return { kind: 'complex' };
}

/**
 * Convert an n8n string to a Yantra token string, or return null when the
 * expression needs JavaScript. `resolve` maps { kind, node, path } to a token.
 */
export function toTokens(value, resolve) {
  if (!isExpression(value)) return typeof value === 'string' ? value : value == null ? '' : String(value);
  const out = [];
  for (const seg of parseExpression(value)) {
    if (seg.expr === undefined) {
      out.push(seg.text);
      continue;
    }
    const c = classifyExpr(seg.expr);
    if (c.kind === 'complex') return null;
    const token = resolve(c);
    if (token == null) return null;
    out.push(token);
  }
  return out.join('');
}

/** Does this string carry only plain-path expressions (token-expressible)? */
export function isTokenExpressible(value) {
  if (!isExpression(value)) return true;
  return parseExpression(value).every((s) => s.expr === undefined || classifyExpr(s.expr).kind !== 'complex');
}

// --- 3. SQL ------------------------------------------------------------------

/** JavaScript helpers that render values as safe Postgres literals. */
export const SQL_HELPERS =
  "const __sqlStr = (v) => String(v ?? '').replace(/'/g, \"''\");\n" +
  "const __sqlIdent = (v) => { const s = String(v ?? ''); if (!/^[A-Za-z_][A-Za-z0-9_$]*(?:\\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(s)) throw new Error('Refusing unsafe SQL identifier: ' + s); return s; };\n" +
  "const __sqlVal = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\\d+(?:\\.\\d+)?$/.test(v.trim())) ? String(v).trim() : typeof v === 'boolean' ? String(v) : v == null ? 'NULL' : \"'\" + __sqlStr(typeof v === 'object' ? JSON.stringify(v) : v) + \"'\";\n";

/**
 * Turn an n8n SQL expression (`=SELECT ... '{{ $json.x }}' ... {{ $json.id }}`)
 * into JavaScript that builds the query with every interpolated value escaped:
 * inside a quoted literal the value has its quotes doubled; outside one it
 * becomes a number or a quoted literal. Identifiers cannot be interpolated
 * this way, so an expression used as a table or column name still needs a
 * human look (the converter reports that).
 */
export function toSafeSqlJs(value) {
  if (!isExpression(value)) return JSON.stringify(String(value ?? ''));
  let inQuote = false;
  let before = '';
  const parts = [];
  for (const seg of parseExpression(value)) {
    if (seg.expr === undefined) {
      for (const ch of seg.text) if (ch === "'") inQuote = !inQuote;
      parts.push(escapeTemplate(seg.text));
      before += seg.text;
    } else {
      const js = safeExprFragment(seg.expr);
      const ident = !inQuote && /\b(?:from|join|into|update|table|describe)\s+$/i.test(before);
      before += 'x';
      parts.push('${' + (inQuote ? `__sqlStr(${js})` : ident ? `__sqlIdent(${js})` : `__sqlVal(${js})`) + '}');
    }
  }
  return '`' + parts.join('') + '`';
}
