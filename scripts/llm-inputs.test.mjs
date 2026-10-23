import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import { convertWorkflow } from './convert-n8n.mjs';
import { auditLlmInputs } from './lib/llm-inputs.mjs';
import { validateChainSchema } from './lib/llm-chain.mjs';

const make = (name, type, parameters = {}, typeVersion = 1.4) => ({ name, type, parameters, typeVersion, position: [0, 0] });
const langchain = '@n8n/n8n-nodes-langchain.';
const savedParserTemplate = () => JSON.parse(fs.readFileSync(new URL('../openai-and-llms/ai-langchain-output-parser-4.json', import.meta.url), 'utf8'));
function convert(nodes, slug = 'fixture-llm-inputs') {
  const all = [make('Start', 'n8n-nodes-base.manualTrigger'), ...nodes];
  const connections = Object.fromEntries(all.slice(0, -1).map((n, i) => [n.name, { main: [[{ node: all[i + 1].name, type: 'main', index: 0 }]] }]));
  return convertWorkflow({ nodes: all, connections }, { slug, name: 'LLM input regression', category: 'openai-and-llms', categoryLabel: 'OpenAI', sourcePath: 'fixtures/llm-inputs' });
}
const inputNode = () => make('Fields', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'input', value: 'question', type: 'string' }] } }, 3.4);
function builder(wf, label, socket = 'prompt') {
  const chain = wf.nodes.find((n) => n.label === label);
  const edge = wf.edges.find((e) => e.target === chain.nodeId && e.targetInput === socket);
  if (edge) return wf.nodes.find((n) => n.nodeId === edge.source);
  if (chain.inputs?.[socket] === '{{last.transformed}}') {
    const trigger = wf.edges.find((e) => e.target === chain.nodeId && e.targetInput === 'RUN');
    return wf.nodes.find((n) => n.nodeId === trigger?.source);
  }
  const id = /^\{\{llm_(?:prompt|system)_([a-f0-9]{10})\}\}$/.exec(chain.inputs?.[socket])?.[1];
  return wf.nodes.find((n) => n.nodeId === `node_${id}`);
}
function runRaw(n, source, ctx = {}) {
  assert(n, 'expected a prompt builder');
  const code = n.inputs.jsCode.replace(/\{\{\s*ctx\s*\}\}/g, JSON.stringify(ctx));
  return vm.runInNewContext(`(function(source) { ${code} })(payload)`, { payload: source }, { timeout: 1000 });
}
function run(n, source, ctx = {}) {
  const output = runRaw(n, source, ctx);
  return n.inputs.jsCode.includes('const __promptValue =') && typeof output === 'object' ? Object.values(output)[0] : output;
}
function writer(wf, prompt) {
  const edge = wf.edges.find((e) => e.source === prompt.nodeId && e.sourceOutput === 'transformed' && e.targetInput === 'patch');
  const node = wf.nodes.find((n) => n.nodeId === edge?.target);
  assert.equal(node?.type, 'NodeUpdateContext');
  assert(wf.edges.some((e) => e.source === prompt.nodeId && e.sourceOutput === 'onDone' && e.target === node.nodeId && e.targetInput === 'RUN'));
  return node;
}
function resolveInput(value, ctx) {
  const token = /^\{\{([\w$.[\]-]+)\}\}$/.exec(value);
  assert(token, `expected a valid run-context token, got ${value}`);
  return token[1].split('.').reduce((v, key) => v?.[key], ctx);
}
function promptValue(wf, label, payload, ctx = {}, socket = 'prompt') {
  const prompt = builder(wf, label, socket);
  if (prompt) return run(prompt, payload, ctx);
  const chain = wf.nodes.find((n) => n.label === label);
  const trigger = wf.edges.find((e) => e.target === chain.nodeId && e.targetInput === 'RUN');
  const source = wf.nodes.find((n) => n.nodeId === trigger.source);
  const output = source.type === 'NodeTransform' ? 'transformed' : 'text';
  return resolveInput(chain.inputs[socket], { ...ctx, last: { [output]: payload } });
}

test('webpage prompts read last.transformed immediately after their builders', () => {
  const wf = JSON.parse(fs.readFileSync(new URL('../ai-research-and-data/scrape-and-summarize-webpages-with-ai.json', import.meta.url), 'utf8'));
  const html = '<html><title>Example essay</title><a href="essay.html">Essay</a></html>';
  assert(!wf.nodes.some((n) => n.type === 'NodeUpdateContext'));
  const chains = wf.nodes.filter((n) => n.type === 'NodeLlmChain');
  assert.equal(chains.length, 3);
  for (const chain of chains) {
    const prompt = builder(wf, chain.label);
    assert(prompt, `${chain.label} needs a prompt builder`);
    assert(!wf.edges.some((e) => e.target === chain.nodeId && ['prompt', 'system'].includes(e.targetInput)));
    assert.equal(chain.inputs.prompt, '{{last.transformed}}');
    assert(wf.edges.some((e) => e.source === prompt.nodeId && e.sourceOutput === 'onDone' && e.target === chain.nodeId && e.targetInput === 'RUN'));
    assert(wf.edges.some((e) => e.target === prompt.nodeId && e.targetInput === 'source' && e.sourceOutput === 'body'));
    const text = runRaw(prompt, html);
    assert.equal(typeof text, 'string');
    const ctx = { last: { transformed: text } };
    assert.equal(resolveInput(chain.inputs.prompt, ctx), chain.label === 'Summarization Chain' ? html : `HTML page:\n${html}`);
  }
  assert.deepEqual(auditLlmInputs(wf).flatMap((r) => r.problems), []);
});

