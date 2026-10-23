#!/usr/bin/env node
/** Unit tests for lib/quality.mjs (tiers, blockers, setup) and lib/catalog-fs.mjs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, scanLiterals } from './lib/quality.mjs';
import { ROOT, BLOCKERS, TIERS, STATUSES, PLACEHOLDER_RE, PENDING_PUBLISH, listTemplates, statusForTier, compareVersions, patchPending } from './lib/catalog-fs.mjs';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`fail ${name}: ${e.message}`);
  }
}

const catalog = {
  connectors: {
    slack: { version: '1', actions: { SLACK_CHAT_POST_MESSAGE: { title: 'Post', params: ['*channel', 'text'] }, SLACK_SEARCH_MESSAGES: { title: 'Search', params: ['*query'], unimplemented: true }, SLACK_ARCHIVE: { title: 'Archive', params: [], unimplemented: true } } },
    supabase: { version: '1', actions: { SUPABASE_INSERT_ROW: { title: 'Insert row', params: ['ref', '*table', '*fields'] } } },
  },
};

let seq = 0;
function node(type, inputs = {}, n8n) {
  const h = String(++seq).padStart(8, '0');
  return { nodeId: `node_${h}`, actorId: `actor_${h}`, type, label: type === 'NodeCdeConnector' ? `${inputs.connectorName}/${inputs.action}` : n8n || type, color: '#000', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, inputs, _n8n: n8n };
}
function wf(nodes, extra = {}) {
  const all = [node('NodeStart'), ...nodes, node('NodeWorkflowConfigs', { projectId: '', environmentTagId: '', ...(extra.seeds ? { initialContext: extra.seeds } : {}) })];
  const meta = Object.fromEntries(all.filter((n) => n._n8n).map((n) => [n.nodeId, { n8n: n._n8n, ...(n._auth ? { auth: n._auth } : {}) }]));
  for (const n of all) delete n._n8n;
  return {
    name: 't',
    workflowSlug: 't',
    description: '',
    isPublic: true,
    nodes: all,
    edges: extra.edges || [],
    template: { category: 'x', connectors: extra.connectors || [], setupVars: extra.setupVars, setupSecrets: extra.setupSecrets, activation: extra.activation, nodes: meta, conversion: { approximate: [], unmapped: [], removedEdges: [], triggers: [], ...(extra.conversion || {}) } },
  };
}
const codes = (r) => r.blockers.map((b) => b.code);

check('clean template is ready and lists its credentials', () => {
  const r = evaluate(wf([node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_CHAT_POST_MESSAGE', params: { channel: '{{channel}}', text: 'hi' } }, 'Post')], { connectors: ['slack'], seeds: { channel: '' } }), { catalog });
  assert.equal(r.tier, 'ready');
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.setup, ['Connect the slack connector (credential).', 'Provide run inputs: channel.']);
});

check('missing required param without an incoming edge', () => {
  const r = evaluate(wf([node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_CHAT_POST_MESSAGE', params: { text: 'hi' } }, 'Post')]), { catalog });
  assert.deepEqual(codes(r), ['missing-required-param']);
  // A value the converter could not declare as setup means the step does not run as shipped.
  assert.equal(r.tier, 'experimental');
  assert.match(r.setup[0], /set channel on slack\/SLACK_CHAT_POST_MESSAGE/);
});

check('required param supplied by a params builder is fine', () => {
  const builder = node('NodeTransform', { mode: 'jsCode', jsCode: 'return {\n  "channel": `#${source.c}`,\n};' }, 'Params');
  const c = node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_CHAT_POST_MESSAGE' }, 'Post');
  const e = [{ source: builder.nodeId, target: c.nodeId, sourceOutput: 'transformed', targetInput: 'params', sourceNodeType: 'NodeTransform', targetNodeType: 'NodeCdeConnector' }];
  assert.deepEqual(codes(evaluate(wf([builder, c], { edges: e }), { catalog })), []);
});

check('supabase row actions need the project ref', () => {
  const r = evaluate(wf([node('NodeCdeConnector', { connectorName: 'supabase', action: 'SUPABASE_INSERT_ROW', params: { table: 't', fields: { a: 1 } } }, 'Insert')]), { catalog });
  assert.match(r.blockers[0].detail, /needs ref/);
});

check('patched action waiting for publish is experimental with action-pending-publish', () => {
  // Uses its own pending entry so the test does not depend on what data/pending-actions.json holds today.
  const key = 'slack/SLACK_SEARCH_MESSAGES';
  const had = Object.prototype.hasOwnProperty.call(PENDING_PUBLISH, key);
  const prev = PENDING_PUBLISH[key];
  PENDING_PUBLISH[key] = 'slack search.messages patch';
  try {
  const r = evaluate(wf([node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_SEARCH_MESSAGES', params: { query: 'x' } }, 'Search')]), { catalog });
  assert.deepEqual(codes(r), ['action-pending-publish']);
  assert.equal(r.tier, 'experimental');
  assert.equal(r.status, 'needs-setup');
  assert.match(r.blockers[0].detail, /slack search.messages patch/);
  // Once the registry publishes it (catalog refresh), the same template is ready.
  const published = { connectors: { ...catalog.connectors, slack: { ...catalog.connectors.slack, actions: { ...catalog.connectors.slack.actions, SLACK_SEARCH_MESSAGES: { title: 'Search', params: ['*query'] } } } } };
  delete PENDING_PUBLISH[key];
  assert.equal(evaluate(wf([node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_SEARCH_MESSAGES', params: { query: 'x' } }, 'Search')]), { catalog: published }).tier, 'ready');
  } finally {
    if (had) PENDING_PUBLISH[key] = prev; else delete PENDING_PUBLISH[key];
  }
});

// A published action a patch extends: its new params are pending, the old ones are not.
const fileCatalog = {
  connectors: {
    telegram: { version: '12.1.8', actions: { TELEGRAM_SEND_DOCUMENT: { title: 'Send Document', params: ['*chat_id', 'document', 'document_base64', 'document_file_url', 'document_filename', 'caption'], pendingParams: ['document_base64', 'document_file_url', 'document_filename'] } } },
    'yantra-storage': { version: '1.4.1', actions: { YANTRA_STORAGE_HTTP_SEND: { title: 'Send HTTP request (multipart / form / raw / binary)', params: ['*url', 'method', 'headers', 'bodyType', 'files'] } } },
  },
};

check('a param a patch adds is action-pending-publish; the published params are not', () => {
  const key = 'telegram/TELEGRAM_SEND_DOCUMENT';
  const had = Object.prototype.hasOwnProperty.call(PENDING_PUBLISH, key);
  const prev = PENDING_PUBLISH[key];
  PENDING_PUBLISH[key] = 'telegram file uploads patch (12.1.8)';
  try {
    const byUrl = evaluate(wf([node('NodeCdeConnector', { connectorName: 'telegram', action: 'TELEGRAM_SEND_DOCUMENT', params: { chat_id: '{{chat}}', document: 'https://x.test/a.pdf' } }, 'Send')]), { catalog: fileCatalog });
    assert.equal(byUrl.tier, 'ready');
    const byBytes = evaluate(wf([node('NodeCdeConnector', { connectorName: 'telegram', action: 'TELEGRAM_SEND_DOCUMENT', params: { chat_id: '{{chat}}', document_base64: '{{last.result.b64}}' } }, 'Send')]), { catalog: fileCatalog });
    assert.deepEqual(codes(byBytes), ['action-pending-publish']);
    assert.match(byBytes.blockers[0].detail, /document_base64 waits for the telegram file uploads patch \(12\.1\.8\)/);
    // The same through a params builder.
    const builder = node('NodeTransform', { mode: 'jsCode', jsCode: 'return Object.assign({ "chat_id": 1 }, { "document_base64": source.b64, "document_filename": "a.pdf" });' }, 'Params');
    const c = node('NodeCdeConnector', { connectorName: 'telegram', action: 'TELEGRAM_SEND_DOCUMENT' }, 'Send');
    const e = [{ source: builder.nodeId, target: c.nodeId, sourceOutput: 'transformed', targetInput: 'params', sourceNodeType: 'NodeTransform', targetNodeType: 'NodeCdeConnector' }];
    assert.deepEqual(codes(evaluate(wf([builder, c], { edges: e }), { catalog: fileCatalog })), ['action-pending-publish']);
    // Once the registry ships the patch the catalog drops pendingParams and the template is ready.
    const shipped = JSON.parse(JSON.stringify(fileCatalog));
    delete shipped.connectors.telegram.actions.TELEGRAM_SEND_DOCUMENT.pendingParams;
    assert.equal(evaluate(wf([node('NodeCdeConnector', { connectorName: 'telegram', action: 'TELEGRAM_SEND_DOCUMENT', params: { chat_id: '{{chat}}', document_base64: '{{b}}' } }, 'Send')]), { catalog: shipped }).tier, 'ready');
  } finally {
    if (had) PENDING_PUBLISH[key] = prev; else delete PENDING_PUBLISH[key];
  }
});

check('a file action with none of its file params is missing-required-param', () => {
  const r = evaluate(wf([node('NodeCdeConnector', { connectorName: 'telegram', action: 'TELEGRAM_SEND_DOCUMENT', params: { chat_id: '{{chat}}' } }, 'Send')]), { catalog: fileCatalog });
  assert.deepEqual(codes(r), ['missing-required-param']);
  assert.match(r.blockers[0].detail, /needs document \| document_base64 \| document_file_url/);
});

check('yantra-storage HTTP_SEND to an authenticated API needs the credential header', () => {
  const bare = evaluate(wf([node('NodeCdeConnector', { connectorName: 'yantra-storage', action: 'YANTRA_STORAGE_HTTP_SEND', params: { url: 'https://api.openai.com/v1/files', bodyType: 'multipart' } }, 'Upload')]), { catalog: fileCatalog });
  assert.deepEqual(codes(bare), ['http-auth-missing']);
  const authed = evaluate(wf([node('NodeCdeConnector', { connectorName: 'yantra-storage', action: 'YANTRA_STORAGE_HTTP_SEND', params: { url: 'https://api.openai.com/v1/files', headers: { Authorization: 'Bearer {{openaiApiKey}}' } } }, 'Upload')], { seeds: { openaiApiKey: { $workflowSecret: 'OPENAI_API_KEY' } } }), { catalog: fileCatalog });
  assert.equal(authed.tier, 'ready');
  const literal = evaluate(wf([node('NodeCdeConnector', { connectorName: 'yantra-storage', action: 'YANTRA_STORAGE_HTTP_SEND', params: { url: 'https://api.openai.com/v1/files', headers: { Authorization: 'Bearer sk-live-abcdef1234567890' } } }, 'Upload')]), { catalog: fileCatalog });
  assert.ok(codes(literal).includes('secret-as-input'));
});

check('an approximation reason is part of the blocker', () => {
  const r = evaluate(wf([], { conversion: { approximate: [{ node: 'Upload', n8n: 'httpRequest.multipart-form-data', action: 'yantra-storage/YANTRA_STORAGE_HTTP_SEND', reason: 'the request calls the private host gotenberg' }] } }), { catalog });
  assert.deepEqual(codes(r), ['hard-approximation']);
  assert.equal(r.blockers[0].detail, 'httpRequest.multipart-form-data -> yantra-storage/YANTRA_STORAGE_HTTP_SEND: the request calls the private host gotenberg');
  assert.match(r.setup[0], /private host gotenberg; review it/);
});

check('a patch stays pending until the lock pins a newer connector version', () => {
  assert.equal(compareVersions('12.1.10', '12.1.8'), 1);
  assert.equal(compareVersions('1.4.1', '1.4.1'), 0);
  assert.equal(compareVersions('1.0.8', '1.0.10'), -1);
  const def = { patchedFrom: '12.1.8' };
  assert.equal(patchPending(def, '12.1.8'), true);
  assert.equal(patchPending(def, '12.1.7'), true);
  assert.equal(patchPending(def, undefined), true);
  assert.equal(patchPending(def, '12.1.9'), false);
  assert.equal(patchPending({}, '99.0.0'), true);
});

check('unpublished action with no pending patch is unimplemented-action', () => {
  const r = evaluate(wf([node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_ARCHIVE', params: {} }, 'Archive')]), { catalog });
  assert.deepEqual(codes(r), ['unimplemented-action']);
  assert.equal(r.tier, 'experimental');
});

check('declared setup values and workflow secrets make a template ready', () => {
  const post = node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_CHAT_POST_MESSAGE', params: { channel: '{{slackChannel}}', text: 'hi' } }, 'Post');
  const http = node('NodeHttpRequest', { method: 'POST', url: 'https://api.openai.com/v1/embeddings', headers: { Authorization: 'Bearer {{openaiApiKey}}' } }, 'Embed');
  const r = evaluate(
    wf([post, http], {
      connectors: ['slack'],
      seeds: { chatInput: '', slackChannel: '', openaiApiKey: { $workflowSecret: 'OPENAI_API_KEY' } },
      setupVars: [{ key: 'slackChannel', label: 'Slack channel', type: 'channel', example: '#general', usedBy: ['Post'] }],
      setupSecrets: [{ key: 'OPENAI_API_KEY', label: 'OpenAI API key', host: 'api.openai.com', headerFormat: 'Authorization: Bearer <secret>', contextKey: 'openaiApiKey', usedBy: ['Embed'] }],
      activation: 'cdecli cron activate t',
    }),
    { catalog },
  );
  assert.equal(r.tier, 'ready');
  assert.deepEqual(r.blockers, []);
  assert.ok(r.setup.some((x) => /^Setup value slackChannel: Slack channel \(for example #general\)/.test(x)));
  assert.ok(r.setup.some((x) => /^Workflow secret OPENAI_API_KEY: .*Secrets panel.*never paste it in chat/.test(x)));
  assert.ok(r.setup.includes('After import, start the schedule: cdecli cron activate t.'));
  // Setup values and secret references are not offered as run inputs.
  assert.ok(r.setup.includes('Provide run inputs: chatInput.'));
});

check('a setup value must be in initialContext and never hold the original literal', () => {
  const r = evaluate(wf([], { seeds: { spreadsheetId: '1D6tfsAK81ZE6VA0-sd_syuyI_rloNYjgWOhwgszPIZw' }, setupVars: [{ key: 'spreadsheetId', label: 'Spreadsheet', type: 'id', usedBy: [] }, { key: 'gone', label: 'Gone', type: 'text', usedBy: [] }] }), { catalog });
  assert.deepEqual(codes(r).sort(), ['missing-required-param', 'upstream-literal-id']);
  assert.equal(r.tier, 'experimental');
});

check('webhook trigger registration is setup, not a blocker', () => {
  const trig = node('NodeCdeWebhookTrigger', { connector: 'googlesuper', triggerSlug: 'GOOGLESUPER_NEW_MESSAGE', webhookEndpointId: '', connectedAccountId: '' }, 'Gmail Trigger');
  const r = evaluate(wf([trig]), { catalog });
  assert.deepEqual(codes(r), ['webhook-registration']);
  assert.equal(r.tier, 'ready');
  assert.match(r.setup[0], /cdecli webhook endpoint create -c googlesuper/);
});

check('http to an authenticated API without a credential', () => {
  const h = node('NodeHttpRequest', { method: 'GET', url: 'https://api.github.com/repos/a/b' }, 'Fetch');
  assert.deepEqual(codes(evaluate(wf([h]), { catalog })), ['http-auth-missing']);
  const ok = node('NodeHttpRequest', { method: 'GET', url: 'https://api.github.com/repos/a/b', headers: { Authorization: 'Bearer {{token}}' } }, 'Fetch');
  assert.deepEqual(codes(evaluate(wf([ok]), { catalog })), []);
  const pub = node('NodeHttpRequest', { method: 'GET', url: 'https://httpbin.org/get' }, 'Fetch');
  assert.deepEqual(codes(evaluate(wf([pub]), { catalog })), []);
});

check('placeholders, upstream ids and personal emails', () => {
  const r = evaluate(
    wf([
      node('NodeHttpRequest', { method: 'GET', url: 'https://example.org/?q=YOUR_API_KEY' }, 'A'),
      node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_CHAT_POST_MESSAGE', params: { channel: 'C0123456789', text: 'mail jane.doe@acme-corp.io or test@example.com or no-reply@google.com' } }, 'B'),
      node('NodeTransform', { mode: 'jsCode', jsCode: "const sheet = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit';\nreturn source;" }, 'C'),
    ]),
    { catalog },
  );
  assert.deepEqual([...new Set(codes(r))].sort(), ['personal-email', 'placeholder', 'upstream-literal-id']);
  assert.equal(r.blockers.filter((b) => b.code === 'personal-email').length, 1, 'only the real-looking address counts');
  assert.equal(r.blockers.filter((b) => b.code === 'upstream-literal-id').length, 2);
});

check('$env reads and empty secrets in config steps', () => {
  const r = evaluate(
    wf([
      node('NodeTransform', { mode: 'jsCode', jsCode: 'const $env = {};\nreturn { "x-api-key": ($env.ANTHROPIC_API_KEY), to: $env.LINE_USER_ID };' }, 'Ask'),
      node('NodeTransform', { mode: 'jsCode', jsCode: 'const out = {};\n  out["api_key"] = "";\n  out["base"] = "https://api.your-company.example";\nreturn out;' }, 'Config'),
      node('NodeTransform', { mode: 'jsCode', jsCode: 'return { apiKey: "jf_live_YOUR_API_KEY_HERE" };' }, 'Key'),
    ]),
    { catalog },
  );
  assert.deepEqual(r.blockers.map((b) => `${b.code}:${b.node}`), ['missing-required-param:Ask', 'placeholder:Config', 'placeholder:Key', 'secret-as-input:Ask', 'secret-as-input:Config']);
});

check('literal ids in params steps, gid ranges, placeholder recipients', () => {
  const r = evaluate(
    wf([
      node('NodeTransform', { mode: 'jsCode', jsCode: 'return {\n  "spreadsheetId": "1D6tfsAK81ZE6VA0-sd_syuyI_rloNYjgWOhwgszPIZw",\n};' }, 'Params'),
      node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_CHAT_POST_MESSAGE', params: { channel: '{{c}}', text: 'x', range: 'gid=0' } }, 'Post'),
      node('NodeCdeConnector', { connectorName: 'slack', action: 'SLACK_CHAT_POST_MESSAGE', params: { channel: '{{c}}', text: 'Write to me at info@example.com', recipient_email: 'to@domain.com' } }, 'Mail'),
    ]),
    { catalog },
  );
  assert.deepEqual(r.blockers.map((b) => `${b.code}:${b.node}`), ['missing-required-param:Post', 'placeholder:Mail', 'upstream-literal-id:Params']);
});

check('secret run inputs', () => {
  const r = evaluate(wf([], { seeds: { chatInput: '', telegramBotToken: '' } }), { catalog });
  assert.deepEqual(codes(r), ['secret-as-input']);
  assert.ok(r.setup.includes('Provide run inputs: chatInput.'), 'the secret is not offered as a plain run input');
  // A workflow secret reference is fine.
  assert.deepEqual(codes(evaluate(wf([], { seeds: { chatInput: '', telegramBotToken: { $workflowSecret: 'TELEGRAM_BOT_TOKEN' } } }), { catalog })), []);
});

check('$env rebuilt from the initialContext is not a blocker', () => {
  const code = '// n8n $env values come from the Workflow Configs initialContext (setup values and workflow secrets).\nconst __envCtx = {{ctx}};\nconst $env = { "LINE_USER_ID": __envCtx["lineUserId"], "ANTHROPIC_API_KEY": "{{anthropicApiKey}}" };\nreturn { to: $env.LINE_USER_ID, key: $env.ANTHROPIC_API_KEY, host: $env.N8N_HOST };';
  const r = evaluate(wf([node('NodeTransform', { mode: 'jsCode', jsCode: code }, 'Ask')]), { catalog });
  // N8N_HOST is not in the shim, so it is still reported; the placeholder scanner ignores env names.
  assert.deepEqual(r.blockers.map((b) => `${b.code}:${b.detail}`), ['missing-required-param:$env.N8N_HOST']);
});

check('scanLiterals: offsets, field names, token spans and comments', () => {
  const s = 'Bearer YOUR_API_KEY for jane@acme-corp.io';
  const f = scanLiterals('headers.Authorization', s);
  assert.deepEqual(f.map((x) => [x.code, x.text, s.slice(x.start, x.start + x.text.length)]), [['placeholder', 'YOUR_API_KEY', 'YOUR_API_KEY'], ['personal-email', 'jane@acme-corp.io', 'jane@acme-corp.io']]);
  assert.deepEqual(scanLiterals('jsCode', 'const a = $json.your_email; const b = o["your_email"]; const c = { "your_email": 1 };'), []);
  assert.deepEqual(scanLiterals('jsCode', '// YOUR_API_KEY in a comment\nreturn "{{yourApiKey}}";'), []);
  assert.deepEqual(scanLiterals('url', 'https://api.github.com/repos/OWNER/REPO').map((x) => x.text), ['OWNER', 'REPO']);
  assert.deepEqual(scanLiterals('jsCode', 'const $env = { "N8N_HOST": x };\nreturn $env.N8N_HOST;'), []);
});

check('conversion report: hard, soft, blocker, loops, stubs, triggers', () => {
  const r = evaluate(
    wf([], {
      conversion: {
        approximate: [
          { node: 'A', n8n: 'x.y', action: 'NodeTransform' },
          { node: 'B', n8n: 'x.z', action: 'NodeTransform', soft: true },
          { node: 'C', n8n: 'crypto.hmac', action: 'NodeTransform', blocker: 'signature-verification' },
        ],
        removedEdges: [{ from: 'Loop', to: 'Body' }],
        loopPolicy: 'flattened',
        unmapped: [{ node: 'D', type: 'x', reason: 'no mapping' }],
        triggers: [{ node: 'Gmail Trigger', type: 'n8n-nodes-base.gmailTrigger', as: 'NodeStart' }, { node: 'Manual', type: 'n8n-nodes-base.manualTrigger', as: 'NodeStart' }],
      },
    }),
    { catalog },
  );
  assert.deepEqual(codes(r), ['signature-verification', 'trigger-replaced', 'loop-flattened', 'hard-approximation', 'unmapped-node']);
  assert.equal(r.tier, 'experimental');
});

check('trigger-replaced alone is informational (still ready)', () => {
  const r = evaluate(wf([], { conversion: { triggers: [{ node: 'T', type: 'n8n-nodes-base.telegramTrigger', as: 'NodeStart' }] } }), { catalog });
  assert.equal(r.tier, 'ready');
  assert.deepEqual(codes(r), ['trigger-replaced']);
});

check('signature verification alone is experimental (the step stops the run)', () => {
  const r = evaluate(wf([], { conversion: { approximate: [{ node: 'C', n8n: 'code.crypto', blocker: 'signature-verification' }] } }), { catalog });
  assert.equal(r.tier, 'experimental');
});

check('a data-only loop flattened safely is not a blocker', () => {
  const r = evaluate(wf([], { conversion: { loopPolicy: 'flattened-safe', removedEdges: [{ from: 'Set', to: 'Loop' }] } }), { catalog });
  assert.equal(r.tier, 'ready');
});

check('verified only through data/verified.json, never over experimental', () => {
  const t = wf([]);
  assert.equal(evaluate(t, { catalog, verified: new Map([['x/t.json', {}]]), path: 'x/t.json' }).tier, 'verified');
  const bad = wf([], { conversion: { loopPolicy: 'flattened', removedEdges: [{ from: 'a', to: 'b' }] } });
  assert.equal(evaluate(bad, { catalog, verified: new Map([['x/t.json', {}]]), path: 'x/t.json' }).tier, 'experimental');
});

check('statusForTier keeps old consumers working', () => {
  assert.deepEqual(TIERS, ['verified', 'ready', 'experimental']);
  assert.deepEqual(TIERS.map(statusForTier), ['ready', 'ready', 'needs-setup']);
});

check('placeholder list catches the known forms', () => {
  for (const s of ['YOUR_API_KEY', 'CHANGE-ME', 'REPLACE_WITH_TOKEN', '<your email>', 'https://api.github.com/repos/OWNER/REPO', 'BOT_TOKEN']) assert.ok(PLACEHOLDER_RE.test(s), s);
  for (const s of ['your order is ready', 'https://api.github.com/repos/n8n-io/n8n', 'Owner']) assert.ok(!PLACEHOLDER_RE.test(s), s);
});

check('schemas use the same enums as lib/catalog-fs', () => {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'template.schema.json'), 'utf8'));
  const i = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'templates.schema.json'), 'utf8'));
  assert.deepEqual(t.properties.template.properties.tier.enum, TIERS);
  assert.deepEqual(t.properties.template.properties.blockers.items.properties.code.enum, Object.keys(BLOCKERS));
  assert.deepEqual(t.properties.template.properties.conversion.properties.status.enum, STATUSES);
  assert.deepEqual(i.properties.templates.items.properties.tier.enum, TIERS);
  assert.deepEqual(i.properties.templates.items.properties.blockers.items.enum, Object.keys(BLOCKERS));
});

check('one walker finds every template and nothing else', () => {
  const files = listTemplates();
  assert.ok(files.length > 300);
  assert.ok(files.every((f) => /^[a-z0-9-]+\/[a-z0-9-]+\.json$/.test(f)), 'template paths are kebab-case category/slug.json');
});

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
