#!/usr/bin/env node
/**
 * Convert golden fixtures — locks hard families from the post-partial quality plan.
 * Usage: node scripts/convert-fixtures.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { convertWorkflow } from './convert-n8n.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const connectorActions = (wf) => wf.nodes.filter((n) => n.type === 'NodeCdeConnector').map((n) => n.inputs?.action);
const codes = (wf) => wf.template.blockers.map((b) => b.code);
const onlyBlockers = (wf, allowed) => {
  const extra = codes(wf).filter((c) => !allowed.includes(c));
  if (extra.length) throw new Error(`unexpected blockers ${extra.join(', ')}`);
};
/** Run a Transform body the way validate.mjs does, with a real payload. */
const runTransform = (node, source, ctx = {}) => {
  const code = node.inputs.jsCode.replace(/\{\{\{?\s*([\w$][\w$.[\]-]*)\s*\}?\}\}/g, (_m, p) => (p === 'ctx' ? JSON.stringify(ctx) : p in ctx ? String(ctx[p]) : 'null'));
  const fn = vm.runInNewContext(`(function (source) {\n"use strict";\n${code}\n})`, { crypto: globalThis.crypto, globalThis: { crypto: globalThis.crypto }, TextEncoder, TextDecoder, btoa, atob });
  const output = fn(source);
  return code.includes('const __promptValue =') && typeof output === 'object' ? Object.values(output)[0] : output;
};

const byLabel = (wf, label) => wf.nodes.find((n) => n.label === label);
const builderOf = (wf, node, socket = 'params') => {
  const e = wf.edges.find((x) => x.target === node.nodeId && x.targetInput === socket);
  if (e) return wf.nodes.find((n) => n.nodeId === e.source);
  if (node.inputs?.[socket] === '{{last.transformed}}') {
    const trigger = wf.edges.find((e) => e.target === node.nodeId && e.targetInput === 'RUN');
    return wf.nodes.find((n) => n.nodeId === trigger?.source);
  }
  const id = /^\{\{llm_(?:prompt|system)_([a-f0-9]{10})\}\}$/.exec(node.inputs?.[socket])?.[1];
  return wf.nodes.find((n) => n.nodeId === `node_${id}`);
};
const context = (wf) => wf.nodes.find((n) => n.type === 'NodeWorkflowConfigs').inputs.initialContext || {};
/** No literal from the original in any node input (setup values replace them). */
const absent = (wf, ...literals) => {
  const blob = JSON.stringify(wf.nodes);
  for (const l of literals) if (blob.includes(l)) throw new Error(`${l} must not ship in the template`);
};

const connector = (wf, action) => wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === action);
/** Params of a connector step: inline, or its builder run on `source` (and run-context `ctx`). */
const paramsOf = (wf, action, source, ctx) => {
  const c = connector(wf, action);
  if (!c) throw new Error(`expected ${action}, got ${connectorActions(wf)}`);
  return c.inputs.params ?? runTransform(builderOf(wf, c), source, ctx);
};
const blockersOnly = (wf, allowed) => {
  const extra = codes(wf).filter((c) => !allowed.includes(c) && c !== 'trigger-replaced' && c !== 'webhook-registration');
  if (extra.length) throw new Error(`unexpected blockers ${extra.join(', ')}: ${JSON.stringify(wf.template.blockers)}`);
};
const pendingFor = (wf, node) => wf.template.blockers.some((b) => b.code === 'action-pending-publish' && b.node === node);
// Output shapes of the connectors the file mappings read.
const DRIVE_DOWNLOAD = { data: { downloaded_file_content: { s3url: 'https://s3.example.org/f/report.pdf', name: 'report.pdf', mimetype: 'application/pdf' } }, successful: true };
const HTTP_FILE = { data: { status: 200, ok: true, headers: {}, contentType: 'image/png', filename: 'shot.png', bodyBase64: 'aGVsbG8=' }, successful: true };

