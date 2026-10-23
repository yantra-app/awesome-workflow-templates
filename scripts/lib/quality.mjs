// Template quality gate: one place that decides a template's tier, its
// blockers and the setup list a person must work through before it runs.
//
// Used by convert-n8n (to write template.tier / blockers / setup), validate
// (to reject drift), build-index (templates.json and README) and
// report-quality (histograms and the CI ratchet). Everything here is static
// analysis of the template JSON plus the connector catalog; nothing runs.
//
// Tiers (see lib/catalog-fs.mjs TIERS):
//   verified      listed in data/verified.json by a person who ran it end to end
//   ready         runs once its declared setup is supplied: template.setupVars
//                 (initialContext values), template.setupSecrets (workflow
//                 secrets) and connector credentials; no hard blockers
//   experimental  approximations, flattened loops, unpublished connector actions,
//                 or a value the converter could not declare as setup

import { BLOCKERS, PLACEHOLDER_PATTERNS, SAFE_EMAIL_DOMAINS, PENDING_PUBLISH, statusForTier } from './catalog-fs.mjs';
import { CHAT_MODEL_PROVIDERS } from './chat-models.mjs';
import { auditLlmInputs } from './llm-inputs.mjs';

const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_PATTERNS.map((p) => `(?:${p})`).join('|'));
const PLACEHOLDER_G = new RegExp(PLACEHOLDER_RE.source, 'g');

// Params the connector needs although its schema marks them optional: the
// Supabase row actions run SQL through the management API, which is scoped to
// one project ref.
export const EXTRA_REQUIRED = {
  supabase: {
    SUPABASE_INSERT_ROW: ['ref'],
    SUPABASE_SELECT_ROWS: ['ref'],
    SUPABASE_UPDATE_ROW: ['ref'],
    SUPABASE_DELETE_ROW: ['ref'],
    SUPABASE_SEARCH_ROWS: ['ref'],
  },
};

// Actions that need exactly one of several params (the patched file actions take the
// file as a string, as base64 bytes or as a URL the connector downloads).
export const ONE_OF_REQUIRED = {
  telegram: { TELEGRAM_SEND_DOCUMENT: ['document', 'document_base64', 'document_file_url'], TELEGRAM_SEND_PHOTO: ['photo', 'photo_base64', 'photo_file_url'] },
  jira: { JIRA_ADD_ATTACHMENT: ['file_to_upload', 'content_base64', 'file_url'] },
  'yantra-voicebox': { YANTRA_VOICEBOX_TRANSCRIBE: ['audioUrl', 'audioBase64'] },
  dropbox: { DROPBOX_UPLOAD_FILE: ['content', 'content_base64', 'file_url'] },
  googlesuper: { GOOGLESUPER_EDIT_FILE: ['content', 'content_base64', 'file_url'], GOOGLESUPER_UPLOAD_FILE: ['content', 'content_base64', 'file_url'] },
};

