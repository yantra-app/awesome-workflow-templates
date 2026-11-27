import { isExpression } from './expressions.mjs';

export const GENERIC_TRIGGER_TYPES = {
  'n8n-nodes-base.webhook': 'NodeWebhookTrigger',
  'n8n-nodes-base.formTrigger': 'NodeFormTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger': 'NodeChatTrigger',
  '@n8n/n8n-nodes-langchain.manualChatTrigger': 'NodeChatTrigger',
};

const AUTH_MODES = new Map([['none', 'none'], ['basicAuth', 'basic'], ['headerAuth', 'header'], ['bearerAuth', 'bearer']]);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_HEADERS = new Set([
  'connection', 'content-length', 'transfer-encoding', 'set-cookie', 'upgrade', 'trailer', 'keep-alive',
  'x-workflow-job-id', 'x-workflow-session-id',
]);

function responseStatus(value = 200) {
  const status = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('requires a static HTTP status from 200 through 599');
  return status;
}

function responseHeaders(entries = []) {
  const pairs = entries.map(({ name, value }) => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(name) || typeof value !== 'string' ||
        isExpression(value) || /[^\t\x20-\x7e\x80-\xff]/.test(value) || BLOCKED_HEADERS.has(name.toLowerCase())) {
      throw new Error('requires unsupported or dynamic HTTP response headers');
    }
    return [name.toLowerCase(), value];
  });
  const headers = Object.fromEntries(pairs);
  if (Object.keys(headers).length !== pairs.length) throw new Error('uses repeated HTTP response headers');
  const contentType = headers['content-type']?.split(';')[0].trim().toLowerCase();
  delete headers['content-type'];
  return { headers, contentType };
}

function assertResponseType(contentType, bodyMode) {
  if (!contentType || (bodyMode === 'text' && contentType === 'text/plain') ||
      (bodyMode === 'json' && contentType === 'application/json')) return;
  throw new Error('requires a response media type other than JSON or plain text');
}