const EXPECT = {
  'llm-chain-providers.json': (wf) => {
    for (const [label, provider, model] of [
      ['Gemini Chain', 'gemini', 'models/gemini-2.0-flash'],
      ['Router Chain', 'openrouter', 'google/gemini-2.0-flash-001'],
      ['Ollama Chain', 'ollama', 'mistral-nemo:latest'],
    ]) {
      const chain = byLabel(wf, label), config = builderOf(wf, chain, 'llm');
      if (chain.type !== 'NodeLlmChain' || config?.type !== 'NodeChatModel' || config.inputs.provider !== provider || config.inputs.model !== model) throw new Error(`wrong model connection for ${label}`);
      if (['provider', 'model', 'credential', 'temperature', 'maxTokens'].some((k) => k in chain.inputs)) throw new Error('retired controls on LLMChain');
    }
    const structured = byLabel(wf, 'Ollama Chain');
    if (structured.inputs.prompt !== '{{last.text}}' || structured.inputs.outputMode !== 'structured' || structured.inputs.schemaMode !== 'prompt') throw new Error('structured chain reads the preceding text directly and keeps portable schema mode');
    if (!wf.edges.some((e) => e.source === byLabel(wf, 'Router Chain').nodeId && e.target === structured.nodeId && e.sourceOutput === 'onDone' && e.targetInput === 'RUN')) throw new Error('the text producer must trigger the structured chain directly');
    const adapter = builderOf(wf, byLabel(wf, 'Count'), 'source');
    const array = runTransform(adapter, { items: [{ name: 'London' }, { name: 'Paris' }] });
    if (runTransform(byLabel(wf, 'Count'), array).count !== 2) throw new Error('downstream must receive the unwrapped array');
    if (wf.template.connectors.join() !== 'gemini,ollama,openrouter' || wf.template.tier !== 'ready') throw new Error('declare each provider credential');
    if (wf.edges.some((e) => /NodeCdeGenerateObject|NodeCdecliChatCompletion/.test(e.sourceNodeType + e.targetNodeType))) throw new Error('stale edge types');
  },
  // --- binary files and bodies the HTTP node cannot send: yantra-storage HTTP_SEND and the patched file actions ---
  'http-multipart-file.json': (wf) => {
    const params = paramsOf(wf, 'YANTRA_STORAGE_HTTP_SEND', DRIVE_DOWNLOAD, { llamaCloudApiKey: 'SECRET' });
    if (params.bodyType !== 'multipart' || params.fields.language !== 'en') throw new Error(`multipart fields ${JSON.stringify(params)}`);
    const f = params.files?.[0];
    if (!f || f.field !== 'file' || f.fileUrl !== 'https://s3.example.org/f/report.pdf' || f.filename !== 'report.pdf' || f.mimeType !== 'application/pdf' || f.contentBase64 !== undefined) throw new Error(`binary form field from the Drive download URL: ${JSON.stringify(f)}`);
    if (params.headers.Authorization !== 'Bearer SECRET') throw new Error(`auth header from the workflow secret: ${JSON.stringify(params.headers)}`);
    if (wf.template.setupSecrets.map((x) => x.key).join() !== 'LLAMA_CLOUD_API_KEY') throw new Error('LlamaCloud key is a workflow secret');
    blockersOnly(wf, ['action-pending-publish']);
    if (!pendingFor(wf, 'Upload to LlamaParse')) throw new Error('HTTP_SEND waits for the yantra-storage patch');
    if (wf.nodes.some((n) => n.type === 'NodeHttpRequest')) throw new Error('no JSON-only HTTP node for a multipart upload');
  },
  'http-binary-body.json': (wf) => {
    const params = paramsOf(wf, 'YANTRA_STORAGE_HTTP_SEND', { imageUrl: 'https://cdn.example.org/cover.png' }, { blogBasicAuth: 'dXNlcjpwdw==' });
    if (params.bodyType !== 'binary' || params.file?.fileUrl !== 'https://cdn.example.org/cover.png') throw new Error(`binary body from the generated image URL: ${JSON.stringify(params)}`);
    if (params.headers.Authorization !== 'Basic dXNlcjpwdw==' || params.headers['Content-Disposition'] !== 'attachment; filename="cover.jpg"') throw new Error(`headers ${JSON.stringify(params.headers)}`);
    blockersOnly(wf, ['action-pending-publish']);
  },
  'http-raw-body.json': (wf) => {
    const params = paramsOf(wf, 'YANTRA_STORAGE_HTTP_SEND');
    if (params.bodyType !== 'raw' || params.rawBody !== '{{message}}' || params.contentType !== 'text/plain; charset=utf-8' || params.failOnHttpError !== false || params.timeoutMs !== 10000) throw new Error(`raw params ${JSON.stringify(params)}`);
    if (params.headers['Content-Type'] || params.headers.Title !== 'Daily summary') throw new Error(`the content type travels as contentType, other headers stay: ${JSON.stringify(params.headers)}`);
    const shape = byLabel(wf, 'Notify: response');
    const out = runTransform(shape, { data: { status: 200, ok: true, headers: { a: '1' }, bodyText: 'queued' }, successful: true });
    if (out.body !== 'queued' || out.statusCode !== 200 || out.headers.a !== '1') throw new Error(`fullResponse shape ${JSON.stringify(out)}`);
    blockersOnly(wf, ['action-pending-publish']);
  },
  'http-form-body.json': (wf) => {
    const params = paramsOf(wf, 'YANTRA_STORAGE_HTTP_SEND');
    if (params.bodyType !== 'form' || params.fields.grant !== 'client_credentials' || params.fields.client_id !== '{{clientId}}') throw new Error(`form params ${JSON.stringify(params)}`);
    const out = runTransform(byLabel(wf, 'Get token: response'), { data: { status: 200, ok: true, headers: {}, bodyJson: { access_token: 't' } } });
    if (out.access_token !== 't') throw new Error('JSON responses are handed on as the parsed body');
    blockersOnly(wf, ['action-pending-publish']);
  },
  'telegram-file-download.json': (wf) => {
    const dl = paramsOf(wf, 'YANTRA_STORAGE_HTTP_SEND');
    if (dl.responseType !== 'base64' || dl.method !== 'GET') throw new Error(`a download read as a file: ${JSON.stringify(dl)}`);
    const file = runTransform(byLabel(wf, 'Download image: response'), HTTP_FILE);
    if (file.bodyBase64 !== 'aGVsbG8=' || file.mimeType !== 'image/png') throw new Error(`file shape ${JSON.stringify(file)}`);
    const params = paramsOf(wf, 'TELEGRAM_SEND_PHOTO', file);
    if (params.photo_base64 !== 'aGVsbG8=' || params.photo_mime_type !== 'image/png' || params.photo_filename !== 'shot.png' || params.caption !== 'Here it is' || params.photo) throw new Error(`photo bytes ${JSON.stringify(params)}`);
    blockersOnly(wf, ['action-pending-publish']);
    if (!pendingFor(wf, 'Send photo') || !pendingFor(wf, 'Download image')) throw new Error(`pending ${JSON.stringify(wf.template.blockers)}`);
  },
  'telegram-code-binary.json': (wf) => {
    const built = runTransform(byLabel(wf, 'Build PDF'), { stdout: 'JVBERi0xLjQ=\n' });
    if (built.binary?.pdf_doc?.data !== 'JVBERi0xLjQ=' || built.ok !== true) throw new Error(`Code keeps the binary it builds: ${JSON.stringify(built)}`);
    const params = paramsOf(wf, 'TELEGRAM_SEND_DOCUMENT', built);
    if (params.document_base64 !== 'JVBERi0xLjQ=' || params.document_filename !== 'resume.pdf' || params.document_mime_type !== 'application/pdf' || params.caption !== 'Your resume') throw new Error(`document bytes ${JSON.stringify(params)}`);
    blockersOnly(wf, ['action-pending-publish']);
  },
  'jira-attachment.json': (wf) => {
    const rename = byLabel(wf, 'Rename Screenshot');
    const shot = wf.nodes.find((n) => n.label === 'Retrieve Screenshot: response');
    if (!rename.inputs.jsCode.includes(`const __src = {{steps.xf_${shot.nodeId.slice(5)}.result}};`) || !rename.inputs.jsCode.includes('filename: "emailScreenshot.png"')) throw new Error('rename-only Code passes the named file on under its new name');
    const renamed = runTransform(rename, null, { [`steps.xf_${shot.nodeId.slice(5)}.result`]: JSON.stringify({ bodyBase64: 'aGVsbG8=', filename: 'shot.png' }) });
    if (renamed.filename !== 'emailScreenshot.png' || renamed.bodyBase64 !== 'aGVsbG8=') throw new Error(`renamed ${JSON.stringify(renamed)}`);
    const params = paramsOf(wf, 'JIRA_ADD_ATTACHMENT', { bodyBase64: 'aGVsbG8=', mimeType: 'image/png', filename: 'emailScreenshot.png' });
    if (params.content_base64 !== 'aGVsbG8=' || params.filename !== 'emailScreenshot.png' || params.mime_type !== 'image/png') throw new Error(`attachment ${JSON.stringify(params)}`);
    blockersOnly(wf, ['action-pending-publish']);
    if (!pendingFor(wf, 'Attach')) throw new Error('JIRA_ADD_ATTACHMENT content_base64 waits for the jira patch');
  },
  'transcribe-drive.json': (wf) => {
    const params = paramsOf(wf, 'YANTRA_VOICEBOX_TRANSCRIBE', DRIVE_DOWNLOAD);
    if (params.audioUrl !== 'https://s3.example.org/f/report.pdf' || params.language !== 'de' || 'audioBase64' in params) throw new Error(`audio URL from the Drive download: ${JSON.stringify(params)}`);
    // audioUrl is the published param, so nothing waits for a patch.
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'whisper-http.json': (wf) => {
    const params = paramsOf(wf, 'YANTRA_VOICEBOX_TRANSCRIBE', { bodyBase64: 'SUQz', mimeType: 'audio/mpeg', filename: 'ep.mp3' });
    if (params.audioBase64 !== 'SUQz' || params.mimeType !== 'audio/mpeg' || params.filename !== 'ep.mp3') throw new Error(`Whisper over HTTP becomes the platform transcription: ${JSON.stringify(params)}`);
    if ((wf.template.setupSecrets || []).length) throw new Error('no OpenAI key for the platform transcription');
    const out = runTransform(byLabel(wf, 'Whisper: text'), { data: { text: 'hello' }, successful: true });
    if (out.text !== 'hello') throw new Error('later steps read { text } like the Whisper API');
    blockersOnly(wf, ['action-pending-publish']);
  },
  'dropbox-upload.json': (wf) => {
    const params = paramsOf(wf, 'DROPBOX_UPLOAD_FILE', { bodyBase64: 'AAAA', mimeType: 'video/mp4', filename: 'v.mp4', name: 'clip' });
    if (params.content_base64 !== 'AAAA' || params.mode !== 'overwrite' || params.path !== '/videos/clip.mp4' || params.content !== undefined) throw new Error(`dropbox ${JSON.stringify(params)}`);
    blockersOnly(wf, ['action-pending-publish']);
  },
  'drive-update-content.json': (wf) => {
    const params = paramsOf(wf, 'GOOGLESUPER_EDIT_FILE', { bodyBase64: 'JVBERg==', mimeType: 'application/pdf', driveFileId: 'f1' });
    if (params.content_base64 !== 'JVBERg==' || params.mime_type !== 'application/pdf' || params.file_id !== 'f1') throw new Error(`edit file ${JSON.stringify(params)}`);
    blockersOnly(wf, ['action-pending-publish']);
  },
  'readpdf-url.json': (wf) => {
    const params = paramsOf(wf, 'PDF_CO_PDF_TO_TEXT', DRIVE_DOWNLOAD);
    if (params.url !== 'https://s3.example.org/f/report.pdf' || params.inline !== true) throw new Error(`pdf.co from the file URL: ${JSON.stringify(params)}`);
    const out = runTransform(byLabel(wf, 'Read PDF: text'), { data: { body: 'Invoice 42' }, successful: true });
    if (out.text !== 'Invoice 42') throw new Error('Read PDF hands on { text }');
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'readpdf-bytes.json': (wf) => {
    const up = wf.nodes.filter((n) => n.inputs?.action === 'YANTRA_STORAGE_HTTP_SEND').map((n) => n.inputs.params ?? runTransform(builderOf(wf, n), { bodyBase64: 'JVBERg==', filename: 'inv.pdf', mimeType: 'application/pdf' }, { pdfcoApiKey: 'K' }));
    const toPdfco = up.find((x) => x.url === 'https://api.pdf.co/v1/file/upload/base64');
    if (!toPdfco || toPdfco.fields.file !== 'JVBERg==' || toPdfco.fields.name !== 'inv.pdf' || toPdfco.headers['x-api-key'] !== 'K' || toPdfco.bodyType !== 'form') throw new Error(`bytes are uploaded to pdf.co first: ${JSON.stringify(up)}`);
    const params = paramsOf(wf, 'PDF_CO_PDF_TO_TEXT', { data: { status: 200, ok: true, bodyJson: { url: 'https://pdf-temp-files.s3.amazonaws.com/x.pdf' } } });
    if (params.url !== 'https://pdf-temp-files.s3.amazonaws.com/x.pdf' || params.inline !== true) throw new Error(`pdf.co converts the uploaded URL: ${JSON.stringify(params)}`);
    if (wf.template.setupSecrets.map((x) => x.key).join() !== 'PDFCO_API_KEY') throw new Error('pdf.co key is a workflow secret');
    blockersOnly(wf, ['action-pending-publish']);
  },
  'readpdf-gmail.json': (wf) => {
    const b = wf.template.blockers.find((x) => x.code === 'hard-approximation' && x.node === 'Read PDF');
    if (!b || !/gmailTrigger.*metadata, not as file bytes/.test(b.detail)) throw new Error(`precise reason for an email attachment: ${JSON.stringify(wf.template.blockers)}`);
  },
  'multipart-private-host.json': (wf) => {
    const b = wf.template.blockers.find((x) => x.code === 'hard-approximation' && x.node === 'Gotenberg');
    if (!b || !/plain-http request .*public https hosts/.test(b.detail)) throw new Error(`a private host stays blocked with the reason: ${JSON.stringify(wf.template.blockers)}`);
    const params = paramsOf(wf, 'YANTRA_STORAGE_HTTP_SEND', { data: 'PGgxPmhpPC9oMT4=', fileName: 'index.html', mimeType: 'text/html', encoding: 'base64' });
    if (params.files[0].contentBase64 !== 'PGgxPmhpPC9oMT4=' || params.files[0].filename !== 'index.html') throw new Error(`toBinary file content stays base64: ${JSON.stringify(params.files)}`);
  },
  // --- digests: yantra-storage HASH / HMAC; raw webhook bodies stay blocked ---
  'crypto-hash.json': (wf) => {
    const params = paramsOf(wf, 'YANTRA_STORAGE_HASH', { name: '  Acme ' });
    if (params.algorithm !== 'md5' || params.encoding !== 'hex' || params.payload !== 'acme') throw new Error(`hash params ${JSON.stringify(params)}`);
    const out = runTransform(byLabel(wf, 'Hash name: digest'), { data: { digest: 'abc123' }, successful: true });
    if (out.hash !== 'abc123') throw new Error(`digest on dataPropertyName: ${JSON.stringify(out)}`);
    blockersOnly(wf, ['action-pending-publish']);
    if (codes(wf).includes('signature-verification')) throw new Error('a hash on a connector is not a signature blocker');
  },
  'crypto-hmac-sha256.json': (wf) => {
    absent(wf, 's3cr3t-signing-key-0123456789');
    const params = paramsOf(wf, 'YANTRA_STORAGE_HMAC');
    if (params.algorithm !== 'sha256' || params.encoding !== 'base64' || params.secret !== '{{hmacSecret}}' || params.payload !== '{{payload}}') throw new Error(`hmac params ${JSON.stringify(params)}`);
    if (JSON.stringify(context(wf).hmacSecret) !== '{"$workflowSecret":"HMAC_SECRET"}') throw new Error('the HMAC key is a workflow secret');
    blockersOnly(wf, ['action-pending-publish']);
  },
  'crypto-webhook-raw.json': (wf) => {
    const b = wf.template.blockers.find((x) => x.code === 'signature-verification');
    if (!b || !/raw request body of the webhook "Receive".*parsed JSON/.test(b.detail)) throw new Error(`raw-body HMAC keeps a precise blocker: ${JSON.stringify(wf.template.blockers)}`);
    if (!connector(wf, 'YANTRA_STORAGE_HMAC')) throw new Error('the digest step is on the HMAC action');
  },
  'code-crypto-webhook.json': (wf) => {
    const b = wf.template.blockers.find((x) => x.code === 'signature-verification');
    if (!b || !/x-hub-signature-256 HMAC over the raw request body/.test(b.detail)) throw new Error(`Meta signature check reason: ${JSON.stringify(wf.template.blockers)}`);
  },
  // --- converter gaps: match-column updates, blank content, blank URLs, empty Docs ---
  'airtable-match-update.json': (wf) => {
    const prep = byLabel(wf, 'Save: match');
    const m = runTransform(prep, { email: "o'hara@example.com", base: 'appBASE' });
    if (m.filterByFormula !== "AND({Email}='o\\'hara@example.com')" || m.fields.Status !== 'Contacted' || m.baseId !== 'appBASE') throw new Error(`match filter ${JSON.stringify(m)}`);
    const list = paramsOf(wf, 'AIRTABLE_LIST_RECORDS');
    if (list.filterByFormula !== '{{last.transformed.filterByFormula}}') throw new Error(`list by the filter ${JSON.stringify(list)}`);
    const key = `steps.xf_${prep.nodeId.slice(5)}.result`;
    const upd = paramsOf(wf, 'AIRTABLE_UPDATE_MULTIPLE_RECORDS', { data: { records: [{ id: 'rec1' }, { id: 'rec2' }] } }, { [key]: JSON.stringify(m) });
    if (upd.baseId !== 'appBASE' || upd.records.length !== 2 || upd.records[1].id !== 'rec2' || upd.records[0].fields.Email !== "o'hara@example.com") throw new Error(`update every match ${JSON.stringify(upd)}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'blank-content.json': (wf) => {
    if (paramsOf(wf, 'WHATSAPP_SEND_MESSAGE').text !== '{{whatsappMessage}}' || paramsOf(wf, 'GOOGLESUPER_SEND_EMAIL').body !== '{{emailBody}}') throw new Error('blank message text becomes a setup value');
    const keys = wf.template.setupVars.map((v) => v.key);
    if (!keys.includes('whatsappMessage') || !keys.includes('emailBody')) throw new Error(`setup values ${keys}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'http-no-url.json': (wf) => {
    const h = wf.nodes.find((n) => n.type === 'NodeHttpRequest');
    if (h.inputs.url !== '{{fetchPageUrl}}' || wf.template.setupVars[0]?.type !== 'url') throw new Error(`blank URL becomes a setup value: ${JSON.stringify(h.inputs)}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'docs-create.json': (wf) => {
    absent(wf, '1y0I8MH32maIWCJh767mRE_NMHC6A3bUu');
    const params = paramsOf(wf, 'GOOGLESUPER_CREATE_FILE');
    if (params.mimeType !== 'application/vnd.google-apps.document' || params.name !== '{{title}}' || params.parents?.[0] !== '{{driveFolderId}}') throw new Error(`an empty Google Doc in the folder: ${JSON.stringify(params)}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'ssh.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'SSH_RUN_COMMAND');
    if (!c) throw new Error('expected SSH_RUN_COMMAND connector');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).includes('command.'));
    if (!soft) throw new Error('SSH command.execute should be soft approximate');
  },
  'openai-file.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'OPENAI_UPLOAD_FILE');
    if (!c) throw new Error('expected OPENAI_UPLOAD_FILE');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).startsWith('file.'));
    if (!soft) throw new Error('OpenAI file upload should be soft approximate when file and purpose are set');
  },
  'supabase-search.json': (wf) => {
    const blob = JSON.stringify(wf);
    if (!blob.includes('SUPABASE_SEARCH_ROWS')) throw new Error('expected SUPABASE_SEARCH_ROWS');
    if (blob.includes('<-> $1') || blob.includes('SUPABASE_BETA_RUN_SQL_QUERY')) {
      throw new Error('vector search must not emit placeholder SQL');
    }
    onlyBlockers(wf, ['missing-required-param']);
    const hard = (wf.template.conversion.approximate || []).filter((a) => !a.soft);
    if (hard.length) throw new Error('supabase vector search should not be hard approximate');
  },
  'supabase-insert.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'SUPABASE_INSERT_ROW');
    if (!c) throw new Error('expected SUPABASE_INSERT_ROW');
    const blob = JSON.stringify(c.inputs?.params || {});
    if (blob.includes('...')) throw new Error('supabase insert must not use placeholder SQL');
    if (c.inputs.params.table !== 'telegram_users') throw new Error('expected table telegram_users');
    const hard = (wf.template.conversion.approximate || []).filter((a) => !a.soft);
    if (hard.length) throw new Error('complete supabase insert should not be hard approximate');
  },
  's3-upload.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'AWSS3_UPLOAD_FILE');
    if (!c) throw new Error('expected AWSS3_UPLOAD_FILE');
    if (c.inputs.params.Bucket !== 'media' || c.inputs.params.FileKey !== 'clip.mp4') {
      throw new Error(`expected bucket and key, got ${JSON.stringify(c.inputs.params)}`);
    }
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).includes('file.upload'));
    if (!soft) throw new Error('s3 file.upload should be soft approximate');
  },
  'docs-update.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'GOOGLESUPER_INSERT_TEXT_ACTION');
    if (!c) throw new Error('expected GOOGLESUPER_INSERT_TEXT_ACTION');
    if (c.inputs.params.document_id !== 'doc-1' || c.inputs.params.text_to_insert !== 'Hello') {
      throw new Error(`unexpected docs params ${JSON.stringify(c.inputs.params)}`);
    }
  },
  // Qdrant (no connector) becomes the default vector store: Pinecone integrated embedding.
  'qdrant-http.json': (wf) => {
    const c = wf.nodes.find((n) => n.inputs?.action === 'PINECONE_SEARCH_RECORDS_NAMESPACE');
    if (!c) throw new Error(`expected a Pinecone search, got ${connectorActions(wf)}`);
    if (wf.nodes.some((n) => n.type === 'NodeHttpRequest')) throw new Error('no Qdrant REST call');
    const params = c.inputs.params ?? runTransform(builderOf(wf, c), { chatInput: 'films about space' }, { pineconeIndexHost: 'idx.pinecone.io' });
    if (params.namespace !== 'demo' || params.index_host !== 'idx.pinecone.io' || params.query.inputs.text !== 'films about space' || params.query.top_k !== 4) throw new Error(`params ${JSON.stringify(params)}`);
    if (!wf.template.setupVars.some((v) => v.key === 'pineconeIndexHost')) throw new Error('index host is a setup value');
    const shape = byLabel(wf, 'Qdrant: documents');
    const docs = runTransform(shape, { result: { hits: [{ _id: '1', _score: 0.9, fields: { text: 'alpha', source: 'a.md' } }] } });
    if (docs[0].document.pageContent !== 'alpha' || docs[0].score !== 0.9) throw new Error(`n8n document shape: ${JSON.stringify(docs)}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier}`);
  },
  'qdrant-insert.json': (wf) => {
    const c = wf.nodes.find((n) => n.inputs?.action === 'PINECONE_UPSERT_RECORDS_NAMESPACE');
    if (!c) throw new Error('expected a Pinecone upsert');
    const out = runTransform(builderOf(wf, c), [{ pageContent: 'alpha', metadata: { source: 'a.md', page: 1 } }, { text: 'beta', id: 'b-1' }], { pineconeIndexHost: 'idx.pinecone.io' });
    if (out.namespace !== 'movies') throw new Error(`namespace ${out.namespace}`);
    if (out.records.length !== 2 || out.records[0].text !== 'alpha' || out.records[0].source !== 'a.md' || out.records[1]._id !== 'b-1' || !out.records[0]._id) throw new Error(`records ${JSON.stringify(out.records)}`);
    const soft = wf.template.conversion.approximate.some((a) => a.soft && a.n8n === 'vectorStoreQdrant.insert');
    if (!soft) throw new Error('the Pinecone default store is a soft approximation');
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier}`);
  },
  'vector-inmemory-load.json': (wf) => {
    const c = wf.nodes.find((n) => n.inputs?.action === 'PINECONE_SEARCH_RECORDS_NAMESPACE');
    if (!c || c.inputs.params.namespace !== 'kb' || c.inputs.params.query.top_k !== 3 || c.inputs.params.query.inputs.text !== '{{chatInput}}') throw new Error(`params ${JSON.stringify(c?.inputs?.params)}`);
    if (codes(wf).includes('hard-approximation')) throw new Error('in-memory store is no longer a hard approximation');
  },
  'outlook-rewrite.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.connectorName === 'googlesuper');
    if (!c) throw new Error('expected Outlook→googlesuper rewrite');
    // message.send is an exact Gmail mapping — ready / no hard approx is OK
    const hard = (wf.template.conversion.approximate || []).filter((a) => !a.soft);
    if (hard.length) throw new Error('Outlook send should not be hard approximate');
  },
  'outlook-label.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'GOOGLESUPER_ADD_LABEL_TO_EMAIL');
    if (!c) throw new Error('expected Outlook update → ADD_LABEL');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).includes('message.update'));
    if (!soft) throw new Error('message.update should be soft approximate');
  },
  'code-require.json': (wf) => {
    const t = wf.nodes.find((n) => n.type === 'NodeTransform' && /require|module system|passthrough/i.test(n.inputs?.jsCode || ''));
    if (!t) throw new Error('expected require passthrough Transform');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).includes('require'));
    if (!soft) throw new Error('code.require should be soft approximate');
  },
  'split-batches.json': (wf) => {
    const batch = byLabel(wf, 'Batches');
    const result = runTransform(batch, Array.from({ length: 13 }, (_, i) => i));
    if (result.length !== 10 || result[9] !== 9) throw new Error('a batch without a return selects the first batch');
    if (wf.nodes.some((n) => n.type === 'NodeLoop')) throw new Error('do not invent repetition without a return path');
    if (wf.template.conversion.status !== 'ready') throw new Error('first-batch selection should be ready');
  },
  'airtable-upsert.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'AIRTABLE_UPDATE_RECORD');
    if (!c) throw new Error('expected AIRTABLE_UPDATE_RECORD when id present');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).includes('upsert'));
    if (!soft) throw new Error('record.upsert should be soft');
  },
  'sheets-append-or-update.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'GOOGLESUPER_LOOKUP_SPREADSHEET_ROW');
    if (!c) throw new Error('expected LOOKUP when match key present');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).includes('appendOrUpdate'));
    if (!soft) throw new Error('appendOrUpdate should be soft');
  },
  'telegram-file-get.json': (wf) => {
    const h = wf.nodes.find((n) => n.type === 'NodeHttpRequest');
    if (!h) throw new Error('expected Telegram getFile HTTP');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).includes('telegram.file.get'));
    if (!soft) throw new Error('telegram.file.get should be soft');
    if (!String(h.inputs.url).includes('/bot{{telegramBotToken}}/getFile')) throw new Error(`token must come from the secret: ${h.inputs.url}`);
    if (JSON.stringify(context(wf).telegramBotToken) !== '{"$workflowSecret":"TELEGRAM_BOT_TOKEN"}') throw new Error('bot token must be a workflow secret reference');
    if (wf.template.setupSecrets?.[0]?.key !== 'TELEGRAM_BOT_TOKEN') throw new Error('declared in setupSecrets');
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier}`);
  },
  'drive-binary-upload.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'GOOGLESUPER_CREATE_FILE');
    if (!c) throw new Error('expected GOOGLESUPER_CREATE_FILE for binary upload');
  },
  'cross-node-dollar.json': (wf) => {
    const h = wf.nodes.find((n) => n.type === 'NodeHttpRequest');
    if (!h) throw new Error('expected HTTP node');
    const url = h.inputs?.url || '';
    const builders = wf.nodes.filter((n) => n.type === 'NodeTransform' && /URL:|__named|Vars/i.test(n.inputs?.jsCode || n.label || ''));
    const ok =
      (typeof url === 'string' && (url.includes('example.com') || url.includes('steps.') || url.includes('host'))) ||
      builders.some((b) => /__named|Vars|example\.com/.test(b.inputs?.jsCode || ''));
    if (!ok) throw new Error(`$('Vars') should resolve (url=${JSON.stringify(url)})`);
  },
  'spreadsheet-file.json': (wf) => {
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).startsWith('spreadsheetFile'));
    if (!soft) throw new Error('spreadsheetFile should be soft approximate');
    if (wf.template.conversion.status !== 'ready') throw new Error('spreadsheetFile-only template should be ready');
  },
  'extract-from-file-text.json': (wf) => {
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).startsWith('extractFromFile'));
    if (!soft) throw new Error('text extractFromFile should be soft approximate');
    if (wf.template.conversion.status !== 'ready') throw new Error('text extractFromFile-only template should be ready');
  },
  'execution-data.json': (wf) => {
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && a.n8n === 'executionData');
    if (!soft) throw new Error('executionData should be soft approximate');
    if (wf.template.conversion.status !== 'ready') throw new Error('executionData-only template should be ready');
  },
  'data-table.json': (wf) => {
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && String(a.n8n).startsWith('dataTable'));
    if (!soft) throw new Error('dataTable should be soft approximate');
    if (wf.template.conversion.status !== 'ready') throw new Error('dataTable-only template should be ready');
  },
  'compression.json': (wf) => {
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && a.n8n === 'compression');
    if (!soft) throw new Error('compression should be soft approximate');
    if (wf.template.conversion.status !== 'ready') throw new Error('compression-only template should be ready');
  },
  'langchain-code.json': (wf) => {
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && a.n8n === 'langchain.code');
    if (!soft) throw new Error('langchain.code should be soft approximate');
    if (wf.template.conversion.status !== 'ready') throw new Error('langchain.code-only template should be ready');
  },
  'switch-equal.json': (wf) => {
    const blob = JSON.stringify(wf);
    if (blob.includes('TODO(yantra)')) throw new Error('=equal must not emit TODO(yantra)');
    if (!blob.includes('===')) throw new Error('expected string equality');
    if (wf.template.conversion.status !== 'ready') throw new Error(`expected ready, got ${wf.template.conversion.status}`);
  },
  'http-request-url.json': (wf) => {
    const h = wf.nodes.find((n) => n.type === 'NodeHttpRequest');
    if (!h) throw new Error('expected HTTP node');
    const url = h.inputs?.url;
    const fed = wf.edges.some((e) => e.target === h.nodeId && e.targetInput === 'url');
    if ((!url || String(url).trim() === '') && !fed) throw new Error('HTTP URL must be preserved');
    if (url && !String(url).includes('httpbin.org') && !fed) throw new Error(`unexpected url ${url}`);
  },
  'supabase-filter.json': (wf) => {
    const c = wf.nodes.find((n) => n.type === 'NodeCdeConnector' && n.inputs?.action === 'SUPABASE_UPDATE_ROW');
    if (!c) throw new Error('expected SUPABASE_UPDATE_ROW');
    const blob = JSON.stringify(c.inputs?.params || wf);
    if (!blob.includes('telegram_id')) throw new Error('expected telegram_id filter');
    const hard = (wf.template.conversion.approximate || []).filter((a) => !a.soft);
    if (hard.length) throw new Error('filtered supabase update should not be hard approximate');
    // The Supabase row actions need the project ref, which only the user knows: a setup value.
    if (c.inputs.params.ref !== '{{supabaseProjectRef}}') throw new Error(`ref ${c.inputs.params.ref}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier}`);
    onlyBlockers(wf, []);
  },
  'supabase-filter-string.json': (wf) => {
    const blob = JSON.stringify(wf);
    if (!blob.includes('SUPABASE_DELETE_ROW')) throw new Error('expected SUPABASE_DELETE_ROW');
    if (!blob.includes('metadata->>id')) throw new Error('expected filterString');
    const hard = (wf.template.conversion.approximate || []).filter((a) => !a.soft);
    if (hard.length) throw new Error('filterString delete should not be hard approximate');
    onlyBlockers(wf, ['missing-required-param']);
  },
  // n8n Postgres defaults to insert: a structured SUPABASE_INSERT_ROW, values as fields (never spliced into SQL).
  'postgres-columns.json': (wf) => {
    const c = wf.nodes.find((n) => n.inputs?.action === 'SUPABASE_INSERT_ROW');
    if (!c) throw new Error(`expected SUPABASE_INSERT_ROW, got ${connectorActions(wf)}`);
    if (c.inputs.params.table !== 'top_trends') throw new Error('expected table top_trends');
    if (c.inputs.params.fields?.isposted !== false || !String(c.inputs.params.fields?.tag).includes('{{')) throw new Error(`unexpected fields ${JSON.stringify(c.inputs.params.fields)}`);
    if (JSON.stringify(wf.nodes).includes('INSERT INTO')) throw new Error('postgres insert must not build SQL text');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && a.n8n === 'database.insert');
    if (!soft) throw new Error('column insert should be soft approximate');
    onlyBlockers(wf, ['missing-required-param']);
  },
  'postgres-column-list.json': (wf) => {
    const c = wf.nodes.find((n) => n.inputs?.action === 'SUPABASE_INSERT_ROW');
    if (!c) throw new Error('expected SUPABASE_INSERT_ROW');
    if (c.inputs.params.table !== 'tweets' || Object.keys(c.inputs.params.fields || {}).join(',') !== 'text,score') throw new Error(`unexpected params ${JSON.stringify(c.inputs.params)}`);
    if (JSON.stringify(wf.nodes).includes('INSERT INTO')) throw new Error('postgres insert must not build SQL text');
  },
  'postgres-injection.json': (wf) => {
    // executeQuery with interpolation: the params builder escapes every value.
    const q = wf.nodes.find((n) => n.inputs?.action === 'SUPABASE_BETA_RUN_SQL_QUERY');
    const edge = wf.edges.find((e) => e.target === q.nodeId && e.targetInput === 'params');
    if (!edge) throw new Error('interpolated SQL must go through a params builder');
    const builder = wf.nodes.find((n) => n.nodeId === edge.source);
    const out = runTransform(builder, { body: "x'); DROP TABLE notes;--", n: '1; DROP TABLE notes' });
    if (out.query !== "INSERT INTO notes (body, n) VALUES ('x''); DROP TABLE notes;--', '1; DROP TABLE notes')") throw new Error(`unsafe query: ${out.query}`);
    if (runTransform(builder, { body: 'ok', n: 3 }).query !== "INSERT INTO notes (body, n) VALUES ('ok', 3)") throw new Error('plain values must round-trip');
    // Structured insert: the quote-injection value stays a field value.
    const ins = wf.nodes.find((n) => n.inputs?.action === 'SUPABASE_INSERT_ROW');
    if (ins.inputs.params.fields.name !== "O'Brien'); DROP TABLE people;--") throw new Error('static value must pass through as data');
    if (ins.inputs.params.query !== undefined) throw new Error('structured insert must not carry SQL');
  },
  'image-multistep.json': (wf) => {
    const actions = wf.nodes.filter((n) => n.type === 'NodeCdeConnector').map((n) => n.inputs?.action);
    if (!actions.includes('YANTRA_IMAGE_EDIT_RESIZE') || !actions.includes('YANTRA_IMAGE_EDIT_ANNOTATE')) {
      throw new Error(`expected resize and annotate, got ${actions.join(', ')}`);
    }
    if (actions.includes('YANTRA_IMAGE_EDIT_COMPOSE')) throw new Error('known multiStep ops must not collapse to compose');
    const hard = (wf.template.conversion.approximate || []).filter((a) => !a.soft);
    if (hard.length) throw new Error('resize+text should not be hard approximate');
    if (wf.template.conversion.status !== 'ready') throw new Error(`expected ready, got ${wf.template.conversion.status}`);
  },
  'image-multistep-draw.json': (wf) => {
    const actions = wf.nodes.filter((n) => n.type === 'NodeCdeConnector').map((n) => n.inputs?.action);
    if (!actions.includes('YANTRA_IMAGE_EDIT_ANNOTATE')) throw new Error('text step should still be annotate');
    const hard = (wf.template.conversion.approximate || []).filter((a) => !a.soft && a.n8n === 'image.multiStep');
    if (!hard.length) throw new Error('draw must stay hard');
    if (wf.template.conversion.status !== 'needs-setup') throw new Error(`expected needs-setup, got ${wf.template.conversion.status}`);
  },
  'crypto-uuid.json': (wf) => {
    const blob = JSON.stringify(wf);
    if (!blob.includes('crypto.randomUUID()')) throw new Error('expected randomUUID');
    const soft = (wf.template.conversion.approximate || []).some((a) => a.soft && a.n8n === 'crypto.generate');
    if (!soft) throw new Error('crypto.generate should be soft');
    if (wf.template.conversion.status !== 'ready') throw new Error(`expected ready, got ${wf.template.conversion.status}`);
  },
  'crypto-hmac.json': (wf) => {
    const blob = JSON.stringify(wf);
    if (blob.includes('randomUUID')) throw new Error('hmac must not become a UUID');
    const hard = (wf.template.conversion.approximate || []).filter((a) => !a.soft && a.n8n === 'crypto.hmac');
    if (!hard.length) throw new Error('hmac must stay hard');
    if (wf.template.conversion.status !== 'needs-setup') throw new Error(`expected needs-setup, got ${wf.template.conversion.status}`);
    if (!codes(wf).includes('signature-verification')) throw new Error('expected signature-verification blocker');
    const t = wf.nodes.find((n) => n.type === 'NodeTransform' && /crypto hmac/.test(n.inputs.jsCode));
    let threw = false;
    try {
      runTransform(t, { data: 'payload' });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('an HMAC step must fail closed, never return a stand-in digest');
    // n8n's default HMAC type is MD5, which yantra-storage HMAC does not offer: the blocker says so.
    const b = wf.template.blockers.find((x) => x.code === 'signature-verification');
    if (!/HMAC MD5 has no yantra-storage action/.test(b.detail)) throw new Error(`reason ${b.detail}`);
  },
  'code-crypto-hmac.json': (wf) => {
    const blob = JSON.stringify(wf.nodes);
    if (/digest: \(\) => '0'/.test(blob)) throw new Error('crypto stub must be gone');
    if (!codes(wf).includes('signature-verification')) throw new Error('expected signature-verification blocker');
    if (wf.template.tier !== 'experimental') throw new Error(`expected experimental, got ${wf.template.tier}`);
    const verify = wf.nodes.find((n) => n.type === 'NodeTransform' && n.inputs.jsCode.includes('createHmac'));
    let error = '';
    try {
      runTransform(verify, { raw: 'x', sig: '0' });
    } catch (e) {
      error = e.message;
    }
    if (!/not available/.test(error)) throw new Error(`a forged signature ("0") must not pass; got ${error || 'no error'}`);
    const uuid = wf.nodes.find((n) => n.type === 'NodeTransform' && n.inputs.jsCode.includes('randomUUID') && !n.inputs.jsCode.includes('createHmac'));
    if (uuid.inputs.jsCode.includes('__noCrypto')) throw new Error('randomUUID-only code needs no crypto shim');
    if (!/^[0-9a-f-]{36}$/.test(runTransform(uuid, {}).id)) throw new Error('randomUUID must still work');
  },
  'openai-image-analyze.json': (wf) => {
    // analyze is a vision call (OpenAI Responses with an input_image item); only the default (generate) creates an image.
    const gens = wf.nodes.filter((n) => n.inputs?.action === 'YANTRA_GEMINI_IMAGE_GENERATE');
    if (gens.length !== 1) throw new Error(`expected exactly one image generation, got ${gens.length}`);
    const v = wf.nodes.find((n) => n.inputs?.action === 'OPENAI_CREATE_RESPONSE');
    if (!v) throw new Error('analyze must become OPENAI_CREATE_RESPONSE');
    const params = v.inputs.params ?? runTransform(builderOf(wf, v), { url: 'https://img/x.png' });
    const content = params.input[0].content;
    if (params.model !== 'gpt-4o' || content[0].text !== 'Describe the photo' || content[1].type !== 'input_image' || !/x\.png|\{\{/.test(content[1].image_url)) throw new Error(`input ${JSON.stringify(params)}`);
    const shape = byLabel(wf, 'Analyze image: answer');
    if (runTransform(shape, { output_text: 'a cat' }).content !== 'a cat') throw new Error('n8n shape { content }');
    if (codes(wf).includes('hard-approximation')) throw new Error('vision is no longer a hard approximation');
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier}`);
  },
  'set-json-mode.json': (wf) => {
    const t = wf.nodes.find((n) => n.type === 'NodeTransform' && n.label === 'Now Playing');
    const out = runTransform(t, { item: { name: 'Song' }, n: 2 });
    if (out.message !== 'Now playing Song' || out.n !== 2) throw new Error(`Set JSON mode lost data: ${JSON.stringify(out)}`);
  },
  // n8n omits parameters equal to their default; each resource has its own default operation.
  'default-ops-gmail.json': (wf) => {
    const a = connectorActions(wf);
    const want = ['GOOGLESUPER_LIST_LABELS', 'GOOGLESUPER_LIST_THREADS', 'GOOGLESUPER_CREATE_EMAIL_DRAFT', 'GOOGLESUPER_SEND_EMAIL'];
    if (a.join() !== want.join()) throw new Error(`got ${a.join(', ')}`);
  },
  'default-ops-airtable.json': (wf) => {
    const a = connectorActions(wf);
    if (a.join() !== 'AIRTABLE_LIST_BASES,AIRTABLE_GET_RECORD') throw new Error(`got ${a.join(', ')}`);
  },
  'default-ops-google.json': (wf) => {
    const a = connectorActions(wf);
    if (a.join() !== 'GOOGLESUPER_CREATE_GOOGLE_SHEET1,GOOGLESUPER_BATCH_GET,GOOGLESUPER_FIND_FILE') throw new Error(`got ${a.join(', ')}`);
    const find = wf.nodes.find((n) => n.inputs?.action === 'GOOGLESUPER_FIND_FILE');
    if (!/in parents/.test(find.inputs.params.q)) throw new Error('folder search must become a Drive q');
  },
  'default-ops-spotify.json': (wf) => {
    const a = connectorActions(wf);
    if (a.join() !== 'SPOTIFY_ADD_ITEM_TO_PLAYBACK_QUEUE,SPOTIFY_GET_USER_S_SAVED_TRACKS,SPOTIFY_ADD_TRACKS_TO_PLAYLIST') throw new Error(`got ${a.join(', ')}`);
  },
  'default-ops-misc.json': (wf) => {
    const a = connectorActions(wf);
    if (a.join() !== 'NOTION_FETCH_DATABASE,BASEROW_LIST_ROWS,WHATSAPP_SEND_TEMPLATE_MESSAGE,JIRA_ADD_COMMENT') throw new Error(`got ${a.join(', ')}`);
    if (wf.nodes.find((n) => n.inputs?.action === 'JIRA_ADD_COMMENT').inputs.params.comment !== 'Thanks') throw new Error('jira comment param');
    // BASEROW_LIST_ROWS is published (baserow 12.1.12), so nothing waits on a patch any more.
    if (codes(wf).includes('action-pending-publish') || codes(wf).includes('unimplemented-action')) throw new Error('published action must not be pending');
  },
  'unknown-default.json': (wf) => {
    if (connectorActions(wf).length) throw new Error('an unknown default operation must not guess an action');
    if (!codes(wf).includes('unmapped-node')) throw new Error('expected an unmapped stub');
  },
  'facebook-graph.json': (wf) => {
    if (connectorActions(wf).includes('FACEBOOK_CREATE_POST')) throw new Error('a Graph GET must not create a post');
    const h = wf.nodes.find((n) => n.type === 'NodeHttpRequest');
    if (!h || !String(h.inputs.url).startsWith('https://graph.facebook.com/v20.0/')) throw new Error('expected a Graph API GET');
    if (h.inputs.headers?.Authorization !== 'Bearer {{facebookAccessToken}}') throw new Error(`Graph API token from a workflow secret: ${JSON.stringify(h.inputs.headers)}`);
    if (codes(wf).includes('http-auth-missing')) throw new Error('the secret satisfies auth');
  },
  'ga-report.json': (wf) => {
    if (!connectorActions(wf).includes('GOOGLE_ANALYTICS_RUN_REPORT')) throw new Error('expected GA connector action');
    if (JSON.stringify(wf).includes('gaAccessToken')) throw new Error('no access token run input');
    const c = wf.nodes.find((n) => n.inputs?.action === 'GOOGLE_ANALYTICS_RUN_REPORT');
    if (JSON.stringify(c.inputs.params.metrics) !== '[{"name":"activeUsers"}]') throw new Error(`metrics ${JSON.stringify(c.inputs.params.metrics)}`);
    if (codes(wf).includes('action-pending-publish') || codes(wf).includes('unimplemented-action')) throw new Error('GA runReport is published (google-analytics 0.0.10)');
  },
  'slack-search.json': (wf) => {
    if (!connectorActions(wf).includes('SLACK_SEARCH_MESSAGES')) throw new Error('expected Slack connector action');
    if (JSON.stringify(wf).includes('slackBotToken')) throw new Error('no bot token run input');
    if (codes(wf).includes('action-pending-publish') || codes(wf).includes('unimplemented-action')) throw new Error('Slack search is published (slack 12.1.9)');
    if (!wf.template.conversion.hints.some((h) => /search:read/.test(h))) throw new Error('user token note');
  },
  'llm-http-openai.json': (wf) => {
    if (wf.nodes.some((n) => n.type === 'NodeHttpRequest')) throw new Error('chat completions must not stay HTTP');
    const llm = wf.nodes.find((n) => n.type === 'NodeLlmChain');
    const model = llm && builderOf(wf, llm, 'llm');
    if (!model || model.type !== 'NodeChatModel' || model.inputs.provider !== 'openai' || model.inputs.model !== 'gpt-4o-mini' || model.inputs.temperature !== 0.2) throw new Error(`expected a connected OpenAI Chat Model, got ${JSON.stringify(model?.inputs)}`);
    const sys = runTransform(builderOf(wf, llm, 'system'), {}, { body: {} });
    const msg = runTransform(builderOf(wf, llm, 'prompt'), { body: { question: 'Why?' } });
    if (sys !== 'You are terse.' || msg !== 'Why?') throw new Error(`system ${JSON.stringify(sys)} message ${JSON.stringify(msg)}`);
    const answer = byLabel(wf, 'Answer');
    if (!/\$json\)|\(\$json\)|= \(\$json\)/.test(answer.inputs.jsCode) || /choices/.test(answer.inputs.jsCode.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'))) throw new Error('downstream reads the answer text');
    if (wf.template.setupSecrets?.length || !wf.template.connectors.includes('openai')) throw new Error('Chat Model uses a provider connector credential, not a workflow secret');
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier}`);
  },
  'llm-http-anthropic.json': (wf) => {
    const llm = wf.nodes.find((n) => n.type === 'NodeLlmChain');
    if (!llm || llm.inputs.system !== 'Write haiku.' || llm.inputs.prompt !== 'Autumn in Kyoto') throw new Error(`static body extracted: ${JSON.stringify(llm?.inputs)}`);
    const model = builderOf(wf, llm, 'llm');
    if (model.inputs.provider !== 'anthropic' || model.inputs.model !== 'claude-3-5-sonnet-latest' || model.inputs.maxTokens !== 500) throw new Error('preserve the original provider, model and token limit');
    if (wf.template.tier !== 'experimental' || !wf.template.setup.some((s) => s.includes('add its adapter'))) throw new Error('Anthropic awaits a provider adapter');
    if (JSON.stringify(wf).includes('ANTHROPIC_API_KEY')) throw new Error('no Anthropic key once the call runs on the platform LLM');
  },
  'apify-http.json': (wf) => {
    const c = wf.nodes.find((n) => n.inputs?.action === 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');
    if (!c || c.inputs.params.actorId !== 'apify~website-content-crawler' || c.inputs.params.input.maxCrawlPages !== 3) throw new Error(`params ${JSON.stringify(c?.inputs?.params)}`);
    absent(wf, 'apify_api_1234567890abcdefGHIJ');
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier}`);
  },
  'slack-webhook.json': (wf) => {
    const c = wf.nodes.find((n) => n.inputs?.action === 'SLACK_CHAT_POST_MESSAGE');
    if (!c || c.inputs.params.channel !== '{{slackChannel}}' || c.inputs.params.text !== 'Deploy finished') throw new Error(`params ${JSON.stringify(c?.inputs?.params)}`);
    absent(wf, 'hooks.slack.com');
  },
  'setup-lift.json': (wf) => {
    absent(wf, '1D6tfsAK81ZE6VA0-sd_syuyI_rloNYjgWOhwgszPIZw', 'jane.doe@acme-corp.io', 'api.your-company.example', 'gid=0');
    const keys = wf.template.setupVars.map((v) => v.key).sort();
    for (const k of ['companyBaseUrl', 'recipientEmail', 'sheetName', 'spreadsheetId', 'supabaseProjectRef']) if (!keys.includes(k)) throw new Error(`setup value ${k} (got ${keys})`);
    const ctx = context(wf);
    for (const k of keys) if (ctx[k] !== '') throw new Error(`initialContext.${k} ships empty`);
    const mail = wf.nodes.find((n) => n.inputs?.action === 'GOOGLESUPER_SEND_EMAIL');
    if (mail.inputs.params.recipient_email !== '{{recipientEmail}}') throw new Error('recipient reads the setup value');
    // The empty api_key in the Set step is a workflow secret, not an empty string.
    if (!wf.template.setupSecrets?.some((s) => s.key === 'API_KEY') || !JSON.stringify(byLabel(wf, 'Config').inputs).includes('{{apiKey}}')) throw new Error('empty secret field becomes a workflow secret');
    const ins = wf.nodes.find((n) => n.inputs?.action === 'SUPABASE_INSERT_ROW');
    if (!ins.inputs.params.fields) throw new Error('auto-mapped supabase insert sends the item');
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'http-secret.json': (wf) => {
    absent(wf, 'sk_7f3a9c1e2b4d6f8a0c2e4f6a8b0d2f4a6c8e0a2b');
    const speak = byLabel(wf, 'Speak');
    if (speak.inputs.headers['xi-api-key'] !== '{{elevenlabsApiKey}}') throw new Error(`header ${JSON.stringify(speak.inputs.headers)}`);
    const search = byLabel(wf, 'Search');
    if (!String(search.inputs.url).endsWith('&api_key={{serpapiKey}}')) throw new Error(`query secret ${search.inputs.url}`);
    const ctx = context(wf);
    if (ctx.elevenlabsApiKey?.$workflowSecret !== 'ELEVENLABS_API_KEY' || ctx.serpapiKey?.$workflowSecret !== 'SERPAPI_KEY') throw new Error(`secret refs ${JSON.stringify(ctx)}`);
    const keys = wf.template.setupSecrets.map((x) => `${x.key}|${x.headerFormat}`).sort();
    if (keys.join() !== 'ELEVENLABS_API_KEY|xi-api-key: <secret>,SERPAPI_KEY|query parameter api_key=<secret>') throw new Error(`setupSecrets ${keys}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'cron-activation.json': (wf) => {
    if (!wf.nodes.some((n) => n.type === 'NodeCron' && n.inputs.cronExpression === '0 8 * * *')) throw new Error('expected NodeCron');
    if (wf.template.activation !== 'cdecli cron activate fixture-cron-activation') throw new Error(`activation ${wf.template.activation}`);
    if (!wf.template.setup.includes('After import, start the schedule: cdecli cron activate fixture-cron-activation.')) throw new Error('setup names the activation');
  },
  'gmail-trigger.json': (wf) => {
    const t = wf.nodes.find((n) => n.type === 'NodeCdeWebhookTrigger');
    if (!t || t.inputs.triggerSlug !== 'GOOGLESUPER_NEW_MESSAGE') throw new Error('expected the googlesuper new-message trigger');
    if (codes(wf).join() !== 'webhook-registration' || wf.template.tier !== 'ready') throw new Error(`${wf.template.tier} ${codes(wf)}`);
  },
  'env-shim.json': (wf) => {
    const t = byLabel(wf, 'Build');
    const ctx = { telegramChatId: '42', diskWarnPct: '90' };
    const code = t.inputs.jsCode.replace('{{ctx}}', JSON.stringify(ctx)).replace('{{anthropicApiKey}}', 'sk-test');
    const r = vm.runInNewContext(`(function (source) {\n"use strict";\n${code}\n})`, {})({});
    if (r.chat !== '42' || r.key !== 'sk-test' || r.warn !== 90) throw new Error(`$env from initialContext: ${JSON.stringify(r)}`);
    if (wf.template.setupVars.map((v) => v.key).sort().join() !== 'diskWarnPct,telegramChatId') throw new Error('env values are setup values');
    if (wf.template.setupSecrets.map((v) => v.key).join() !== 'ANTHROPIC_API_KEY') throw new Error('env credentials are workflow secrets');
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'multipart-upload.json': (wf) => {
    // Cloudinary upload goes to the patched CLOUDINARY_UPLOAD action (pending publish), not a multipart HTTP call.
    const c = wf.nodes.find((n) => n.inputs?.action === 'CLOUDINARY_UPLOAD');
    const params = c && (c.inputs.params ?? runTransform(builderOf(wf, c), { data: 'aGk=', mimeType: 'image/png' }));
    if (!params || params.upload_preset !== 'unsigned' || params.resource_type !== 'image' || params.file !== 'data:image/png;base64,aGk=') throw new Error(`params ${JSON.stringify(params)}`);
    if (codes(wf).includes('action-pending-publish') || codes(wf).includes('unimplemented-action')) throw new Error('Cloudinary upload is published (cloudinary 12.1.12)');
  },
  'openai-tts-telegram.json': (wf) => {
    const speak = wf.nodes.find((n) => n.inputs?.action === 'YANTRA_VOICEBOX_SPEAK');
    if (!speak || !/story/.test(JSON.stringify(speak.inputs))) throw new Error('OpenAI audio without an operation is text to speech');
    const send = wf.nodes.find((n) => n.inputs?.action === 'TELEGRAM_SEND_DOCUMENT');
    const params = send.inputs.params ?? runTransform(builderOf(wf, send), { audioUrl: 'https://gcs/a.wav', chatId: 7 });
    if (!/audioUrl|a\.wav/.test(JSON.stringify(params.document))) throw new Error(`document from the generated audio URL: ${JSON.stringify(params)}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'telegram-voice-transcribe.json': (wf) => {
    const t = wf.nodes.find((n) => n.inputs?.action === 'YANTRA_VOICEBOX_TRANSCRIBE');
    if (!t || t.inputs.params.audioUrl !== 'https://api.telegram.org/file/bot{{telegramBotToken}}/{{last.body.result.file_path}}') throw new Error(`audioUrl ${JSON.stringify(t?.inputs)}`);
    if (wf.template.tier !== 'ready') throw new Error(`expected ready, got ${wf.template.tier} ${codes(wf)}`);
  },
  'mysql-query.json': (wf) => {
    const q = wf.nodes.find((n) => n.inputs?.action === 'SUPABASE_BETA_RUN_SQL_QUERY');
    if (!q) throw new Error(`expected Supabase SQL, got ${connectorActions(wf)}`);
    const out = runTransform(builderOf(wf, q), { email: "x' OR '1'='1" }, { supabaseProjectRef: 'ref' });
    if (out.query !== "SELECT * FROM users WHERE email = 'x'' OR ''1''=''1'") throw new Error(`unsafe query ${out.query}`);
    if (codes(wf).includes('hard-approximation')) throw new Error('MySQL SQL on Supabase is a soft approximation');
  },
  'loop-safe.json': (wf) => {
    if (wf.template.conversion.loopPolicy !== 'native') throw new Error(`loopPolicy ${wf.template.conversion.loopPolicy}`);
    const loop = byLabel(wf, 'Loop');
    if (loop.type !== 'NodeLoop') throw new Error('emit a real loop');
    const input = builderOf(wf, loop, 'items');
    const batches = runTransform(input, Array.from({ length: 12 }, (_, i) => i));
    if (batches.map((x) => x.length).join() !== '5,5,2') throw new Error('preserve batches and the final partial batch');
    if (codes(wf).includes('loop-flattened') || wf.template.tier !== 'ready') throw new Error(`${wf.template.tier} ${codes(wf)}`);
  },
};

let failed = 0;
for (const file of fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()) {
  const n8n = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'));
  const info = {
    slug: `fixture-${file.replace(/\.json$/, '')}`,
    name: n8n.name || file,
    description: `Fixture ${file}`,
    category: 'other-integrations',
    categoryLabel: 'Other',
    department: 'Engineering',
    sourcePath: `fixtures/${file}`,
  };
  try {
    const wf = convertWorkflow(n8n, info);
    const check = EXPECT[file];
    if (!check) throw new Error('no EXPECT assertion for fixture');
    check(wf);
    if (!['verified', 'ready', 'experimental'].includes(wf.template.tier)) throw new Error(`bad tier ${wf.template.tier}`);
    if (wf.template.conversion.status !== (wf.template.tier === 'ready' ? 'ready' : 'needs-setup')) throw new Error('status must follow tier');
    console.log(`ok ${file} tier=${wf.template.tier}${wf.template.blockers.length ? ` blockers=${[...new Set(codes(wf))].join(',')}` : ''}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${file}: ${e.message}`);
  }
}
if (failed) process.exit(1);
console.log(`fixtures ok (${Object.keys(EXPECT).length})`);