const MANUAL_TRIGGERS = new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.start', 'synthetic']);
export const SECRET_NAME = /(?:token|api[_-]?key|apikey|secret|password|passwd|bearer|access[_-]?key|private[_-]?key|credential)/i;
export const AUTH_HEADER = /^(?:authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-n8n-api-key|xi-api-key|x-goog-api-key|x-subscription-token|ocp-apim-subscription-key|x-rapidapi-key|private-token)$/i;
export const AUTH_QUERY = /[?&](?:key|api_key|apikey|token|access_token|auth|appid|app_id|api-key|hapikey)=/i;
// APIs that reject anonymous calls. An HTTP step to one of them needs a credential.
export const AUTH_HOSTS = [
  /(^|\.)api\.github\.com$/,
  /(^|\.)api\.openai\.com$/,
  /(^|\.)api\.anthropic\.com$/,
  /(^|\.)graph\.facebook\.com$/,
  /(^|\.)graph\.instagram\.com$/,
  /(^|\.)api\.notion\.com$/,
  /(^|\.)slack\.com$/,
  /(^|\.)api\.airtable\.com$/,
  /(^|\.)api\.hubapi\.com$/,
  /(^|\.)api\.telegram\.org$/,
  /(^|\.)(?:api\.twitter\.com|api\.x\.com)$/,
  /(^|\.)api\.linkedin\.com$/,
  /(^|\.)api\.pinecone\.io$/,
  /(^|\.)api\.elevenlabs\.io$/,
  /(^|\.)api\.perplexity\.ai$/,
  /(^|\.)openrouter\.ai$/,
  /(^|\.)api\.mistral\.ai$/,
  /(^|\.)api\.groq\.com$/,
  /(^|\.)generativelanguage\.googleapis\.com$/,
  /(^|\.)(?:analyticsdata|sheets|www|gmail|drive|docs|youtube|storage|customsearch|searchconsole|people|calendar)\.googleapis\.com$/,
  /(^|\.)api\.stripe\.com$/,
  /(^|\.)api\.trello\.com$/,
  /(^|\.)api\.clickup\.com$/,
  /(^|\.)api\.sendgrid\.com$/,
  /(^|\.)api\.mailgun\.net$/,
  /(^|\.)api\.replicate\.com$/,
  /(^|\.)api\.firecrawl\.dev$/,
  /(^|\.)api\.apify\.com$/,
  /(^|\.)serpapi\.com$/,
  /(^|\.)api\.tavily\.com$/,
  /(^|\.)api\.brave\.com$/,
  /(^|\.)api\.search\.brave\.com$/,
  /(^|\.)api\.deepseek\.com$/,
  /(^|\.)api\.cohere\.(?:ai|com)$/,
  /(^|\.)api\.together\.xyz$/,
  /(^|\.)api\.assemblyai\.com$/,
  /(^|\.)api\.deepgram\.com$/,
  /(^|\.)api\.zoom\.us$/,
  /(^|\.)api\.calendly\.com$/,
  /(^|\.)api\.todoist\.com$/,
  /(^|\.)api\.monday\.com$/,
  /(^|\.)api\.pipedrive\.com$/,
  /(^|\.)api\.box\.com$/,
  /(^|\.)api\.dropboxapi\.com$/,
  /(^|\.)api\.spotify\.com$/,
  /(^|\.)api\.venafi\.cloud$/,
  /(^|\.)api\.cradl\.ai$/,
  /(^|\.)api\.magichour\.ai$/,
  /(^|\.)commentanalyzer\.googleapis\.com$/,
];
const SERVICE_SENDER = /^(?:no-?reply|do-?not-?reply|notifications?|notify|service|support|billing|alerts?|mailer-daemon|news|newsletter|info-?noreply)$/i;
const FILE_TLDS = /^(?:png|jpe?g|gif|svg|webp|js|mjs|ts|json|css|html?|pdf|txt|md|csv|xml|zip)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,})\b/g;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Strip `//` line comments (converter provenance comments, TODO dumps) from code. */
function codeText(code) {
  return String(code)
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/** [path, string] pairs from a node's inputs (jsCode without comment lines). */
function strings(inputs, prefix = '') {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === 'string') out.push([p, p === 'jsCode' ? codeText(v) : v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(inputs || {}, prefix);
  return out;
}

/** Last key of a dotted path (`params.spreadsheet_id` -> `spreadsheet_id`). */
const leaf = (p) => String(p).replace(/\[\d+\]/g, '').split('.').pop();

/** Values run-context tokens produce at run time never count as literals. */
const withoutTokens = (s) => String(s).replace(/\{\{[\s\S]*?\}\}/g, ' ');

function hostOf(url) {
  const s = withoutTokens(url).trim().replace(/^=/, '');
  const m = /^https?:\/\/([^/?#:\s]+)/i.exec(s);
  return m ? m[1].toLowerCase() : '';
}

const short = (s, n = 60) => {
  const v = String(s);
  return v.length > n ? `${v.slice(0, n - 1)}...` : v;
};

// ---------------------------------------------------------------------------
// literal detectors (shared with the converter, which lifts every finding into
// a declared setup variable or workflow secret)
// ---------------------------------------------------------------------------

const ID_RULES = [
  { kind: 'Google file id', keys: /^(?:spreadsheet_?id|document_?id|file_?id|folder_?id|parent_?id|parents|drive_?id|sheet_?id|presentation_?id|form_?id|template_?id)$/i, value: /^[A-Za-z0-9_-]{25,}$/, needsMix: true },
  { kind: 'Notion id', keys: /^(?:database_?id|page_?id|parent_?id|block_?id|parent_block_id|row_?id)$/i, value: /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i },
  { kind: 'Slack channel id', keys: /^(?:channel|channel_?id)$/i, value: /^[CGD][A-Z0-9]{8,11}$/ },
  { kind: 'Discord id', keys: /^(?:channel_?id|guild_?id)$/i, value: /^\d{17,20}$/ },
  { kind: 'Telegram chat id', keys: /^chat_?id$/i, value: /^(?:-?\d{5,}|@[A-Za-z0-9_]{4,})$/ },
  { kind: 'Google Analytics property id', keys: /^(?:property|property_?id)$/i, value: /^(?:properties\/)?\d{6,}$/ },
];
const ID_ANYWHERE = [
  { kind: 'Google Docs/Sheets id', re: /(?:docs|drive)\.google\.com\/(?:spreadsheets\/d\/|document\/d\/|presentation\/d\/|forms\/d\/|file\/d\/|drive\/folders\/)([A-Za-z0-9_-]{25,})/g },
  { kind: 'Airtable id', re: /\b((?:app|tbl|viw)[A-Za-z0-9]{14})\b/g },
];
const RECIPIENT_KEY = /^(?:recipient_email|to|cc|bcc|to_email|sendTo|toRecipients|email|from)$/i;

/** [start, end) spans of `{{ ... }}` run-context tokens in a string. */
function tokenSpans(s) {
  return [...String(s).matchAll(/\{\{[\s\S]*?\}\}/g)].map((m) => [m.index, m.index + m[0].length]);
}

/**
 * Literal values in one string that a person has to replace: placeholders,
 * author ids and personal email addresses. Each finding carries the exact
 * substring and its offset so the converter can swap it for a `{{var}}` token.
 *
 * @param {string} pathKey  dotted input path (`params.spreadsheet_id`, `jsCode`)
 * @param {string} value
 * @returns {{ code: string, kind: string, text: string, start: number, key?: string }[]}
 */
export function scanLiterals(pathKey, value) {
  const s = String(value);
  const isCode = leaf(pathKey) === 'jsCode';
  const spans = tokenSpans(s);
  // Comment lines (provenance, TODO dumps) never run, so they never count.
  const comment = [];
  if (isCode) {
    let at = 0;
    for (const line of s.split('\n')) {
      if (/^\s*\/\//.test(line)) comment.push([at, at + line.length]);
      at += line.length + 1;
    }
  }
  const blocked = (a, b) => [...spans, ...comment].some(([x, y]) => a < y && b > x);
  const out = [];
  const push = (f) => {
    if (blocked(f.start, f.start + f.text.length)) return;
    if (out.some((o) => o.start === f.start && o.text === f.text)) return;
    out.push(f);
  };

  for (const m of s.matchAll(PLACEHOLDER_G)) {
    // `$env.N8N_HOST` names an environment variable (the $env shim resolves it), not a value.
    const lineStart = s.lastIndexOf('\n', m.index) + 1;
    if (isCode && (/\$env\s*(?:\.\s*|\[\s*['"])$/.test(s.slice(lineStart, m.index)) || /^\s*const \$env = \{/.test(s.slice(lineStart, m.index + 1)))) continue;
    // In code, only a placeholder inside a string literal is a value (`xxxx` in a regex is a pattern).
    if (isCode && !inString(s.slice(0, m.index))) continue;
    // A placeholder used as a field name (`$json.your_email`, `["your_email"]`, `"your_email":`)
    // is the name of a value, not a value: renaming it would break the step.
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/^[\w$]+$/.test(m[0]) && (/\.$/.test(before) || (/\[["'`]$/.test(before) && /^["'`]\]/.test(after)) || /^["'`]?\s*:(?!\/)/.test(after))) continue;
    // `/OWNER` style fallbacks: the slash is context, the word is the placeholder.
    const text = m[0].replace(/^\//, '');
    push({ code: 'placeholder', kind: 'placeholder', text, start: m.index + (m[0].length - text.length) });
  }

  // A whole value that is an id under an id-like key (`spreadsheet_id: "1AbC..."`).
  const lead = /^=/.test(s) ? 1 : 0;
  const whole = s.slice(lead).trim();
  if (!isCode && !/\{\{/.test(whole)) {
    const key = leaf(pathKey);
    for (const r of ID_RULES) {
      if (r.keys.test(key) && r.value.test(whole) && (!r.needsMix || (/\d/.test(whole) && /[A-Za-z]/.test(whole)))) push({ code: 'upstream-literal-id', kind: r.kind, text: whole, start: s.indexOf(whole), key });
    }
  }
  // Ids assigned inside generated code (`"spreadsheetId": "1AbC..."`).
  if (isCode) {
    for (const m of s.matchAll(/["']?([A-Za-z_]+)["']?\s*[:=]\s*["'`]([^"'`\n]{5,80})["'`]/g)) {
      const v = m[2];
      for (const r of ID_RULES) {
        if (r.keys.test(m[1]) && r.value.test(v) && (!r.needsMix || (/\d/.test(v) && /[A-Za-z]/.test(v)))) push({ code: 'upstream-literal-id', kind: r.kind, text: v, start: m.index + m[0].lastIndexOf(v), key: m[1] });
      }
    }
  }
  for (const r of ID_ANYWHERE) {
    for (const m of s.matchAll(r.re)) push({ code: 'upstream-literal-id', kind: r.kind, text: m[1], start: m.index + m[0].indexOf(m[1]) });
  }

  for (const m of s.matchAll(EMAIL_RE)) {
    const email = m[0];
    const [local, domain] = email.split('@');
    if (FILE_TLDS.test(m[1])) continue;
    if (SAFE_EMAIL_DOMAINS.test(domain)) {
      // A documentation address used as the actual recipient still has to be replaced.
      if (RECIPIENT_KEY.test(leaf(pathKey))) push({ code: 'placeholder', kind: 'placeholder address', text: email, start: m.index, key: leaf(pathKey) });
      continue;
    }
    // Shared calendars are the author's resource ids, not a person's address.
    if (/\.calendar\.google\.com$/i.test(domain)) {
      push({ code: 'upstream-literal-id', kind: 'Google Calendar id', text: email, start: m.index });
      continue;
    }
    // Service senders used as mail filters (no-reply@..., service@paypal...) are not personal data.
    if (SERVICE_SENDER.test(local)) continue;
    push({ code: 'personal-email', kind: 'email', text: email, start: m.index, key: leaf(pathKey) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Is the end of this line prefix inside a '...', "..." or `...` string (template holes `${...}` are code)? */
function inString(prefix) {
  const stack = []; // open strings / template holes: '"', "'", '`', or '{' for a hole
  let depth = 0; // braces inside the innermost hole
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      if (c === '\\') i++;
      else if (c === top) stack.pop();
    } else if (top === '`') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && prefix[i + 1] === '{') {
        stack.push('{');
        depth = 0;
        i++;
      }
    } else {
      if (c === '/' && prefix[i + 1] === '/') {
        const nl = prefix.indexOf('\n', i);
        if (nl === -1) break;
        i = nl;
        continue;
      }
      if (c === '/' && prefix[i + 1] === '*') {
        const end = prefix.indexOf('*/', i + 2);
        if (end === -1) break;
        i = end + 1;
        continue;
      }
      // A regex literal after an operator or bracket: skip it so quotes inside do not count.
      if (c === '/' && /[=(,:!&|?{};\[\n]\s*$/.test(prefix.slice(Math.max(0, i - 20), i))) {
        let j = i + 1;
        let cls = false;
        for (; j < prefix.length && prefix[j] !== '\n'; j++) {
          if (prefix[j] === '\\') j++;
          else if (prefix[j] === '[') cls = true;
          else if (prefix[j] === ']') cls = false;
          else if (prefix[j] === '/' && !cls) break;
        }
        if (j < prefix.length && prefix[j] === '/') {
          i = j;
          continue;
        }
      }
      if (c === '"' || c === "'" || c === '`') stack.push(c);
      else if (top === '{' && c === '{') depth++;
      else if (top === '{' && c === '}') {
        if (depth === 0) stack.pop();
        else depth--;
      }
    }
  }
  const top = stack[stack.length - 1];
  return top === '"' || top === "'" || top === '`';
}

const isSecretRef = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$workflowSecret === 'string' && v.$workflowSecret.trim() !== '';

/** Hosts of HTTP steps, for the setup list and the index. */
export function httpHost(url) {
  return hostOf(url);
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * @param {object} wf       template JSON (nodes, edges, template block)
 * @param {object} ctx      { catalog (data/connector-actions.json), verified (Map path -> entry), path }
 * @returns {{ tier: string, status: string, blockers: object[], setup: string[] }}
 */
export function evaluate(wf, { catalog, verified = new Map(), path: relPath } = {}) {
  const blockers = [];
  const add = (code, node, detail, setup) => blockers.push({ code, node: node || undefined, detail, setup: setup === undefined ? detail : setup });
  const meta = wf.template || {};
  const conv = meta.conversion || {};
  const nodesMeta = meta.nodes || {};
  const byId = new Map((wf.nodes || []).map((n) => [n.nodeId, n]));
  const fedBy = (nodeId, socket) =>
    (wf.edges || []).filter((e) => e.target === nodeId && e.targetInput === socket).map((e) => byId.get(e.source)).filter(Boolean);
  const nameOf = (n) => nodesMeta[n.nodeId]?.n8n || n.label;
  const connectors = catalog?.connectors || {};
  const cfg = (wf.nodes || []).find((n) => n.type === 'NodeWorkflowConfigs');
  const context = cfg?.inputs?.initialContext && typeof cfg.inputs.initialContext === 'object' ? cfg.inputs.initialContext : {};
  const setupVars = Array.isArray(meta.setupVars) ? meta.setupVars : [];
  const setupSecrets = Array.isArray(meta.setupSecrets) ? meta.setupSecrets : [];
  const declared = new Set(setupVars.map((v) => v.key));
  const secretContextKeys = new Set(Object.entries(context).filter(([, v]) => isSecretRef(v)).map(([k]) => k));

  for (const row of auditLlmInputs(wf)) for (const issue of row.problems) {
    add('missing-required-param', row.label, `LLM input mismatch: ${issue.detail}`,
      `"${row.label}": wire the intended ${issue.socket} data from "${issue.source || 'the upstream step'}" and correct ${issue.path} before running.`);
  }

  for (const n of wf.nodes || []) {
    const name = nameOf(n);
    const inputs = n.inputs || {};

    if (n.type === 'NodeChatModel' && !CHAT_MODEL_PROVIDERS.has(inputs.provider)) {
      add('missing-required-param', name, `Chat Model provider ${inputs.provider || '(unset)'} is not supported by the current node catalog`,
        `"${name}": the original provider "${inputs.provider || '(unset)'}" and model are preserved. Select a supported Chat Model provider and matching model, or add its adapter in Yantra before running.`);
    }

    if (n.type === 'NodeCdeConnector') {
      const c = inputs.connectorName;
      const a = inputs.action;
      const def = connectors[c]?.actions?.[a];
      if (!def || def.unimplemented || connectors[c]?.unpublished) {
        const pending = PENDING_PUBLISH[`${c}/${a}`];
        if (pending) add('action-pending-publish', name, `${c}/${a} waits for the ${pending} to be published`, `"${name}": ${c}/${a} comes from the ${pending}, which is not published yet; this step fails until it ships, then the template promotes on the next catalog refresh.`);
        else add('unimplemented-action', name, `${c}/${a} is not published in the connector registry`, `"${name}": ${c}/${a} is not published in the connector registry yet; this step fails until the connector ships it.`);
      }
      const required = [...(def?.params || []).filter((k) => k.startsWith('*')).map((k) => k.slice(1)), ...(EXTRA_REQUIRED[c]?.[a] || [])];
      const params = inputs.params && typeof inputs.params === 'object' ? inputs.params : {};
      const builders = fedBy(n.nodeId, 'params').map((b) => String(b.inputs?.jsCode || ''));
      // Params a written but unpublished patch adds to a published action (catalog pendingParams).
      if (def && !def.unimplemented && def.pendingParams?.length) {
        const uses = def.pendingParams.filter((k) => !isEmpty(params[k]) || builders.some((code) => new RegExp(`(?:"${k}"|'${k}')\\s*:`).test(codeText(code))));
        if (uses.length) {
          const patch = PENDING_PUBLISH[`${c}/${a}`] || `${c} patch`;
          add('action-pending-publish', name, `${c}/${a} ${uses.join(', ')} waits for the ${patch} to be published`, `"${name}": ${c}/${a} sends ${uses.join(', ')}, which the ${patch} adds and which is not published yet; this step fails until it ships, then the template promotes on the next catalog refresh.`);
        }
      }
      const missing = [...new Set(required)].filter((k) => {
        if (!isEmpty(params[k])) return false;
        return !builders.some((code) => new RegExp(`(?:"${k}"|'${k}'|(?<![\\w$."'])${k})\\s*:\\s*(?!""|''|null\\b|undefined\\b|,|\\n)`).test(code));
      });
      const oneOf = ONE_OF_REQUIRED[c]?.[a];
      if (oneOf && oneOf.every((k) => isEmpty(params[k]) && !builders.some((code) => new RegExp(`(?:"${k}"|'${k}'|(?<![\\w$."'])${k})\\s*:\\s*(?!""|''|null\\b|undefined\\b|,|\\n)`).test(code)))) missing.push(oneOf.join(' | '));
      if (missing.length) add('missing-required-param', name, `${c}/${a} needs ${missing.join(', ')}`, `"${name}": set ${missing.join(', ')} on ${c}/${a}.`);
    }

    if (n.type === 'NodeCdeWebhookTrigger') {
      const missing = ['webhookEndpointId', 'connectedAccountId'].filter((k) => isEmpty(inputs[k]) && !fedBy(n.nodeId, k).length);
      if (missing.length) {
        add(
          'webhook-registration',
          name,
          `webhook trigger ${inputs.connector}/${inputs.triggerSlug} needs ${missing.join(', ')}`,
          `"${name}": after import, register the ${inputs.connector} webhook (\`cdecli webhook endpoint create -c ${inputs.connector}\`, then \`cdecli trigger instance upsert --slug ${inputs.triggerSlug}\`) and set ${missing.join(', ')} on the trigger node.`,
        );
      }
    }

    // An HTTP call: the HTTP node, or the yantra-storage HTTP_SEND action that sends
    // multipart / form / raw / binary bodies. Both need the API credential in a header.
    const checkHttp = ({ url, urlCode, headers, headerCodes }) => {
      const text = isEmpty(url) ? urlCode : String(url);
      const host = hostOf(isEmpty(url) ? (/https?:\/\/[^\s'"`]+/.exec(urlCode)?.[0] ?? '') : url);
      const authed =
        Object.entries(headers).some(([k, v]) => (AUTH_HEADER.test(k) || /token|key|auth/i.test(k)) && (isSecretRef(v) || /\{\{/.test(String(v)) || !isEmpty(v))) ||
        headerCodes.some((code) => /authorization|api[-_]?key|token/i.test(code)) ||
        AUTH_QUERY.test(text) ||
        /api\.telegram\.org\/(?:file\/)?bot[^/]/.test(text) ||
        // The bot token travels as the first path segment (`/bot<token>/...`) from a step that holds it.
        /api\.telegram\.org\/\{\{[^}]*token[^}]*\}\}/i.test(text);
      const original = nodesMeta[n.nodeId]?.auth;
      if (!authed && (original || (host && AUTH_HOSTS.some((re) => re.test(host))))) {
        add(
          'http-auth-missing',
          name,
          `${host || 'HTTP request'} needs ${original ? `the ${original} credential` : 'an API credential'}`,
          `"${name}": ${host || 'this API'} needs authentication${original ? ` (the original used ${original})` : ''}. Add the Authorization header, or replace the step with that service's connector.`,
        );
      }
      // A literal credential in a header ships someone's secret with the template.
      for (const [k, v] of Object.entries(headers)) {
        if (!(AUTH_HEADER.test(k) || /token|key/i.test(k)) || typeof v !== 'string' || /\{\{/.test(v)) continue;
        const secret = v.replace(/^(?:Bearer|Basic|Token)\s*/i, '').trim();
        if (!secret || /\$[A-Z_]{3,}|<[^>]*>|\[[^\]]*\]|\*{3,}|your|insert|replace|change/i.test(secret)) {
          if (!PLACEHOLDER_RE.test(v)) add('placeholder', name, `placeholder credential in header ${k}`, `"${name}": header ${k} holds a placeholder credential; set your own.`);
        } else if (!PLACEHOLDER_RE.test(v)) {
          add('secret-as-input', name, `literal credential in header ${k}`, `"${name}": header ${k} holds a literal credential; move it to a workflow secret.`);
        }
      }
    };

    if (n.type === 'NodeHttpRequest') {
      const urlBuilders = fedBy(n.nodeId, 'url');
      if (isEmpty(inputs.url) && !urlBuilders.length) add('missing-required-param', name, 'HTTP request has no URL', `"${name}": set the request URL.`);
      checkHttp({
        url: inputs.url,
        urlCode: urlBuilders.map((b) => String(b.inputs?.jsCode || '')).join('\n'),
        headers: inputs.headers && typeof inputs.headers === 'object' ? inputs.headers : {},
        headerCodes: fedBy(n.nodeId, 'headers').map((b) => String(b.inputs?.jsCode || '')),
      });
    }
    if (n.type === 'NodeCdeConnector' && inputs.connectorName === 'yantra-storage' && inputs.action === 'YANTRA_STORAGE_HTTP_SEND') {
      const params = inputs.params && typeof inputs.params === 'object' ? inputs.params : {};
      const codes = fedBy(n.nodeId, 'params').map((b) => codeText(b.inputs?.jsCode || ''));
      checkHttp({ url: params.url, urlCode: codes.join('\n'), headers: params.headers && typeof params.headers === 'object' ? params.headers : {}, headerCodes: codes });
    }

    if (n.type === 'NodeTransform') {
      const code = codeText(inputs.jsCode || '');
      // n8n $env has no Yantra equivalent: unless the converter rebuilt it from the
      // initialContext (setup values / secrets), the shim is empty and the value undefined.
      const envShim = /^const \$env = \{ (.*) \};$/m.exec(code)?.[1] || '';
      for (const m of code.matchAll(/\$env\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/g)) {
        const key = m[1] || m[2];
        if (envShim.includes(`${JSON.stringify(key)}:`)) continue;
        if (SECRET_NAME.test(key)) add('secret-as-input', name, `$env.${key}`, `"${name}" reads $env.${key}, which Yantra does not provide; supply it from a workflow secret (never in chat).`);
        else add('missing-required-param', name, `$env.${key}`, `"${name}" reads $env.${key}, which Yantra does not provide; set the value in this step.`);
      }
      // A Set-style config step that leaves a secret empty.
      for (const m of code.matchAll(/out\[\s*(["'])([^"'\]]+)\1\s*\]\s*=\s*(?:""|'')\s*;/g)) {
        if (SECRET_NAME.test(m[2])) add('secret-as-input', name, `empty ${m[2]}`, `"${name}": ${m[2]} is empty in the template; supply it from a workflow secret (never in chat).`);
      }
    }

    // A Sheets range still pointing at a tab id (gid=0) rather than a tab name.
    for (const [p, s] of strings(inputs.params || {})) {
      if (/^(?:range|ranges|sheet_name)$/.test(leaf(p)) && /^gid=\d+$/.test(String(s))) add('missing-required-param', name, `sheet ${s}`, `"${name}": set the sheet tab name (the original stored ${s}).`);
    }

    // Placeholders, literal ids and personal emails in any input.
    const walkRaw = (v, p) => {
      if (typeof v === 'string') {
        if (p === 'connectorName' || p === 'connectorLabel' || p === 'action' || p === 'type') return;
        for (const f of scanLiterals(p, v)) {
          if (f.code === 'placeholder') add('placeholder', name, f.kind === 'placeholder address' ? `placeholder address ${f.text}` : `placeholder ${f.text}`, `"${name}": replace the ${f.kind} ${f.text}.`);
          else if (f.code === 'upstream-literal-id') add('upstream-literal-id', name, `${f.kind} ${short(f.text, 24)}`, `"${name}": replace the original author's ${f.kind} ${short(f.text, 24)} with your own.`);
          else add('personal-email', name, `email ${f.text}`, `"${name}": replace the email address ${f.text} (from the original template) with your own.`);
        }
      } else if (Array.isArray(v)) v.forEach((x, i) => walkRaw(x, `${p}[${i}]`));
      else if (v && typeof v === 'object' && !isSecretRef(v)) for (const [k, x] of Object.entries(v)) walkRaw(x, p ? `${p}.${k}` : k);
    };
    if (n.type !== 'NodeWorkflowConfigs') walkRaw(inputs, '');
  }

  // Secrets passed as plain values (visible in run logs and the run form).
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_NAME.test(key) && !isSecretRef(value)) {
      add('secret-as-input', undefined, `run input ${key}`, `Run input "${key}" carries a secret as a plain value; make it a workflow secret reference ({"$workflowSecret": "KEY"}) and add the secret in the editor, never in chat.`);
    }
  }
  // Declared setup values must exist in the initialContext and never be a literal from the original.
  for (const v of setupVars) {
    if (!(v.key in context)) add('missing-required-param', undefined, `setup value ${v.key} is not in initialContext`, `Setup value "${v.key}" is declared but missing from the Workflow Configs initialContext.`);
    else for (const f of scanLiterals(v.key, String(context[v.key] ?? ''))) if (f.code !== 'placeholder') add(f.code, undefined, `setup value ${v.key} holds ${f.kind} ${short(f.text, 24)}`, `Setup value "${v.key}" still holds a value from the original template.`);
  }

  // Conversion report: approximations, loops, stubs, triggers.
  for (const a of conv.approximate || []) {
    // `reason` (optional) says precisely why a mapping is not faithful.
    const why = a.reason ? `: ${a.reason}` : '';
    if (a.blocker === 'signature-verification') add(a.blocker, a.node, `${a.n8n}${why}`, a.reason ? `"${a.node}" (${a.n8n}): ${a.reason}.` : `"${a.node}" (${a.n8n}): the Transform runtime has no crypto digest, so this step stops the run instead of faking one. Verify signatures before the workflow (webhook connector) or compute hashes in a connector step.`);
    else if (a.blocker && BLOCKERS[a.blocker]) add(a.blocker, a.node, `${a.n8n}${why}`, `"${a.node}" (${a.n8n}) needs attention before it runs${why}.`);
    else if (!a.soft) add('hard-approximation', a.node, `${a.n8n} -> ${a.action}${why}`, a.reason ? `"${a.node}" (${a.n8n}): ${a.reason}; review it before relying on the result.` : `"${a.node}" (${a.n8n}) only approximates the original; review it before relying on the result.`);
  }
  // Stub nodes are reported as unmapped-node already; their TODO dump is not a second finding.
  const text = JSON.stringify((wf.nodes || []).filter((n) => !nodesMeta[n.nodeId]?.stub));
  if (text.includes('TODO(yantra)')) add('hard-approximation', undefined, 'TODO(yantra) left in a step', 'A step still contains TODO(yantra); finish it before running.');
  if (text.includes('<<n8n:')) add('hard-approximation', undefined, '<<n8n: ...>> marker left in a step', 'Replace the values marked <<n8n: ...>> by hand.');
  if (conv.loopPolicy === 'flattened' || ((conv.removedEdges || []).length && conv.loopPolicy !== 'flattened-safe')) {
    const loops = (conv.removedEdges || []).map((e) => `${e.from} -> ${e.to}`).join(', ');
    add('loop-flattened', undefined, `loop edges removed: ${loops}`, `The original looped (${short(loops, 120)}); here the whole list flows through once. Check the steps inside the loop handle arrays.`);
  }
  for (const u of conv.unmapped || []) add('unmapped-node', u.node, `${u.type}: ${u.reason}`, `"${u.node}" is a TODO stub (${u.reason}).`);
  for (const t of conv.triggers || []) {
    if (t.as === 'NodeStart' && !MANUAL_TRIGGERS.has(t.type)) {
      add('trigger-replaced', t.node, `${t.type} became the Start node`, `"${t.node}" (${String(t.type).replace(/^.*\./, '')}) started the original; run this workflow on demand, through the workflow API, or add a schedule.`);
    }
  }

  // De-duplicate and order: blocker registry order, then node, then detail.
  const order = Object.keys(BLOCKERS);
  const seen = new Set();
  const unique = blockers
    .filter((b) => {
      const k = `${b.code}|${b.node || ''}|${b.detail}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => order.indexOf(x.code) - order.indexOf(y.code) || String(x.node || '').localeCompare(String(y.node || '')) || x.detail.localeCompare(y.detail));

  const blocking = unique.filter((b) => BLOCKERS[b.code].blocking);
  let tier = blocking.some((b) => BLOCKERS[b.code].tier === 'experimental') ? 'experimental' : 'ready';
  if (relPath && verified.has(relPath) && tier !== 'experimental') tier = 'verified';

  // Setup: what the person must provide, most specific first.
  const setup = [];
  const push = (s) => {
    if (s && !setup.includes(s)) setup.push(s);
  };
  for (const b of unique) push(b.setup);
  for (const v of setupVars) push(`Setup value ${v.key}: ${v.label}${v.example ? ` (for example ${v.example})` : ''}. Write it into the Workflow Configs initialContext before import.`);
  for (const s of setupSecrets) push(`Workflow secret ${s.key}: ${s.label}${s.host ? ` for ${s.host}` : ''} (${s.headerFormat}). Add it in the workflow editor's Secrets panel after import; never paste it in chat.`);
  for (const c of meta.connectors || []) if (!String(c).startsWith('yantra-')) push(`Connect the ${c} connector (credential).`);
  if (meta.activation) push(`After import, start the schedule: ${meta.activation}.`);
  // Run inputs: the seeded keys plus any top-level run-context key a step reads (`{{message.text}}`),
  // minus declared setup values and secrets.
  const read = new Set();
  for (const n of wf.nodes || []) {
    if (n.type === 'NodeWorkflowConfigs') continue;
    for (const [, s] of strings(n.inputs)) for (const m of s.matchAll(/\{\{\s*([A-Za-z_$][\w$]*)/g)) if (!['last', 'steps', 'ctx'].includes(m[1])) read.add(m[1]);
  }
  const seeds = Object.keys(context);
  const plainSeeds = [...seeds, ...[...read].filter((k) => !seeds.includes(k)).sort()].filter((k) => !SECRET_NAME.test(k) && !declared.has(k) && !secretContextKeys.has(k));
  if (plainSeeds.length) push(`Provide run inputs: ${plainSeeds.join(', ')}.`);

  return {
    tier,
    status: statusForTier(tier),
    blockers: unique.map(({ code, node, detail }) => (node ? { code, node, detail } : { code, detail })),
    setup,
  };
}

/** Blocker codes of an evaluation, sorted and unique (for the index). */
export function blockerCodes(result) {
  return [...new Set(result.blockers.map((b) => b.code))].sort((a, b) => Object.keys(BLOCKERS).indexOf(a) - Object.keys(BLOCKERS).indexOf(b));
}