function schemaForForm(p) {
  const fields = p.formFields?.values ?? [];
  if (p.defineForm === 'json' || fields.length > 50) throw new Error('requires a dynamic form or more than 50 fields');
  const properties = Object.create(null);
  const required = [];
  for (const field of fields) {
    if (field.fieldType === 'html') continue;
    const { fieldType = 'text', fieldLabel: title, fieldName = title, requiredField } = field;
    if (typeof fieldName !== 'string' || !fieldName.trim() || fieldName.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(fieldName) || isExpression(fieldName) ||
        ['__proto__', 'prototype', 'constructor'].includes(fieldName) || Object.hasOwn(properties, fieldName)) {
      throw new Error('requires unique static form field names');
    }
    if (typeof field.defaultValue !== 'undefined' && field.defaultValue !== '') throw new Error('uses form field defaults');
    const schema = { type: fieldType === 'number' ? 'number' : 'string', title: title || fieldName };
    if (fieldType === 'textarea' || fieldType === 'email') schema['x-widget'] = fieldType;
    if (fieldType === 'email') schema.pattern = '^(?:[^\\s@]+@[^\\s@]+\\.[^\\s@]+)?$';
    if (fieldType === 'dropdown' && !field.multiselect) {
      const values = field.fieldOptions?.values?.map((item) => item.option);
      if (!values?.length || values.some((v) => typeof v !== 'string' || !v || isExpression(v))) {
        throw new Error('uses a dropdown without static choices');
      }
      schema.enum = [...new Set(values)];
    } else if (!['text', 'textarea', 'email', 'number'].includes(fieldType)) {
      throw new Error(`uses an unsupported ${fieldType} form field`);
    }
    if (requiredField) {
      required.push(fieldName);
      if (schema.type === 'string') schema.minLength = 1;
    }
    properties[fieldName] = schema;
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

export function triggerSettings(n) {
  const type = GENERIC_TRIGGER_TYPES[n.type];
  const p = n.parameters ?? {};
  const options = p.options ?? {};
  const webhook = type === 'NodeWebhookTrigger';
  const chat = type === 'NodeChatTrigger';
  const auth = AUTH_MODES.get(p.authentication ?? 'none');
  if (!auth || p.requireExecuteAccess || options.ignoreBots || options.ipWhitelist || options.onlyRunIf) {
    throw new Error('uses an unsupported inbound authentication or request filter');
  }
  const inputs = { requiredAuthMode: chat && p.public !== true && auth === 'none' ? 'bearer' : auth };
  const gaps = [];
  const responseMode = (chat ? options.responseMode ?? p.responseMode : p.responseMode) ?? (chat ? 'lastNode' : 'onReceived');
  if (!['onReceived', 'lastNode', 'responseNode'].includes(responseMode)) throw new Error('uses an unsupported trigger response mode');
  inputs.responseMode = responseMode;
  if (webhook) {
    const method = p.httpMethod ?? 'GET';
    if (p.multipleMethods || !HTTP_METHODS.has(method)) throw new Error('requires multiple or unsupported HTTP methods');
    if (typeof p.path === 'string' && (isExpression(p.path) || /(?:^|\/):|\*/.test(p.path))) {
      throw new Error('requires dynamic webhook path parameters');
    }
    inputs.httpMethod = method;
    if (options.allowedOrigins) gaps.push('requires a custom cross-origin policy');
    if (options.binaryData || options.binaryPropertyName) gaps.push('requires n8n binary item fields; Yantra provides the original bytes as base64');
    if (responseMode !== 'responseNode') {
      const statusCode = responseStatus(p.responseCode ?? options.responseCode?.values?.customCode ??
        options.responseCode?.values?.responseCode ?? options.responseCode);
      const { headers, contentType } = responseHeaders(options.responseHeaders?.entries);
      if (responseMode === 'onReceived') {
        const data = options.responseData || p.responseData;
        if (data && (typeof data !== 'string' || isExpression(data))) throw new Error('requires a dynamic immediate response body');
        const bodyMode = data === 'noData' ? 'empty' : data ? 'text' : 'json';
        assertResponseType(contentType, bodyMode);
        inputs.acknowledgement = { statusCode, headers, bodyMode, body: bodyMode === 'json' ? { message: 'Workflow was started' } : data };
      } else {
        const resultMode = new Map([['allEntries', 'allItems'], ['firstEntryJson', 'firstItem'], ['noData', 'empty']])
          .get(p.responseData ?? 'firstEntryJson');
        if (!resultMode || options.responsePropertyName) throw new Error('requires a binary or property-selected last-node response');
        assertResponseType(contentType, resultMode === 'empty' ? 'empty' : 'json');
        inputs.lastNodeResponse = { statusCode, headers, resultMode };
      }
    }
  } else if (chat) {
    if (options.allowFileUploads || (options.loadPreviousSession && options.loadPreviousSession !== 'none') || options.allowedOrigins) {
      gaps.push('requires chat uploads, session history or cross-origin behavior beyond the hosted Yantra form');
    }
  } else {
    inputs.inputSchema = schemaForForm(p);
    if (options.respondWithOptions || options.formSubmittedText) gaps.push('requires custom form completion behavior');
  }
  return { type, inputs, gaps };
}

export function explicitResponseSettings(p = {}) {
  const kind = p.respondWith ?? 'firstIncomingItem';
  const bodyMode = new Map([['json', 'json'], ['firstIncomingItem', 'json'], ['allIncomingItems', 'json'], ['text', 'text'], ['noData', 'empty']]).get(kind);
  if (!bodyMode || p.options?.responseKey || p.enableResponseOutput) throw new Error('uses an unsupported explicit response body or output');
  const { headers, contentType } = responseHeaders(p.options?.responseHeaders?.entries);
  assertResponseType(contentType, bodyMode);
  if (bodyMode === 'text' && typeof p.responseBody === 'string' && /^\s*</.test(p.responseBody)) {
    throw new Error('returns HTML; Yantra explicit text responses use text/plain');
  }
  return { kind, inputs: { bodyMode, statusCode: responseStatus(p.options?.responseCode), headers } };
}
