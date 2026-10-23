#!/usr/bin/env node
/** Unit tests for expression tokenisation helpers. */
import assert from 'node:assert/strict';
import { classifyExpr, isTokenExpressible, toJs, toTokens, shimPrelude, usedHelpers, toSafeSqlJs, SQL_HELPERS } from './lib/expressions.mjs';
import { SERVICES } from './lib/n8n-mapping.mjs';

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

check('$json.path', () => {
  assert.deepEqual(classifyExpr('$json.foo.bar'), { kind: 'self', path: 'foo.bar' });
});

check("$('Node').json.foo shorthand", () => {
  assert.deepEqual(classifyExpr("$('Vars').json.qdrantCloudURL"), {
    kind: 'node',
    node: 'Vars',
    path: 'qdrantCloudURL',
  });
});

check("$('Node').first().json.foo", () => {
  assert.equal(classifyExpr("$('Vars').first().json.collectionName").kind, 'node');
});

check('$ifEmpty($json.a, …) → self path', () => {
  assert.deepEqual(classifyExpr("$ifEmpty($json.a, '')"), { kind: 'self', path: 'a' });
});

check('complex DateTime stays complex', () => {
  assert.equal(classifyExpr('DateTime.now().minus({ days: 7 }).toMillis()').kind, 'complex');
});

check('toTokens mixed URL', () => {
  const url = "={{ $('Vars').json.host }}/x/{{ $('Vars').json.name }}";
  assert.equal(isTokenExpressible(url), true);
  const out = toTokens(url, (c) => (c.kind === 'node' ? `{{${c.path}}}` : null));
  assert.equal(out, '{{host}}/x/{{name}}');
});

check('toJs keeps bare run-input tokens literal', () => {
  const url = '=https://api.telegram.org/bot{{telegramBotToken}}/getFile?file_id={{ $json.file_id }}';
  const js = toJs(url);
  assert.match(js, /\{\{telegramBotToken\}\}/);
  assert.doesNotMatch(js, /\$\{telegramBotToken\}/);
  assert.match(js, /\$json\.file_id/);
});

check("shimPrelude named $('Vars')", () => {
  const body = "return $('Vars').item.json.host;";
  const pre = shimPrelude(body, { Vars: { kind: 'literal', value: { host: 'https://example.com' } } });
  assert.match(pre, /__named/);
  assert.match(pre, /https:\/\/example\.com/);
  assert.match(pre, /const \$ = \(name\)/);
});

check('Drive/Jira/Facebook/Spotify ops present', () => {
  assert.ok(SERVICES['n8n-nodes-base.googleDrive'].ops['fileFolder.upload']);
  assert.ok(SERVICES['n8n-nodes-base.googleDrive'].ops['file.createFromText']);
  assert.ok(SERVICES['n8n-nodes-base.jira'].ops['issueComment.create']);
  assert.ok(SERVICES['n8n-nodes-base.jira'].ops['issueAttachment.create']);
  assert.ok(SERVICES['n8n-nodes-base.facebookGraphApi'].ops['page.post']);
  assert.ok(SERVICES['n8n-nodes-base.spotify'].ops['player.nextSong']);
  assert.ok(SERVICES['n8n-nodes-base.gmail'].ops['draft.send']);
});

check('no mis-keyed cross-resource Gmail send', () => {
  assert.equal(SERVICES['n8n-nodes-base.gmail'].ops['label.send'], undefined);
  assert.equal(SERVICES['n8n-nodes-base.gmail'].defaults.byResource.label, 'getAll');
  assert.equal(SERVICES['n8n-nodes-base.airtable'].defaults.byResource.base, 'getMany');
});

check('helpers: only n8n helper calls count, not built-ins', () => {
  assert.deepEqual([...usedHelpers('const a = Math.max(1, 2); Object.keys(x); $input.first(); $("Node").first();')], []);
  assert.deepEqual([...usedHelpers('return $json.items.first().name.toTitleCase();')].sort(), ['first', 'toTitleCase']);
});

check('shim prelude carries only the helpers used', () => {
  const p = shimPrelude('return $json.tags.unique();');
  assert.ok(p.includes('unique()'));
  assert.ok(!p.includes('extractUrl'));
  assert.ok(!p.includes('const __dt'));
  assert.equal(shimPrelude('return Math.max(1, 2);'), '');
  assert.ok(shimPrelude('return $json.d.toDateTime();').includes('const __dt'));
});

check('String.hash fails closed', () => {
  const p = shimPrelude('return $json.email.hash();');
  const fn = new Function('source', `${p}return $json.email.hash();`);
  assert.throws(() => fn({ email: 'a' }), /crypto digest/);
});

check('safe SQL: quoted and bare interpolation are escaped', () => {
  const js = toSafeSqlJs("=SELECT * FROM {{ $json.t }} WHERE name = '{{ $json.name }}' AND id = {{ $json.id }}");
  const run = (json) => new Function('$json', `${SQL_HELPERS}return ${js};`)(json);
  assert.equal(run({ t: 'docs', name: "O'Brien", id: 4 }), "SELECT * FROM docs WHERE name = 'O''Brien' AND id = 4");
  assert.equal(run({ t: 'docs', name: "x' OR '1'='1", id: '1 OR 1=1' }), "SELECT * FROM docs WHERE name = 'x'' OR ''1''=''1' AND id = '1 OR 1=1'");
  assert.throws(() => run({ t: 'docs; DROP TABLE docs', name: '', id: 1 }), /unsafe SQL identifier/);
});

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
