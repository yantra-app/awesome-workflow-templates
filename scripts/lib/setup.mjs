// Setup variables and workflow secrets.
//
// Every value a person has to provide before a template runs is declared, not
// left in a step:
//
//   setup variable   a named key in the Workflow Configs `initialContext`
//                    (empty in the template), read by steps as `{{key}}` and
//                    described in `template.setupVars[]`. Author ids, personal
//                    emails, placeholders and missing connector params all
//                    become setup variables, so the original values never ship.
//   workflow secret  `initialContext.<key> = {"$workflowSecret": "KEY"}` and a
//                    step input such as `"Authorization": "Bearer {{key}}"`; the
//                    engine materialises the secret at run time and redacts it
//                    from outputs and logs (workflow-editor-core
//                    workflow-secrets.js, run-context.js). The secret itself is
//                    added in the workflow editor after import and is described
//                    in `template.setupSecrets[]`. No token is ever in the JSON.
//
// The converter owns one SetupRegistry per template.

import { scanLiterals, SECRET_NAME, AUTH_HEADER } from './quality.mjs';

/** Run-context keys the engine reserves (run-context.js RESERVED_RUN_CONTEXT_KEYS) plus `ctx`. */
const RESERVED = new Set(['steps', 'last', 'inputs', 'runId', 'run', 'iteration', 'webhook', 'cron', 'workflowConfig', 'ctx']);

export function camel(s) {
  const words = String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  const out = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');
  return /^\d/.test(out) ? `v${out}` : out;
}

export const upperSnake = (s) =>
  String(s)
    // Split camelCase only when there is any lowercase (N8N_API_KEY stays as is).
    .replace(/([a-z0-9])([A-Z])/g, (m, a, b) => (/[a-z]/.test(String(s)) ? `${a}_${b}` : m))
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

/**
 * Setup variable names for connector params the user must supply (ids, refs,
 * channels, recipients). Content params (text, files, urls of the data being
 * processed) are never setup: a static value there would not be the same
 * workflow, so those stay a `missing-required-param` blocker.
 */
const PARAM_VARS = [
  { re: /^ref$/, key: (c) => (c === 'supabase' ? 'supabaseProjectRef' : 'projectRef'), label: 'Supabase project ref (Settings > General)', type: 'id', example: 'abcdefghijklmnopqrst' },
  { re: /^(?:spreadsheet_?id|spreadsheetId)$/i, key: () => 'spreadsheetId', label: 'Google Sheets spreadsheet id (from the sheet URL)', type: 'id', example: '1AbC...xyz' },
  { re: /^(?:range|sheet_name)$/i, key: () => 'sheetName', label: 'Sheet tab name', type: 'text', example: 'Sheet1' },
  { re: /^channel$/i, key: (c) => (c === 'slack' ? 'slackChannel' : 'channel'), label: 'Slack channel (name or id)', type: 'channel', example: '#general' },
  { re: /^channel_?id$/i, key: (c) => (c === 'discordbot' ? 'discordChannelId' : camel(`${c} channel id`)), label: 'Channel id', type: 'id', example: '123456789012345678' },
  { re: /^guild_?id$/i, key: () => 'discordGuildId', label: 'Discord server (guild) id', type: 'id', example: '123456789012345678' },
  { re: /^chat_?id$/i, key: (c) => (c === 'telegram' ? 'telegramChatId' : 'chatId'), label: 'Telegram chat id (from @userinfobot or getUpdates)', type: 'id', example: '123456789' },
  { re: /^baseId$/i, key: () => 'airtableBaseId', label: 'Airtable base id', type: 'id', example: 'appXXXX (from the base URL)' },
  { re: /^tableIdOrName$/i, key: () => 'airtableTable', label: 'Airtable table name or id', type: 'text', example: 'Table 1' },
  { re: /^(?:recipient_email|to_email|sendTo|to)$/i, key: () => 'recipientEmail', label: 'Recipient email address', type: 'email', example: 'you@example.com' },
  { re: /^companyDomain$/i, key: () => 'bamboohrCompanyDomain', label: 'BambooHR company subdomain', type: 'text', example: 'acme' },
  { re: /^phone_number_id$/i, key: () => 'whatsappPhoneNumberId', label: 'WhatsApp Business phone number id', type: 'id', example: '123456789012345' },
  { re: /^to_number$/i, key: () => 'recipientPhone', label: 'Recipient phone number (E.164)', type: 'text', example: '+15551234567' },
  { re: /^template_name$/i, key: () => 'whatsappTemplateName', label: 'WhatsApp message template name', type: 'text', example: 'hello_world' },
  { re: /^(?:database_?id)$/i, key: (c) => camel(`${c} database id`), label: 'Database id', type: 'id', example: '' },
  { re: /^(?:parent_?id|page_?id)$/i, key: (c) => camel(`${c} page id`), label: 'Parent page id', type: 'id', example: '' },
  { re: /^collection_id$/i, key: (c) => camel(`${c} collection id`), label: 'Collection id', type: 'id', example: '' },
  { re: /^(?:Bucket|bucket)$/, key: () => 's3Bucket', label: 'S3 bucket name', type: 'text', example: 'my-bucket' },
  { re: /^author$/i, key: () => 'linkedinAuthorUrn', label: 'LinkedIn author URN', type: 'id', example: 'urn:li:person:XXXX' },
  { re: /^index_host$|^indexHost$/, key: () => 'pineconeIndexHost', label: 'Pinecone index host (an index with integrated embedding, field map text)', type: 'url', example: 'my-index-abc123.svc.aped-4627-b74a.pinecone.io' },
  { re: /^eventTemplateId$/, key: () => 'hubspotEventTemplateId', label: 'HubSpot timeline event template id', type: 'id', example: '' },
  { re: /^actorId$/, key: () => 'apifyActorId', label: 'Apify actor id', type: 'id', example: 'apify~web-scraper' },
];

