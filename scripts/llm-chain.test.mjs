#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { migrateLlmChains, normalizeChainSchema, validateChainSchema } from './lib/llm-chain.mjs';
import { legacyChatModel } from './lib/chat-models.mjs';
import { evaluate } from './lib/quality.mjs';

const node = (suffix, type, inputs = {}) => ({
  nodeId: `node_${suffix}`, actorId: `actor_${suffix}`, type, label: suffix,
  inputs, position: { x: 100, y: 100 }, size: { width: 320, height: 260 }, color: '#8B5CF6',
});
const edge = (source, target, sourceOutput, targetInput) => ({
  source: source.nodeId, target: target.nodeId, sourceOutput, targetInput,
  sourceNodeType: source.type, targetNodeType: target.type,
});
const workflow = (nodes, edges = [], folded = []) => ({
  nodes: [...nodes, node('config1', 'NodeWorkflowConfigs', { initialContext: {} })], edges,
  template: { connectors: [], nodeTypes: [...new Set(nodes.map((n) => n.type))],
    comparison: { yantraSteps: nodes.length }, conversion: { hints: [], approximate: [], folded }, nodes: {} },
});
const modelFor = (wf, llm) => wf.nodes.find((n) => n.nodeId === wf.edges.find((e) => e.target === llm.nodeId && e.targetInput === 'llm')?.source);
const run = (n, source) => vm.runInNewContext(`(function(source) { ${n.inputs.jsCode} })`)(source);

test('moves settings into a connected Chat Model and preserves prompt/trigger wiring and agent behavior', () => {
  const text = node('text001', 'NodeCdecliChatCompletion', { message: 'Hello {{name}}', system: 'Be brief', model: 'gpt-4o', temperature: 0, maxTokens: 100, credential: 'my-openai' });
  const wired = node('wired01', 'NodeCdecliChatCompletion');
  const agent = node('agent01', 'NodeCdecliAgent', { message: 'Use tools', sessionId: 'session' });
  const builder = node('build01', 'NodeTransform', { mode: 'jsCode', jsCode: 'return source.question;' });
  const end = node('end0001', 'NodeEnd');
  const wf = workflow([text, wired, agent, builder, end], [edge(builder, wired, 'transformed', 'message'), edge(builder, wired, 'onDone', 'RUN'), edge(text, end, 'text', 'result')]);
  const original = structuredClone(wf);
  assert.equal(migrateLlmChains(wf).chatModels, 2);
  assert.deepEqual(text.inputs, { prompt: 'Hello {{name}}', system: 'Be brief', outputMode: 'text' });
  assert.deepEqual(modelFor(wf, text).inputs, { provider: 'openai', model: 'gpt-4o', temperature: 0, maxTokens: 100, credential: 'my-openai' });
  assert.equal(wf.edges[0].targetInput, 'prompt');
  assert.equal(wf.edges[0].targetNodeType, 'NodeLlmChain');
  assert.equal(wf.edges[1].sourceOutput, 'onDone');
  assert.deepEqual(agent, original.nodes[2]);
  for (const n of original.nodes) assert(wf.nodes.some((x) => x.nodeId === n.nodeId && x.actorId === n.actorId));
  assert.deepEqual(wf.template.connectors, ['openai']);
  const once = structuredClone(wf);
  assert.equal(migrateLlmChains(wf).nodes, 0);
  assert.deepEqual(wf, once);
});

test('distinguishes direct Gemini, routed Gemini, Ollama, and compatible OpenAI helper models', () => {
  for (const [type, model, provider] of [
    ['lmChatGoogleGemini', 'models/gemini-test', 'gemini'],
    ['lmChatOpenRouter', 'google/gemini-test', 'openrouter'],
    ['lmChatOllama', 'mistral-nemo:latest', 'ollama'],
    ['lmChatOpenAi', 'deepseek-chat', 'deepseek'],
    ['lmChatOpenAi', 'deepseek/deepseek-r1:free', 'openrouter'],
  ]) {
    const llm = node('text001', 'NodeCdecliChatCompletion', { message: 'Hello', model });
    const wf = workflow([llm], [], [{ node: 'Model', type: `@n8n/n8n-nodes-langchain.${type}`, into: llm.label, model }]);
    migrateLlmChains(wf);
    assert.equal(modelFor(wf, llm).inputs.provider, provider);
    assert.equal(modelFor(wf, llm).inputs.model, model);
    assert.equal(evaluate(wf).tier, 'ready');
  }
});

