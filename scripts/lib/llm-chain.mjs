// Shared migration for saved templates and the n8n converter's final graph.
import crypto from 'node:crypto';
import Ajv from 'ajv';
import { NODE_TYPES } from './yantra-nodes.mjs';
import { CHAT_MODEL_PROVIDERS, legacyChatModel } from './chat-models.mjs';

export const LEGACY_LLM_TYPES = new Set(['NodeCdeGenerateObject', 'NodeCdecliChatCompletion']);
const modelInputs = new Set(['model', 'credential', 'temperature', 'maxTokens']);
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true, addUsedSchema: false });
export function validateChainSchema(schema) {
  if (!schema || schema.type !== 'object') throw new Error('LLMChain structured output requires an object schema');
  return ajv.compile(schema);
}

const scalarTypes = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);
const schemaKeywords = new Set([
  '$id', '$schema', '$ref', '$defs', '$comment', 'definitions', 'type', 'properties', 'patternProperties', 'additionalProperties',
  'items', 'additionalItems', 'contains', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependencies', 'propertyNames',
  'enum', 'const', 'required', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
  'title', 'description', 'default', 'examples', 'readOnly', 'writeOnly', 'contentEncoding', 'contentMediaType',
]);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const looksLikeSchema = (v) => (typeof v === 'string' && scalarTypes.has(v)) ||
  (isObject(v) && Object.keys(v).some((k) => schemaKeywords.has(k)));

function inferSchema(value) {
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferSchema(value[0]) : {} };
  if (isObject(value)) return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inferSchema(v)])) };
  return { type: value === null ? 'null' : typeof value };
}