test('the saved Output Parser 4 template resolves a distinct prompt for each iterating initial context', () => {
  const wf = savedParserTemplate();
  const chain = wf.nodes.find((n) => n.type === 'NodeLlmChain');
  const start = wf.nodes.find((n) => n.type === 'NodeStart');
  assert(!wf.nodes.some((n) => n.type === 'NodeTransform'));
  assert.equal(chain.inputs.prompt, '{{input}}');
  assert(!wf.edges.some((e) => e.target === chain.nodeId && e.targetInput === 'prompt'));
  const trigger = wf.edges.find((e) => e.target === chain.nodeId && e.targetInput === 'RUN');
  assert.equal(trigger.source, start.nodeId);
  assert.equal(trigger.sourceOutput, 'trigger');
  const config = wf.nodes.find((n) => n.type === 'NodeWorkflowConfigs').inputs;
  assert.equal(config.iteratingInitialContexts.length, 3);
  assert.equal(new Set(config.iteratingInitialContexts.map((ctx) => ctx.input)).size, 3);
  for (const ctx of [...config.iteratingInitialContexts, { input: 'Custom question' }]) {
    const prompt = resolveInput(chain.inputs.prompt, ctx);
    assert.equal(typeof prompt, 'string');
    assert.equal(prompt, ctx.input);
  }
  assert.deepEqual(auditLlmInputs(wf).flatMap((r) => r.problems), []);
});

test('the saved Output Parser 4 schema requires five states and three cities per state', () => {
  const wf = savedParserTemplate();
  const validate = validateChainSchema(wf.nodes.find((n) => n.type === 'NodeLlmChain').inputs.schema);
  const result = { states: Array.from({ length: 5 }, (_, i) => ({
    state: `State ${i + 1}`, cities: Array.from({ length: 3 }, (_, j) => ({ name: `City ${j + 1}`, population: 1000 })),
  })) };
  assert(validate(result));
  assert(!validate({}));
  assert(!validate({ states: result.states.slice(0, 1) }));
  const shortCities = structuredClone(result);
  shortCities.states[0].cities.pop();
  assert(!validate(shortCities));
  const missingPopulation = structuredClone(result);
  delete missingPopulation.states[0].cities[0].population;
  assert(!validate(missingPopulation));
});

test('legacy defaults and explicit prompts read input; modern auto mode keeps chatInput', () => {
  for (const [parameters, version, field] of [[{}, 1, 'input'], [{ prompt: '={{ $json.input }}' }, 1.3, 'input'], [{ promptType: 'auto', text: 'unused' }, 1.5, 'chatInput']]) {
    const wf = convert([inputNode(), make('Ask', langchain + 'chainLlm', parameters, version)]);
    assert.equal(promptValue(wf, 'Ask', { [field]: 'expected question' }), 'expected question');
  }
});

test('system and prompt builders receive the same original payload and tolerate lists', () => {
  const wf = convert([inputNode(), make('Ask', langchain + 'chainLlm', {
    promptType: 'define', text: '={{ $json.input }}', messages: { messageValues: [{ message: '=Use {{ $json.tone.toUpperCase() }} tone' }] },
  })]);
  const prompt = builder(wf, 'Ask'), system = builder(wf, 'Ask', 'system');
  const edge = (n) => wf.edges.find((e) => e.target === n.nodeId && e.targetInput === 'source');
  assert.equal(edge(prompt).source, edge(system).source);
  assert.equal(edge(prompt).sourceOutput, 'transformed');
  assert(wf.edges.some((e) => e.source === writer(wf, system).nodeId && e.target === prompt.nodeId && e.targetInput === 'RUN'));
  const payload = [{ input: 'First question', tone: 'brief' }, { input: 'Second question' }];
  assert.equal(run(system, payload), 'Use BRIEF tone');
  assert.equal(run(prompt, payload), 'First question');
  const chain = wf.nodes.find((n) => n.label === 'Ask');
  const ctx = { ...runRaw(system, payload), last: { transformed: runRaw(prompt, payload) } };
  assert.equal(resolveInput(chain.inputs.system, ctx), 'Use BRIEF tone');
  assert.equal(resolveInput(chain.inputs.prompt, ctx), 'First question');
  assert(!wf.edges.some((e) => e.target === chain.nodeId && ['prompt', 'system'].includes(e.targetInput)));
});