test('recovers HTTP models from the saved conversion notes without matching another node', () => {
  const llm = node('ask0001', 'NodeCdecliChatCompletion', { message: 'Hello' });
  const wf = workflow([llm]);
  wf.template.conversion.hints = [
    '"Other" called the OpenAI API (gpt-4o) over HTTP; it now runs on the platform LLM (no API key).',
    '"ask0001" called the OpenRouter API (meta-llama/llama-3.1-70b-instruct:free) over HTTP; it now runs on the platform LLM (no API key).',
  ];
  migrateLlmChains(wf);
  assert.deepEqual(modelFor(wf, llm).inputs, { provider: 'openrouter', model: 'meta-llama/llama-3.1-70b-instruct:free' });
  assert(!wf.template.conversion.hints.some((h) => h.includes('no API key')));
});

test('missing non-OpenAI model IDs become declared setup values and keep their provider', () => {
  const llm = node('missing1', 'NodeCdecliChatCompletion', { message: 'Hello' });
  const wf = workflow([llm], [], [{ node: 'Gemini', type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', into: llm.label }]);
  assert.equal(migrateLlmChains(wf).modelSetup, 1);
  const model = modelFor(wf, llm);
  assert.equal(model.inputs.provider, 'gemini');
  const key = wf.template.setupVars[0].key;
  assert.equal(model.inputs.model, `{{${key}}}`);
  assert.equal(wf.nodes.find((n) => n.type === 'NodeWorkflowConfigs').inputs.initialContext[key], '');
  assert(evaluate(wf).setup.some((s) => s.startsWith(`Setup value ${key}:`)));
  assert.equal(evaluate(wf).tier, 'ready');
});

test('unsupported providers keep their exact model and have a removable setup blocker', () => {
  const llm = node('model01', 'NodeCdecliChatCompletion', { message: 'Hello', model: 'mistral-small-2402' });
  const wf = workflow([llm]);
  assert.equal(migrateLlmChains(wf).unsupported, 1);
  const model = modelFor(wf, llm);
  assert.equal(model.inputs.model, 'mistral-small-2402');
  assert.equal(model.inputs.provider, 'mistral');
  assert.equal(evaluate(wf).tier, 'experimental');
  assert(evaluate(wf).setup.some((s) => s.includes('add its adapter')));
  model.inputs.provider = 'openrouter';
  model.inputs.model = 'mistralai/a-model-chosen-by-user';
  assert.equal(evaluate(wf).tier, 'ready');
});

test('retired AI/ML API and v0 providers are flagged without replacing their models', () => {
  for (const provider of ['ai-ml-api', 'v0']) {
    const llm = node('model01', 'NodeCdecliChatCompletion', { message: 'Hello', model: 'preserved-model-id' });
    const wf = workflow([llm]);
    wf.template.nodes[llm.nodeId] = { llmProvider: provider };
    assert.equal(migrateLlmChains(wf).unsupported, 1);
    assert.deepEqual(modelFor(wf, llm).inputs, { provider, model: 'preserved-model-id' });
    assert.equal(evaluate(wf).tier, 'experimental');
    assert(evaluate(wf).blockers.some((b) => b.detail.includes(`Chat Model provider ${provider} is not supported`)));
  }
});

test('structured objects keep object edges; the strict schema still rejects invalid data', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };
  const structured = node('object1', 'NodeCdeGenerateObject', { prompt: 'Extract name', schema, model: 'gpt-4o-mini' });
  const end = node('end0001', 'NodeEnd');
  const wf = workflow([structured, end], [edge(structured, end, 'object', 'result')]);
  migrateLlmChains(wf);
  assert.deepEqual(structured.inputs.schema, schema);
  assert.equal(structured.inputs.outputMode, 'structured');
  assert.equal(structured.inputs.schemaMode, 'prompt');
  assert.equal(wf.edges[0].sourceOutput, 'object');
  const validate = validateChainSchema(structured.inputs.schema);
  assert(validate({ name: 'Ada' }));
  assert(!validate({ name: 42 }));
});

test('array adapters preserve downstream data, completion order and named references', () => {
  const array = node('array01', 'NodeCdeGenerateObject', { prompt: 'List names', schema: { type: 'array', items: { type: 'string' } } });
  const consumer = node('next001', 'NodeTransform', { mode: 'jsCode', jsCode: 'return source;', source: '{{last.object.0}} / {{steps.obj_array01.result.0}}' });
  const wf = workflow([array, consumer], [edge(array, consumer, 'object', 'source'), edge(array, consumer, 'onDone', 'RUN')]);
  assert.equal(migrateLlmChains(wf).arrays, 1);
  const adapter = wf.nodes.at(-1);
  const validate = validateChainSchema(array.inputs.schema);
  assert(validate({ items: ['Ada', 'Grace'] }));
  assert(!validate({ items: [42] }));
  assert.deepEqual(run(adapter, { items: ['Ada', 'Grace'] }), ['Ada', 'Grace']);
  assert(wf.edges.some((e) => e.source === adapter.nodeId && e.target === consumer.nodeId && e.sourceOutput === 'onDone'));
  assert(wf.edges.some((e) => e.source === array.nodeId && e.target === adapter.nodeId && e.targetInput === 'RUN'));
  assert.equal(consumer.inputs.source, `{{last.transformed.0}} / {{steps.xf_${adapter.nodeId.slice(5)}.result.0}}`);
  const once = structuredClone(wf);
  migrateLlmChains(wf);
  assert.deepEqual(wf, once);
});

test('legacy shorthand and format normalization retains constraints and nullable values', () => {
  const schema = normalizeChainSchema({
    title: 'string', date: { type: 'date' }, email: { type: 'string', format: 'email' },
    timestamp: { type: 'string', format: 'date-time' }, optional: { type: ['string', null], enum: ['yes', null] },
  });
  const validate = validateChainSchema(schema);
  assert(validate({ title: 'Hello', date: '2026-10-02', email: 'a@example.org', timestamp: '2026-10-02T12:00:00Z', optional: null }));
  assert(!validate({ email: 'invalid' }));
  assert(!validate({ optional: 1 }));
  assert.deepEqual(schema.properties.optional.enum, ['yes', null]);
  const sample = normalizeChainSchema({ search_intent: true, search_params: [{ type: 'search', value: 'yes' }] });
  assert(validateChainSchema(sample)({ search_intent: false, search_params: [{ type: 'keyword', value: 'shoes' }] }));
  const constrained = { type: 'object', properties: { number: { type: 'number', allOf: [{ minimum: 0 }, { maximum: 10 }] } } };
  assert.deepEqual(normalizeChainSchema(constrained), constrained);
  assert(!validateChainSchema(constrained)({ number: -1 }));
});

test('system-only instructions receive the nonempty user prompt required by the runtime', () => {
  const llm = node('system1', 'NodeCdecliChatCompletion', { message: '', system: 'Write a follow up' });
  migrateLlmChains(workflow([llm]));
  assert.equal(llm.inputs.system, 'Write a follow up');
  assert.equal(llm.inputs.prompt, 'Follow the system instructions.');
  assert.throws(() => migrateLlmChains(workflow([node('empty01', 'NodeCdecliChatCompletion', { message: '' })])), /no prompt/);
});

test('unsupported session, streaming and ambiguous providers fail before files are written', () => {
  assert.throws(() => migrateLlmChains(workflow([node('text001', 'NodeCdecliChatCompletion', { message: 'Hello', sessionId: 'keep-me' })])), /sessionId/);
  const text = node('text001', 'NodeCdecliChatCompletion', { message: 'Hello' });
  const end = node('end0001', 'NodeEnd');
  assert.throws(() => migrateLlmChains(workflow([text, end], [edge(text, end, 'delta', 'result')])), /delta/);
  const wf = workflow([text], [], ['lmChatOpenAi', 'lmChatGoogleGemini'].map((type) => ({ type: `langchain.${type}`, into: text.label })));
  assert.throws(() => legacyChatModel(wf, text), /multiple provider helpers/);
});