/** Normalize legacy shorthand/examples for the runtime's strict Ajv parser. */
export function normalizeChainSchema(value) {
  if (typeof value === 'string' && scalarTypes.has(value)) return { type: value };
  if (typeof value === 'boolean') return value;
  if (!isObject(value)) throw new Error('Expected a JSON Schema');
  let schema = structuredClone(value);
  const keys = Object.keys(schema);
  const propertyMap = keys.some((k) => !schemaKeywords.has(k)) && Object.values(schema).every(looksLikeSchema);
  if (propertyMap) schema = { type: 'object', properties: schema };
  else if (keys.length && !keys.some((k) => schemaKeywords.has(k))) schema = inferSchema(schema);
  if (Array.isArray(schema.type)) schema.type = schema.type.map((v) => v === null ? 'null' : v);
  if (schema.type === 'date') { schema.type = 'string'; schema.format = 'date'; }
  // The runtime has no format plugins. These patterns preserve syntax checks;
  // date validity and email deliverability are not implied.
  const patterns = {
    email: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    date: '^\\d{4}-\\d{2}-\\d{2}$',
    'date-time': '^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[Zz]|[+-]\\d{2}:\\d{2})$',
  };
  if (schema.format && patterns[schema.format]) {
    const pattern = patterns[schema.format];
    schema.description = [schema.description, `Format: ${schema.format}.`].filter(Boolean).join(' ');
    if (schema.pattern) (schema.allOf ??= []).push({ type: 'string', pattern });
    else schema.pattern = pattern;
    delete schema.format;
  }
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    if (schema[key]) schema[key] = Object.fromEntries(Object.entries(schema[key]).map(([k, v]) => [k, normalizeChainSchema(v)]));
  }
  for (const key of ['items', 'additionalItems', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else']) {
    if (schema[key] !== undefined) schema[key] = Array.isArray(schema[key]) ? schema[key].map(normalizeChainSchema) : normalizeChainSchema(schema[key]);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (schema[key]) schema[key] = schema[key].map(normalizeChainSchema);
  if (!schema.type && schema.properties) schema.type = 'object';
  return schema;
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

function helper(wf, parent, role, type, label, inputs) {
  const hash = crypto.createHash('sha256').update(`${parent.nodeId}:${role}`).digest('hex').slice(0, 10);
  if (wf.nodes.some((n) => n.nodeId === `node_${hash}`)) throw new Error(`Duplicate helper id ${hash}`);
  const spec = NODE_TYPES[type];
  const position = { x: parent.position.x, y: parent.position.y + parent.size.height + 60 };
  while (wf.nodes.some((n) => position.x < n.position.x + n.size.width + 30 && position.x + spec.size.width + 30 > n.position.x && position.y < n.position.y + n.size.height + 30 && position.y + spec.size.height + 30 > n.position.y)) position.y += 300;
  const node = { nodeId: `node_${hash}`, actorId: `actor_${hash}`, type, label, color: spec.color, position, size: { ...spec.size }, inputs };
  wf.nodes.push(node);
  (wf.template.nodes ??= {})[node.nodeId] = { n8n: wf.template.nodes[parent.nodeId]?.n8n || parent.label, n8nType: 'synthetic', role };
  return node;
}

function edge(wf, source, target, sourceOutput, targetInput) {
  wf.edges.push({ source: source.nodeId, target: target.nodeId, sourceOutput, targetInput, sourceNodeType: source.type, targetNodeType: target.type });
}

function unwrapArray(wf, node) {
  const adapter = helper(wf, node, 'llm-chain-array', 'NodeTransform', `${node.label}: array output`, {
    mode: 'jsCode', jsCode: '// LLMChain validates an object; preserve the original array output.\nreturn source.items;',
  });
  const consumers = new Set();
  for (const e of wf.edges) {
    if (e.source !== node.nodeId || !['object', 'onDone'].includes(e.sourceOutput)) continue;
    consumers.add(e.target);
    e.source = adapter.nodeId;
    e.sourceNodeType = adapter.type;
    if (e.sourceOutput === 'object') e.sourceOutput = 'transformed';
  }
  const oldKey = `steps.obj_${node.nodeId.slice(5)}.result`;
  const newKey = `steps.xf_${adapter.nodeId.slice(5)}.result`;
  for (const n of wf.nodes) if (n.inputs) {
    n.inputs = mapStrings(n.inputs, (s) => s.replace(/\{\{\{?\s*[^{}]+\s*\}\}\}?/g, (token) => {
      token = token.replaceAll(oldKey, newKey);
      return consumers.has(n.nodeId) ? token.replace(/\blast\.object\b/g, 'last.transformed') : token;
    }));
  }
  edge(wf, node, adapter, 'object', 'source');
  edge(wf, node, adapter, 'onDone', 'RUN');
}

/** In-memory, idempotent migration. The caller applies quality metadata. */
export function migrateLlmChains(wf) {
  const nodes = wf.nodes.filter((n) => LEGACY_LLM_TYPES.has(n.type));
  const report = { nodes: nodes.length, text: 0, structured: 0, chatModels: 0, arrays: 0, schemas: 0, modelSetup: 0, unsupported: 0, providers: {} };
  if (!nodes.length) return report;
  const meta = wf.template;
  const hints = meta.conversion.hints ??= [];
  const connectors = new Set(meta.connectors || []);
  for (const node of nodes) {
    const oldType = node.type;
    const inputs = node.inputs ??= {};
    const settings = legacyChatModel(wf, node);
    for (const key of modelInputs) {
      if (key !== 'model' && Object.hasOwn(inputs, key)) settings[key] = inputs[key];
      delete inputs[key];
    }
    if (!settings.model) {
      const cfg = wf.nodes.find((n) => n.type === 'NodeWorkflowConfigs');
      if (!cfg) throw new Error(`${node.label}: Workflow Configs is required for model setup`);
      const key = `llmModel_${node.nodeId.slice(5)}`;
      const context = (cfg.inputs ??= {}).initialContext ??= {};
      if (Object.hasOwn(context, key) || (meta.setupVars || []).some((v) => v.key === key)) throw new Error(`Model setup key collision: ${key}`);
      context[key] = '';
      (meta.setupVars ??= []).push({ key, label: `${settings.provider} model ID for ${node.label} (not recorded by the original conversion)`, type: 'text', usedBy: [node.label] });
      settings.model = `{{${key}}}`;
      report.modelSetup++;
    }
    const modelNode = helper(wf, node, 'chat-model', 'NodeChatModel', `${node.label}: model`, settings);
    report.chatModels++;
    report.providers[settings.provider] = (report.providers[settings.provider] || 0) + 1;
    if (!CHAT_MODEL_PROVIDERS.has(settings.provider)) report.unsupported++;
    connectors.add(settings.provider);
    if (oldType === 'NodeCdecliChatCompletion' && Object.hasOwn(inputs, 'message')) {
      if (Object.hasOwn(inputs, 'prompt')) throw new Error(`${node.label}: both message and prompt are set`);
      inputs.prompt = inputs.message;
      delete inputs.message;
    }
    for (const key of Object.keys(inputs)) if (!NODE_TYPES.NodeLlmChain.inputs[key]) throw new Error(`${node.label}: unsupported legacy input ${key}`);
    for (const e of wf.edges) {
      if (e.target === node.nodeId) {
        if (modelInputs.has(e.targetInput)) {
          e.target = modelNode.nodeId;
          e.targetNodeType = modelNode.type;
          continue;
        }
        e.targetNodeType = 'NodeLlmChain';
        if (oldType === 'NodeCdecliChatCompletion' && e.targetInput === 'message') e.targetInput = 'prompt';
        if (!NODE_TYPES.NodeLlmChain.inputs[e.targetInput]) throw new Error(`${node.label}: unsupported input socket ${e.targetInput}`);
      }
      if (e.source === node.nodeId) {
        e.sourceNodeType = 'NodeLlmChain';
        if (!NODE_TYPES.NodeLlmChain.outputs[e.sourceOutput]) throw new Error(`${node.label}: unsupported output socket ${e.sourceOutput}`);
      }
    }
    node.type = 'NodeLlmChain';
    edge(wf, modelNode, node, 'config', 'llm');
    const fed = (key) => wf.edges.some((e) => e.target === node.nodeId && e.targetInput === key);
    if (!(typeof inputs.prompt === 'string' && inputs.prompt.trim()) && !fed('prompt')) {
      if (!(typeof inputs.system === 'string' && inputs.system.trim()) && !fed('system')) throw new Error(`${node.label}: no prompt or system instructions to migrate`);
      inputs.prompt = 'Follow the system instructions.';
      hints.push(`"${node.label}": added a user prompt to execute the existing system-only instructions because LLMChain requires a non-empty prompt.`);
    }
    if (oldType === 'NodeCdeGenerateObject') {
      inputs.outputMode = 'structured';
      inputs.schemaMode = 'prompt';
      const schema = normalizeChainSchema(inputs.schema);
      if (JSON.stringify(schema) !== JSON.stringify(inputs.schema)) {
        report.schemas++;
        hints.push(`"${node.label}": normalized the legacy output schema for LLMChain's strict parser (shorthand/examples become JSON Schema; email/date formats use syntax patterns). Review the schema before running.`);
      }
      inputs.schema = schema;
      if (schema.type === 'array') {
        inputs.schema = { type: 'object', properties: { items: schema }, required: ['items'], additionalProperties: false };
        unwrapArray(wf, node);
        report.arrays++;
      }
      validateChainSchema(node.inputs.schema);
      report.structured++;
    } else {
      inputs.outputMode = 'text';
      report.text++;
    }
  }
  meta.connectors = [...connectors].sort();
  meta.nodeTypes = [...new Set(wf.nodes.map((n) => n.type))].sort();
  if (meta.comparison) meta.comparison.yantraSteps += report.chatModels + report.arrays;
  for (const item of meta.conversion.approximate || []) if (LEGACY_LLM_TYPES.has(item.action)) item.action = 'NodeLlmChain';
  meta.conversion.hints = hints.map((s) => s.replace('platform LLM (no API key)', 'LLMChain with a Chat Model and provider connector credential'));
  return report;
}