test('missing writers for a dynamic system followed by a dynamic prompt are reported', () => {
  const wf = convert([inputNode(), make('Ask', langchain + 'chainLlm', {
    promptType: 'define', text: '={{ $json.input }}', messages: { messageValues: [{ message: '=Use {{ $json.tone }} tone' }] },
  })]);
  const system = builder(wf, 'Ask', 'system');
  wf.edges = wf.edges.filter((e) => e.source !== system.nodeId || e.targetInput !== 'patch');
  assert(auditLlmInputs(wf).some((r) => r.problems.some((p) => p.path === `llm_system_${system.nodeId.slice(5)}`)));
});

test('whole object prompts are JSON text, as required by LLM Chain', () => {
  const wf = convert([inputNode(), make('Ask', langchain + 'chainSummarization')]);
  assert.equal(run(builder(wf, 'Ask'), { input: 'question' }), '{"input":"question"}');
});

test('alternate message collections, edit instructions and classifier content survive conversion', () => {
  const cases = [
    make('Ask', 'n8n-nodes-base.openAi', { resource: 'chat', messages: { messages: [{ role: 'user', content: '={{ $json.input }}' }] } }, 2),
    make('Ask', 'n8n-nodes-base.openAi', { operation: 'edit', input: '={{ $json.input }}', instruction: 'Translate to German' }, 1),
    make('Ask', 'n8n-nodes-base.googleCloudNaturalLanguage', { content: '={{ $json.input }}' }, 1),
  ];
  for (const n of cases) {
    const wf = convert([inputNode(), n]);
    assert.equal(promptValue(wf, 'Ask', { input: 'Hello' }), 'Hello');
    if (n.parameters.operation === 'edit') assert.equal(wf.nodes.find((n) => n.label === 'Ask').inputs.system, 'Translate to German');
  }
});

test('summarization wrappers resolve to the actual text output', () => {
  for (const property of ['response.text', 'response.output_text']) {
    const wf = convert([make('Summary', langchain + 'chainLlm', { promptType: 'define', text: 'Summarize' }), make('Ask', langchain + 'chainLlm', { promptType: 'define', text: `={{ $json.${property} }}` })]);
    assert.equal(promptValue(wf, 'Ask', 'Actual summary'), 'Actual summary');
  }
});

test('named references read runtime display names and output sockets', () => {
  const wf = convert([make('Earlier summary', langchain + 'chainLlm', { promptType: 'define', text: 'Summarize' }), make('Ask', langchain + 'chainLlm', { promptType: 'define', text: "={{ $('Earlier summary').item.json.response.text }}" })]);
  const b = builder(wf, 'Ask');
  assert.equal(run(b, 'unrelated payload', { steps: { 'Earlier summary': { text: 'Remembered summary' } } }), 'Remembered summary');
  assert(!/steps\.llm_/.test(b.inputs.jsCode));
});

test('aggregations expose the names downstream prompts expect', () => {
  const aggregate = make('Aggregate', 'n8n-nodes-base.aggregate', { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: "['What went great?']" }, { fieldToAggregate: 'response.text' }] } });
  const wf = convert([aggregate, make('Ask', langchain + 'chainLlm', { promptType: 'define', text: "={{ $json['What went great?'].join(', ') }} / {{ $json.text.join(', ') }}" })]);
  const out = run(wf.nodes.find((n) => n.label === 'Aggregate'), [{ 'What went great?': 'Talks', response: { text: 'Good' } }]);
  assert.equal(run(builder(wf, 'Ask'), out), 'Talks / Good');
  const sum = convert([make('Concatenate', 'n8n-nodes-base.summarize', { fieldsToSummarize: { values: [{ field: 'text', aggregation: 'concatenate', separateBy: ' ' }] } }), make('Ask', langchain + 'chainLlm', { promptType: 'define', text: '={{ $json.concatenated_text }}' })]);
  const joined = run(sum.nodes.find((n) => n.label === 'Concatenate'), [{ text: 'Hello' }, { text: 'world' }]);
  assert.equal(run(builder(sum, 'Ask'), joined), 'Hello world');
});

test('known missing fields are flagged and unknown API shapes are not guessed', () => {
  const wf = convert([inputNode(), make('Ask', langchain + 'chainLlm', { promptType: 'define', text: '={{ $json.chatInput }}' })]);
  assert.equal(wf.template.tier, 'experimental');
  assert(auditLlmInputs(wf).some((r) => r.problems.some((p) => p.path === '$json.chatInput')));
  const prompt = builder(wf, 'Ask');
  const edge = wf.edges.find((e) => e.target === prompt.nodeId && e.targetInput === 'source');
  const source = wf.nodes.find((n) => n.nodeId === edge.source);
  source.inputs.jsCode = 'return JSON.parse(source);';
  assert.equal(auditLlmInputs(wf).flatMap((r) => r.problems).length, 0);
});

test('the confirmed upstream html/content typo stays fixed on reconversion', () => {
  const expression = convert([inputNode(), make('Basic LLM Chain', langchain + 'chainLlm', { promptType: 'define', text: '=Content: {{ $json.html }}' })], 'perplexity-researcher-to-html-web-page');
  assert.equal(run(builder(expression, 'Basic LLM Chain'), { content: 'Actual article' }), 'Content: Actual article');
});