/** A setup variable for a missing connector param, or null for content params. */
export function paramVar(connector, param) {
  const r = PARAM_VARS.find((x) => x.re.test(param));
  if (!r) return null;
  return { key: r.key(connector), label: r.label, type: r.type, example: r.example };
}

/**
 * Secrets per API host: which header carries the credential and how. `format`
 * is the header value with `{v}` standing for the secret. `query` puts the
 * secret in a query parameter instead (Google API keys, SerpApi, ScrapingBee).
 * `oauth: true` marks an OAuth access token (expires; prefer the connector).
 */
export const HOST_AUTH = [
  { re: /(^|\.)api\.openai\.com$/, key: 'OPENAI_API_KEY', label: 'OpenAI API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)openrouter\.ai$/, key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.anthropic\.com$/, key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', header: 'x-api-key', format: '{v}' },
  { re: /(^|\.)api\.mistral\.ai$/, key: 'MISTRAL_API_KEY', label: 'Mistral API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.deepseek\.com$/, key: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.perplexity\.ai$/, key: 'PERPLEXITY_API_KEY', label: 'Perplexity API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.groq\.com$/, key: 'GROQ_API_KEY', label: 'Groq API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)generativelanguage\.googleapis\.com$/, key: 'GEMINI_API_KEY', label: 'Gemini API key', header: 'x-goog-api-key', format: '{v}' },
  { re: /(^|\.)api\.voyageai\.com$/, key: 'VOYAGE_API_KEY', label: 'Voyage AI API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.apify\.com$/, key: 'APIFY_TOKEN', label: 'Apify API token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.firecrawl\.dev$/, key: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.elevenlabs\.io$/, key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', header: 'xi-api-key', format: '{v}' },
  { re: /(^|\.)cloud\.leonardo\.ai$/, key: 'LEONARDO_API_KEY', label: 'Leonardo AI API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.dev\.runwayml\.com$/, key: 'RUNWAY_API_KEY', label: 'Runway API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)queue\.fal\.run$/, key: 'FAL_KEY', label: 'fal.ai API key', header: 'Authorization', format: 'Key {v}' },
  { re: /(^|\.)api\.cloud\.llamaindex\.ai$/, key: 'LLAMA_CLOUD_API_KEY', label: 'LlamaCloud API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)(?:api|content)\.airtable\.com$/, key: 'AIRTABLE_TOKEN', label: 'Airtable personal access token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.github\.com$/, key: 'GITHUB_TOKEN', label: 'GitHub token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.notion\.com$/, key: 'NOTION_TOKEN', label: 'Notion integration token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)slack\.com$/, key: 'SLACK_BOT_TOKEN', label: 'Slack bot token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.hubapi\.com$/, key: 'HUBSPOT_TOKEN', label: 'HubSpot private app token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.baserow\.io$/, key: 'BASEROW_TOKEN', label: 'Baserow database token', header: 'Authorization', format: 'Token {v}' },
  { re: /(^|\.)api\.printify\.com$/, key: 'PRINTIFY_TOKEN', label: 'Printify API token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)app\.pennylane\.com$/, key: 'PENNYLANE_TOKEN', label: 'Pennylane API token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.fastmail\.com$/, key: 'FASTMAIL_TOKEN', label: 'Fastmail API token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.creatomate\.com$/, key: 'CREATOMATE_API_KEY', label: 'Creatomate API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)r\.jina\.ai$/, key: 'JINA_API_KEY', label: 'Jina AI API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.bfl\.ml$/, key: 'BFL_API_KEY', label: 'Black Forest Labs API key', header: 'x-key', format: '{v}' },
  { re: /(^|\.)api\.exa\.ai$/, key: 'EXA_API_KEY', label: 'Exa API key', header: 'x-api-key', format: '{v}' },
  { re: /(^|\.)api\.replicate\.com$/, key: 'REPLICATE_API_TOKEN', label: 'Replicate API token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.cloudflare\.com$/, key: 'CLOUDFLARE_API_TOKEN', label: 'Cloudflare API token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.lemlist\.com$/, key: 'LEMLIST_BASIC_AUTH', label: 'lemlist API key as Basic auth (base64 of ":<api key>")', header: 'Authorization', format: 'Basic {v}' },
  { re: /(^|\.)hcti\.io$/, key: 'HCTI_BASIC_AUTH', label: 'htmlcsstoimage credentials as Basic auth (base64 of "<user id>:<api key>")', header: 'Authorization', format: 'Basic {v}' },
  { re: /(^|\.)graph\.facebook\.com$/, key: 'FACEBOOK_ACCESS_TOKEN', label: 'Facebook Page or Instagram access token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)graph\.microsoft\.com$/, key: 'MICROSOFT_GRAPH_TOKEN', label: 'Microsoft Graph OAuth access token', header: 'Authorization', format: 'Bearer {v}', oauth: true },
  { re: /(^|\.)api\.zoom\.us$/, key: 'ZOOM_ACCESS_TOKEN', label: 'Zoom OAuth access token', header: 'Authorization', format: 'Bearer {v}', oauth: true },
  { re: /(^|\.)(?:meet|sheets|gmail|drive|docs|analyticsdata|searchconsole|people|calendar|storage)\.googleapis\.com$/, key: 'GOOGLE_OAUTH_TOKEN', label: 'Google OAuth access token', header: 'Authorization', format: 'Bearer {v}', oauth: true },
  { re: /(^|\.)storage\.googleapis\.com$/, key: 'GOOGLE_OAUTH_TOKEN', label: 'Google OAuth access token', header: 'Authorization', format: 'Bearer {v}', oauth: true },
  { re: /(^|\.)api\.linear\.app$/, key: 'LINEAR_API_KEY', label: 'Linear API key', header: 'Authorization', format: '{v}' },
  { re: /(^|\.)api(?:-data)?\.line\.me$/, key: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'LINE channel access token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.spotify\.com$/, key: 'SPOTIFY_ACCESS_TOKEN', label: 'Spotify OAuth access token', header: 'Authorization', format: 'Bearer {v}', oauth: true },
  { re: /(^|\.)api\.pinterest\.com$/, key: 'PINTEREST_ACCESS_TOKEN', label: 'Pinterest access token', header: 'Authorization', format: 'Bearer {v}', oauth: true },
  { re: /(^|\.)api\.cradl\.ai$/, key: 'CRADL_API_KEY', label: 'Cradl AI API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.magichour\.ai$/, key: 'MAGIC_HOUR_API_KEY', label: 'Magic Hour API key', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.venafi\.cloud$/, key: 'VENAFI_API_KEY', label: 'Venafi TLS Protect Cloud API key', header: 'tppl-api-key', format: '{v}' },
  { re: /(^|\.)api\.search\.brave\.com$/, key: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API key', header: 'X-Subscription-Token', format: '{v}' },
  { re: /\.p\.rapidapi\.com$/, key: 'RAPIDAPI_KEY', label: 'RapidAPI key', header: 'x-rapidapi-key', format: '{v}' },
  { re: /(^|\.)api-inference\.huggingface\.co$/, key: 'HUGGINGFACE_TOKEN', label: 'Hugging Face access token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)api\.twitter\.com$|(^|\.)api\.x\.com$/, key: 'X_BEARER_TOKEN', label: 'X (Twitter) app bearer token', header: 'Authorization', format: 'Bearer {v}' },
  { re: /(^|\.)serpapi\.com$/, key: 'SERPAPI_KEY', label: 'SerpApi key', query: 'api_key' },
  { re: /(^|\.)app\.scrapingbee\.com$/, key: 'SCRAPINGBEE_API_KEY', label: 'ScrapingBee API key', query: 'api_key' },
  { re: /(^|\.)www\.googleapis\.com$/, key: 'GOOGLE_API_KEY', label: 'Google API key (YouTube Data API enabled)', query: 'key', pathOauth: /\/(?:gmail|webmasters|drive|calendar)\//, oauthKey: 'GOOGLE_OAUTH_TOKEN' },
  { re: /(^|\.)commentanalyzer\.googleapis\.com$/, key: 'PERSPECTIVE_API_KEY', label: 'Perspective API key', query: 'key' },
];

/** n8n generic credential types -> header shape, for hosts the table does not know. */
const GENERIC_AUTH = {
  httpBearerAuth: { header: 'Authorization', format: 'Bearer {v}', label: 'bearer token' },
  httpBasicAuth: { header: 'Authorization', format: 'Basic {v}', label: 'Basic auth credentials (base64 of "user:password")' },
  httpDigestAuth: { header: 'Authorization', format: 'Basic {v}', label: 'Basic auth credentials (base64 of "user:password")' },
  wordpressApi: { header: 'Authorization', format: 'Basic {v}', label: 'WordPress application password as Basic auth (base64 of "user:app-password")' },
  wooCommerceApi: { header: 'Authorization', format: 'Basic {v}', label: 'WooCommerce consumer key and secret as Basic auth (base64 of "key:secret")' },
  erpNextApi: { header: 'Authorization', format: 'token {v}', label: 'ERPNext API key and secret ("<api key>:<api secret>")' },
  qdrantApi: { header: 'api-key', format: '{v}', label: 'Qdrant API key', key: 'QDRANT_API_KEY' },
  supabaseApi: { header: 'apikey', format: '{v}', label: 'Supabase service role key', key: 'SUPABASE_SERVICE_KEY', extra: { Authorization: 'Bearer {v}' } },
  whatsAppApi: { header: 'Authorization', format: 'Bearer {v}', label: 'WhatsApp Cloud API access token', key: 'WHATSAPP_ACCESS_TOKEN' },
  airtableTokenApi: { header: 'Authorization', format: 'Bearer {v}', label: 'Airtable personal access token', key: 'AIRTABLE_TOKEN' },
  // httpHeaderAuth / httpCustomAuth / httpQueryAuth: the original kept the header name in the credential.
  httpHeaderAuth: { header: 'Authorization', format: '{v}', label: 'API credential header value (for example "Bearer <key>"; rename the header if the API expects another one)' },
  httpCustomAuth: { header: 'Authorization', format: '{v}', label: 'API credential header value (for example "Bearer <key>"; rename the header if the API expects another one)' },
};

/** A readable service name for a host: `uj5wyc0l7x-dsn.algolia.net` -> `algolia`, `api.tunova.ai` -> `tunova`. */
export function serviceName(host) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(host || ''))) return '';
  const labels = String(host || '')
    .toLowerCase()
    .replace(/[<>[\]]/g, '')
    .replace(/^(?:api|www|app)\./, '')
    .replace(/^your[-_]/, '')
    .split('.')
    .filter(Boolean);
  if (!labels.length) return '';
  if (labels.length >= 2 && /\d/.test(labels[0])) return labels[labels.length - 2];
  return labels[0];
}

/** OAuth1 signs every request; a static header cannot stand in for it. */
export const UNSIGNABLE_AUTH = new Set(['oAuth1Api', 'oAuth1']);

/** The auth plan for an HTTP step: which secret goes into which header or query parameter. */
export function authPlan(host, path, originalCred) {
  const entry = host ? HOST_AUTH.find((h) => h.re.test(host)) : null;
  if (entry) {
    if (entry.pathOauth && entry.pathOauth.test(path || '')) {
      return { key: entry.oauthKey, label: 'Google OAuth access token', header: 'Authorization', format: 'Bearer {v}', oauth: true, host };
    }
    return { ...entry, host };
  }
  if (host && /qdrant/i.test(host)) return { key: 'QDRANT_API_KEY', label: 'Qdrant API key', header: 'api-key', format: '{v}', host };
  const g = GENERIC_AUTH[originalCred];
  if (g) {
    const base = serviceName(host);
    return { key: g.key || `${base ? `${upperSnake(base)}_` : ''}${g.format.startsWith('Basic') ? 'BASIC_AUTH' : 'API_KEY'}`, label: host ? `${host} ${g.label}` : g.label.replace(/^./, (c) => c.toUpperCase()), header: g.header, format: g.format, extra: g.extra, host };
  }
  if (originalCred === 'httpQueryAuth') {
    const base = serviceName(host);
    return { key: `${base ? `${upperSnake(base)}_` : ''}API_KEY`, label: `${host || 'API'} API key`, query: 'api_key', host };
  }
  if (originalCred && !UNSIGNABLE_AUTH.has(originalCred)) {
    const base = serviceName(host) || originalCred.replace(/(?:OAuth2)?Api$/, '');
    return { key: `${upperSnake(base)}_TOKEN`, label: `${host || originalCred} access token (the original used the ${originalCred} credential)`, header: 'Authorization', format: 'Bearer {v}', oauth: /oauth/i.test(originalCred), host };
  }
  return null;
}

export function headerFormat(plan) {
  if (plan.query) return `query parameter ${plan.query}=<secret>`;
  return `${plan.header}: ${plan.format.replace('{v}', '<secret>')}`;
}

/** Name a setup variable after the literal it replaces and where it sits. */
export function literalVarName(finding, pathKey, contextKey) {
  const text = finding.text;
  if (finding.code === 'personal-email' || finding.kind === 'placeholder address') {
    const k = finding.key || contextKey || '';
    if (/^(?:from|sender|reply_?to)/i.test(k)) return { key: 'senderEmail', label: 'Sender email address', type: 'email', example: 'you@example.com' };
    if (/^(?:cc|bcc)$/i.test(k)) return { key: 'ccEmail', label: 'CC email address', type: 'email', example: 'team@example.com' };
    if (/recipient|^to|send_?to|email|mail/i.test(k)) return { key: 'recipientEmail', label: 'Recipient email address', type: 'email', example: 'you@example.com' };
    return { key: 'contactEmail', label: 'Email address', type: 'email', example: 'you@example.com' };
  }
  if (finding.code === 'upstream-literal-id') {
    const k = finding.key || contextKey || '';
    switch (finding.kind) {
      case 'Google Docs/Sheets id': {
        const around = String(pathKey);
        const kind = /spreadsheets\/d\//.test(finding.context || '') ? 'spreadsheetId' : /document\/d\//.test(finding.context || '') ? 'documentId' : /folders\//.test(finding.context || '') ? 'driveFolderId' : /presentation\/d\//.test(finding.context || '') ? 'presentationId' : /forms\/d\//.test(finding.context || '') ? 'formId' : 'driveFileId';
        void around;
        const labels = { spreadsheetId: 'Google Sheets spreadsheet id', documentId: 'Google Docs document id', driveFolderId: 'Google Drive folder id', presentationId: 'Google Slides presentation id', formId: 'Google Forms form id', driveFileId: 'Google Drive file id' };
        return { key: kind, label: labels[kind], type: 'id', example: '1AbC...xyz' };
      }
      case 'Airtable id': {
        const p = text.slice(0, 3);
        const m = { app: ['airtableBaseId', 'Airtable base id', 'appXXXX (from the base URL)'], tbl: ['airtableTableId', 'Airtable table id', 'tblXXXX (from the table URL)'], viw: ['airtableViewId', 'Airtable view id', 'viwXXXX (from the view URL)'] }[p];
        return { key: m[0], label: m[1], type: 'id', example: m[2] };
      }
      case 'Google file id': {
        const key = /spreadsheet|sheet/i.test(k) ? 'spreadsheetId' : /document/i.test(k) ? 'documentId' : /folder|parent/i.test(k) ? 'driveFolderId' : /template/i.test(k) ? 'templateFileId' : 'driveFileId';
        return { key, label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace('Id', 'id'), type: 'id', example: '1AbC...xyz' };
      }
      case 'Notion id':
        return /database/i.test(k) ? { key: 'notionDatabaseId', label: 'Notion database id', type: 'id', example: '' } : { key: 'notionPageId', label: 'Notion page id', type: 'id', example: '' };
      case 'Slack channel id':
        return { key: 'slackChannel', label: 'Slack channel (name or id)', type: 'channel', example: '#general' };
      case 'Discord id':
        return /guild/i.test(k) ? { key: 'discordGuildId', label: 'Discord server (guild) id', type: 'id', example: '' } : { key: 'discordChannelId', label: 'Discord channel id', type: 'id', example: '' };
      case 'Telegram chat id':
        return { key: 'telegramChatId', label: 'Telegram chat id', type: 'id', example: '123456789' };
      case 'Google Analytics property id':
        return { key: 'gaPropertyId', label: 'Google Analytics 4 property id', type: 'id', example: 'properties/123456789' };
      case 'Google Calendar id':
        return { key: 'calendarId', label: 'Google Calendar id', type: 'id', example: 'primary' };
      default:
        return { key: camel(k) || 'resourceId', label: `${finding.kind}`, type: 'id', example: '' };
    }
  }
  // Placeholder: name it after the words in it, else after where it sits.
  const google = /(?:spreadsheets|document|presentation|forms|file)\/d\/$|folders\/$/.exec(String(finding.context || '').split(text)[0] || '');
  if (google) return literalVarName({ ...finding, code: 'upstream-literal-id', kind: 'Google Docs/Sheets id' }, pathKey, contextKey);
  let words = text
    .replace(/^https?:\/\//, '')
    .replace(/\.example$/, '')
    .replace(/[<>]/g, ' ')
    .replace(/\b(?:YOUR|your|INSERISCI|INSERIRE|INGRESA|EINFUEGEN|INSERT|REPLACE|WITH|HERE|LA|TUA|IL|TUO|CHANGE|ME|api\.)\b/gi, ' ')
    .replace(/[-_.]+/g, ' ')
    .trim();
  if (/^x+$/i.test(words) || /^(?:host|changeme)$/i.test(words)) words = '';
  const isUrl = /^https?:\/\//.test(text);
  const leafKey = String(pathKey).replace(/\[\d+\]/g, '').split('.').pop();
  const base = camel(words) || camel(contextKey || '') || (leafKey && leafKey !== 'jsCode' ? camel(leafKey) : '') || 'setupValue';
  const key = isUrl && !/url|host|base/i.test(base) ? `${base}BaseUrl` : base;
  const type = isUrl ? 'url' : /email/i.test(key) ? 'email' : /(?:^|[a-z])Id$|Ids?$/.test(key) ? 'id' : /channel/i.test(key) ? 'channel' : /host|url|domain|server/i.test(key) ? 'url' : 'text';
  const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  return { key, label, type, example: isUrl ? 'https://api.your-company.com' : '' };
}

/** Is this placeholder standing in for a credential? */
export function isSecretPlaceholder(finding, pathKey, contextKey) {
  if (finding.code !== 'placeholder') return false;
  const leafKey = String(pathKey).split('.').pop();
  if (AUTH_HEADER.test(leafKey) || /token|api[-_]?key|secret|password/i.test(leafKey)) return true;
  if (contextKey && SECRET_NAME.test(contextKey)) return true;
  return SECRET_NAME.test(finding.text.replace(/[-_]/g, '_')) || /cookie/i.test(finding.text);
}

export class SetupRegistry {
  constructor(reservedKeys = new Set()) {
    this.vars = new Map(); // key -> { key, label, type, example, usedBy: Set, literal }
    this.byLiteral = new Map(); // literal text -> key
    this.secrets = new Map(); // SECRET_KEY -> { key, label, host, headerFormat, contextKey, usedBy: Set, oauth }
    this.reserved = reservedKeys;
  }

  freeKey(base) {
    let key = base && !RESERVED.has(base) ? base : `${base || 'setup'}Value`;
    let i = 2;
    const taken = (k) => this.reserved.has(k) || [...this.secrets.values()].some((s) => s.contextKey === k);
    while (taken(key)) key = `${base}${i++}`;
    return key;
  }

  /**
   * Declare (or reuse) a setup variable and return its `{{key}}` token.
   * Missing-param variables with the same key share one value; lifted literals
   * share a value only when the literal is the same.
   */
  variable({ key: base, label, type = 'text', example = '', node, literal }) {
    if (literal !== undefined && this.byLiteral.has(literal)) {
      const v = this.vars.get(this.byLiteral.get(literal));
      if (node) v.usedBy.add(node);
      return `{{${v.key}}}`;
    }
    let key = this.freeKey(base);
    let i = 2;
    while (this.vars.has(key) && literal !== undefined && this.vars.get(key).literal !== undefined && this.vars.get(key).literal !== literal) key = this.freeKey(`${base}${i++}`);
    const existing = this.vars.get(key);
    if (existing) {
      if (node) existing.usedBy.add(node);
    } else {
      this.vars.set(key, { key, label, type, example: example || '', usedBy: new Set(node ? [node] : []), literal });
    }
    if (literal !== undefined) this.byLiteral.set(literal, key);
    return `{{${key}}}`;
  }

  /** Declare a workflow secret and return the run-context key holding its reference. */
  secret({ key, label, host, headerFormat: fmt, node, oauth }) {
    const K = upperSnake(key);
    let s = this.secrets.get(K);
    if (!s) {
      let contextKey = camel(K.toLowerCase());
      let i = 2;
      while (this.reserved.has(contextKey) || this.vars.has(contextKey)) contextKey = `${camel(K.toLowerCase())}${i++}`;
      s = { key: K, label, host: host || undefined, headerFormat: fmt, contextKey, usedBy: new Set(), oauth: oauth || undefined };
      this.secrets.set(K, s);
    }
    if (node) s.usedBy.add(node);
    return s.contextKey;
  }

  /** initialContext entries: empty setup values, secret references. */
  context() {
    const out = {};
    for (const v of this.vars.values()) out[v.key] = '';
    for (const s of this.secrets.values()) out[s.contextKey] = { $workflowSecret: s.key };
    return out;
  }

  setupVars() {
    return [...this.vars.values()].map((v) => ({ key: v.key, label: v.label, type: v.type, example: v.example || undefined, usedBy: [...v.usedBy].sort() }));
  }

  setupSecrets() {
    return [...this.secrets.values()].map((s) => ({ key: s.key, label: s.label, host: s.host, headerFormat: s.headerFormat, contextKey: s.contextKey, usedBy: [...s.usedBy].sort(), oauth: s.oauth }));
  }
}

/**
 * Replace every literal a person must supply in one string with a setup token.
 * `onFinding(finding, contextKey)` returns the replacement text (a `{{key}}`
 * token) or null to leave the literal in place.
 */
export function liftString(pathKey, s, onFinding) {
  const findings = scanLiterals(pathKey, s);
  if (!findings.length) return s;
  let out = '';
  let at = 0;
  for (const f of findings) {
    if (f.start < at) continue;
    const before = s.slice(Math.max(0, f.start - 200), f.start);
    // The JS/JSON key the literal is assigned to (`"base": "https://..."`, `out["chatId"] = "..."`).
    const ctx = /["']?([A-Za-z_$][\w$]*)["']?\]?\s*(?::(?!\/\/)|=(?!=))\s*["'`]?[^"'`\n]*$/.exec(before)?.[1];
    f.context = s.slice(Math.max(0, f.start - 40), f.start + f.text.length + 10);
    const rep = onFinding(f, ctx);
    if (rep == null) continue;
    out += s.slice(at, f.start) + rep;
    at = f.start + f.text.length;
  }
  return out + s.slice(at);
}
