// How n8n node types map onto Yantra workflow nodes.
//
// Three families:
//   1. SERVICES  - an n8n integration node becomes a `NodeCdeConnector` running
//                  one cdecli connector action. Explicit (resource, operation)
//                  maps carry the parameter names across; anything not listed
//                  falls back to a fuzzy action match and is reported as
//                  approximate so a reader knows to double check it.
//   2. Categories - triggers, LLM nodes, data nodes, folded helper nodes and
//                  stubs, consumed by convert-n8n.mjs.
//   3. CONNECTORS - every connector the converter may emit; the extractor uses
//                  it to build data/connector-actions.json and the validator to
//                  reject unknown actions.

/** Unwrap an n8n resource-locator `{ __rl: true, mode, value }`. */
export function rl(v) {
  if (v && typeof v === 'object' && v.__rl) return v.value;
  return v;
}

/** Read a dotted path from n8n parameters, unwrapping resource locators. */
export function param(p, path) {
  let cur = p;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = key === 'sheetName' ? sheetNameOf(cur[key]) : rl(cur[key]);
  }
  return cur;
}

/**
 * A Google Sheets tab picked from n8n's list is stored as `gid=0`; the Sheets
 * API wants the tab name, which n8n keeps in cachedResultName.
 */
function sheetNameOf(v) {
  if (v && typeof v === 'object' && v.__rl && /^(?:gid=)?\d+$/.test(String(v.value)) && v.cachedResultName) return v.cachedResultName;
  return rl(v);
}

/** cdecli connectors that need no stored credential (system provided). */
export function isSystemConnector(name) {
  return name.startsWith('yantra-');
}

// ---------------------------------------------------------------------------
// 1. Services
// ---------------------------------------------------------------------------

// A parameter spec value is an n8n parameter path, or a function of the
// parameters, or { const: value }.
const G = 'googlesuper';

export const SERVICES = {
  'n8n-nodes-base.telegram': {
    connector: 'telegram',
    label: 'Telegram',
    defaults: { resource: 'message', operation: 'sendMessage', byResource: { file: 'get', chat: 'get', callback: 'answerQuery' } },
    ops: {
      'message.sendMessage': ['TELEGRAM_SEND_MESSAGE', { chat_id: 'chatId', text: 'text', parse_mode: 'additionalFields.parse_mode', reply_markup: 'replyMarkup' }],
      'message.sendPhoto': ['TELEGRAM_SEND_PHOTO', { chat_id: 'chatId', photo: 'file', caption: 'additionalFields.caption' }],
      'message.sendDocument': ['TELEGRAM_SEND_DOCUMENT', { chat_id: 'chatId', document: 'file', caption: 'additionalFields.caption' }],
      'message.sendAudio': ['TELEGRAM_SEND_DOCUMENT', { chat_id: 'chatId', document: 'file', caption: 'additionalFields.caption' }],
      'message.sendVideo': ['TELEGRAM_SEND_DOCUMENT', { chat_id: 'chatId', document: 'file', caption: 'additionalFields.caption' }],
      'message.sendLocation': ['TELEGRAM_SEND_LOCATION', { chat_id: 'chatId', latitude: 'latitude', longitude: 'longitude' }],
      'message.editMessageText': ['TELEGRAM_EDIT_MESSAGE', { chat_id: 'chatId', message_id: 'messageId', text: 'text' }],
      'message.deleteMessage': ['TELEGRAM_DELETE_MESSAGE', { chat_id: 'chatId', message_id: 'messageId' }],
      'message.sendChatAction': ['TELEGRAM_SEND_MESSAGE', { chat_id: 'chatId', text: { const: '...' } }],
      'chat.get': ['TELEGRAM_GET_CHAT', { chat_id: 'chatId' }],
      'chat.administrators': ['TELEGRAM_GET_CHAT_ADMINISTRATORS', { chat_id: 'chatId' }],
      'callback.answerQuery': ['TELEGRAM_ANSWER_CALLBACK_QUERY', { callback_query_id: 'queryId', text: 'additionalFields.text' }],
      // file.get has no catalog action; convert-n8n emits a Bot API HTTP getFile step.
    },
  },
  'n8n-nodes-base.slack': {
    connector: 'slack',
    label: 'Slack',
    defaults: { resource: 'message', operation: 'post' },
    ops: {
      'message.post': ['SLACK_CHAT_POST_MESSAGE', { channel: (p) => param(p, 'channelId') ?? param(p, 'channel') ?? param(p, 'user'), text: 'text', thread_ts: 'otherOptions.thread_ts', blocks: 'blocksUi' }],
      'message.sendMessage': ['SLACK_CHAT_POST_MESSAGE', { channel: (p) => param(p, 'channelId') ?? param(p, 'channel'), text: 'text' }],
      'message.delete': ['SLACK_DELETES_A_MESSAGE_FROM_A_CHAT', { channel: (p) => param(p, 'channelId') ?? param(p, 'channel'), ts: 'timestamp' }],
      // message.search has no Slack connector action — convert-n8n emits an HTTP search.messages stand-in.
      'message.getPermalink': ['SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION', { channel: 'channelId', ts: 'timestamp' }],
      'channel.history': ['SLACK_FETCH_CONVERSATION_HISTORY', { channel: 'channelId', limit: 'limit' }],
      'channel.create': ['SLACK_CREATE_CHANNEL', { name: 'channelId' }],
      'channel.getAll': ['SLACK_FIND_CHANNELS', {}],
      'user.getAll': ['SLACK_FIND_USERS', {}],
      'reaction.add': ['SLACK_ADD_REACTION_TO_AN_ITEM', { channel: 'channelId', timestamp: 'timestamp', name: 'name' }],
    },
  },
  'n8n-nodes-base.gmail': {
    connector: G,
    label: 'Gmail',
    // n8n GmailV2: resource defaults to message; each resource has its own default operation.
    defaults: { resource: 'message', operation: 'send', byResource: { message: 'send', label: 'getAll', draft: 'create', thread: 'getAll' } },
    ops: {
      'message.send': ['GOOGLESUPER_SEND_EMAIL', { recipient_email: 'sendTo', subject: 'subject', body: 'message', cc: 'options.ccList', bcc: 'options.bccList', is_html: (p) => (param(p, 'emailType') === 'html' ? true : undefined) }],
      'message.sendAndWait': ['GOOGLESUPER_SEND_EMAIL', { recipient_email: 'sendTo', subject: 'subject', body: 'message' }],
      'thread.send': ['GOOGLESUPER_SEND_EMAIL', { recipient_email: 'sendTo', subject: 'subject', body: 'message' }],
      'message.reply': ['GOOGLESUPER_REPLY_TO_THREAD', { thread_id: (p) => param(p, 'threadId') ?? param(p, 'messageId'), message_body: 'message', recipient_email: 'sendTo' }],
      'message.get': ['GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: 'messageId' }],
      'message.getAll': ['GOOGLESUPER_FETCH_EMAILS', { query: 'filters.q', max_results: 'limit', label_ids: 'filters.labelIds' }],
      'message.addLabels': ['GOOGLESUPER_ADD_LABEL_TO_EMAIL', { message_id: 'messageId', add_label_ids: 'labelIds' }],
      'message.removeLabels': ['GOOGLESUPER_ADD_LABEL_TO_EMAIL', { message_id: 'messageId', remove_label_ids: 'labelIds' }],
      'message.markAsRead': ['GOOGLESUPER_ADD_LABEL_TO_EMAIL', { message_id: 'messageId', remove_label_ids: { const: ['UNREAD'] } }],
      'message.markAsUnread': ['GOOGLESUPER_ADD_LABEL_TO_EMAIL', { message_id: 'messageId', add_label_ids: { const: ['UNREAD'] } }],
      'message.delete': ['GOOGLESUPER_DELETE_MESSAGE', { message_id: 'messageId' }],
      'draft.create': ['GOOGLESUPER_CREATE_EMAIL_DRAFT', { recipient_email: 'options.sendTo', subject: 'subject', body: 'message', thread_id: 'options.threadId' }],
      'draft.getAll': ['GOOGLESUPER_LIST_DRAFTS', {}],
      'thread.get': ['GOOGLESUPER_FETCH_MESSAGE_BY_THREAD_ID', { thread_id: 'threadId' }],
      'thread.getAll': ['GOOGLESUPER_LIST_THREADS', { query: (p) => gmailQuery(p), max_results: 'limit' }],
      'thread.reply': ['GOOGLESUPER_REPLY_TO_THREAD', { thread_id: 'threadId', message_body: 'message', recipient_email: 'sendTo' }],
      'thread.addLabels': ['GOOGLESUPER_MODIFY_THREAD_LABELS', { thread_id: 'threadId', add_label_ids: 'labelIds' }],
      'thread.removeLabels': ['GOOGLESUPER_MODIFY_THREAD_LABELS', { thread_id: 'threadId', remove_label_ids: 'labelIds' }],
      'label.getAll': ['GOOGLESUPER_LIST_LABELS', {}],
      'label.get': ['GOOGLESUPER_LIST_LABELS', {}],
      'label.create': ['GOOGLESUPER_CREATE_LABEL', { label_name: 'name' }],
      'draft.send': ['GOOGLESUPER_SEND_DRAFT', { draft_id: 'draftId' }],
    },
  },
  'n8n-nodes-base.googleSheets': {
    connector: G,
    label: 'Google Sheets',
    defaults: { resource: 'sheet', operation: 'read', byResource: { sheet: 'read', spreadsheet: 'create' } },
    ops: {
      'sheet.read': ['GOOGLESUPER_BATCH_GET', { spreadsheet_id: 'documentId', ranges: (p) => (param(p, 'sheetName') ? [param(p, 'sheetName')] : undefined) }],
      'sheet.append': ['GOOGLESUPER_SPREADSHEETS_VALUES_APPEND', { spreadsheetId: 'documentId', range: 'sheetName', values: (p) => rowValues(p), valueInputOption: { const: 'USER_ENTERED' } }],
      // Append-only stand-in for upsert when no match key — soft.
      'sheet.appendOrUpdate': ['GOOGLESUPER_SPREADSHEETS_VALUES_APPEND', { spreadsheetId: 'documentId', range: 'sheetName', values: (p) => rowValues(p), valueInputOption: { const: 'USER_ENTERED' } }, { approximate: true, soft: true }],
      'sheet.upsert': ['GOOGLESUPER_SPREADSHEETS_VALUES_APPEND', { spreadsheetId: 'documentId', range: 'sheetName', values: (p) => rowValues(p), valueInputOption: { const: 'USER_ENTERED' } }, { approximate: true, soft: true }],
      'sheet.update': ['GOOGLESUPER_BATCH_UPDATE', { spreadsheet_id: 'documentId', sheet_name: 'sheetName', values: (p) => rowValues(p) }],
      'sheet.lookup': ['GOOGLESUPER_LOOKUP_SPREADSHEET_ROW', { spreadsheet_id: 'documentId', range: 'sheetName', query: 'lookupValue' }],
      'sheet.clear': ['GOOGLESUPER_CLEAR_VALUES', { spreadsheet_id: 'documentId', range: 'sheetName' }],
      'sheet.delete': ['GOOGLESUPER_DELETE_TABLE_ROW', { spreadsheet_id: 'documentId', sheet_name: 'sheetName' }],
      'sheet.create': ['GOOGLESUPER_ADD_SHEET', { spreadsheet_id: 'documentId', title: 'title' }],
      'spreadsheet.create': ['GOOGLESUPER_CREATE_GOOGLE_SHEET1', { title: 'title' }],
      'spreadsheet.read': ['GOOGLESUPER_BATCH_GET', { spreadsheet_id: 'documentId', ranges: (p) => (param(p, 'sheetName') ? [param(p, 'sheetName')] : undefined) }],
    },
  },
  'n8n-nodes-base.googleDrive': {
    connector: G,
    label: 'Google Drive',
    defaults: { resource: 'file', operation: 'upload', byResource: { file: 'upload', fileFolder: 'search', folder: 'create', drive: 'create' } },
    ops: {
      'file.upload': ['GOOGLESUPER_CREATE_FILE_FROM_TEXT', { file_name: 'name', parent_id: 'folderId', text_content: 'content' }],
      // file.upload binary path is handled in convert-n8n emitDriveUpload.
      'fileFolder.upload': ['GOOGLESUPER_CREATE_FILE', { name: 'name', parents: 'folderId', mimeType: 'options.mimeType', description: 'options.description' }],
      'file.createFromText': ['GOOGLESUPER_CREATE_FILE_FROM_TEXT', { file_name: 'name', parent_id: 'folderId', text_content: 'content' }],
      'file.update': ['GOOGLESUPER_EDIT_FILE', { file_id: 'fileId', content: 'content', mime_type: 'options.mimeType' }],
      'file.download': ['GOOGLESUPER_DOWNLOAD_FILE', { file_id: 'fileId' }],
      'file.get': ['GOOGLESUPER_GET_FILE_METADATA', { file_id: 'fileId' }],
      'file.list': ['GOOGLESUPER_LIST_FILES', { q: 'queryString', folderId: 'folderId' }],
      'fileFolder.search': ['GOOGLESUPER_FIND_FILE', { q: (p) => driveSearchQuery(p) }],
      'file.copy': ['GOOGLESUPER_COPY_FILE', { file_id: 'fileId', new_title: 'name' }],
      'file.move': ['GOOGLESUPER_MOVE_FILE', { file_id: 'fileId', new_parent_id: 'driveId' }],
      'file.delete': ['GOOGLESUPER_GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION', { file_id: 'fileId' }],
      'file.share': ['GOOGLESUPER_ADD_FILE_SHARING_PREFERENCE', { file_id: 'fileId' }],
      'folder.create': ['GOOGLESUPER_CREATE_FOLDER', { folder_name: 'name', parent_id: 'folderId' }],
      'folder.delete': ['GOOGLESUPER_GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION', { file_id: 'folderNoRootId' }],
    },
  },
  'n8n-nodes-base.googleDocs': {
    connector: G,
    label: 'Google Docs',
    defaults: { resource: 'document', operation: 'create' },
    ops: {
      // n8n creates an empty Google Doc (optionally in a folder): a Drive file with the Docs mime type.
      'document.create': ['GOOGLESUPER_CREATE_FILE', { name: 'title', mimeType: { const: 'application/vnd.google-apps.document' }, parents: (p) => { const f = constant(param(p, 'folderId')); return f ? [f] : undefined; } }],
      'document.get': ['GOOGLESUPER_GET_DOCUMENT_BY_ID', { id: 'documentURL' }],
      // No Docs write action in catalog; GET is a lossy stand-in for update.
      'document.update': ['GOOGLESUPER_INSERT_TEXT_ACTION', { document_id: (p) => param(p, 'documentURL') ?? param(p, 'documentId'), text_to_insert: (p) => param(p, 'text') ?? param(p, 'updateFields.text') ?? param(p, 'content') ?? param(p, 'actionsUi.text') ?? (param(p, 'actionsUi.actionFields') || []).map((f) => f?.text).filter((t) => t != null)[0], insertion_index: { const: 1 } }],
    },
  },
  'n8n-nodes-base.googleCalendar': {
    connector: G,
    label: 'Google Calendar',
    defaults: { resource: 'event', operation: 'create' },
    ops: {
      'event.create': ['GOOGLESUPER_CREATE_EVENT', { calendar_id: 'calendar', start_datetime: 'start', summary: 'additionalFields.summary', description: 'additionalFields.description', attendees: 'additionalFields.attendees' }],
      'event.getAll': ['GOOGLESUPER_EVENTS_LIST', { calendarId: 'calendar', timeMin: 'timeMin', timeMax: 'timeMax', maxResults: 'limit' }],
      'event.get': ['GOOGLESUPER_FIND_EVENT', { calendar_id: 'calendar', query: 'eventId' }],
      'event.update': ['GOOGLESUPER_PATCH_EVENT', { calendar_id: 'calendar', event_id: 'eventId' }],
      'event.delete': ['GOOGLESUPER_DELETE_EVENT', { calendar_id: 'calendar', event_id: 'eventId' }],
      'calendar.availability': ['GOOGLESUPER_FIND_FREE_SLOTS', { time_min: 'timeMin', time_max: 'timeMax' }],
    },
  },
  'n8n-nodes-base.airtable': {
    connector: 'airtable',
    label: 'Airtable',
    // n8n Airtable v2: record defaults to get, base to getMany.
    defaults: { resource: 'record', operation: 'get', byResource: { record: 'get', base: 'getMany' } },
    ops: {
      'record.create': ['AIRTABLE_CREATE_RECORD', { baseId: (p) => param(p, 'base') ?? param(p, 'application'), tableIdOrName: 'table', fields: (p) => param(p, 'columns.value') ?? param(p, 'fields') ?? airtableAllFields(p) }],
      // Airtable v1 append: every field of the item unless "add all fields" was switched off.
      'record.append': ['AIRTABLE_CREATE_RECORD', { baseId: (p) => param(p, 'base') ?? param(p, 'application'), tableIdOrName: 'table', fields: (p) => param(p, 'columns.value') ?? param(p, 'fields') ?? airtableAllFields(p) }],
      'record.upsert': ['AIRTABLE_CREATE_RECORD', { baseId: 'base', tableIdOrName: 'table', fields: (p) => param(p, 'columns.value') }, { approximate: true, soft: true }],
      // n8n v2 update matches on columns.matchingColumns (usually `id`) inside columns.value.
      'record.update': ['AIRTABLE_UPDATE_RECORD', { baseId: 'base', tableIdOrName: 'table', recordId: (p) => param(p, 'id') ?? param(p, 'columns.value.id') ?? (airtableAutoMap(p) ? '={{ $json.id }}' : undefined), fields: (p) => (airtableAutoMap(p) ? '={{ $json }}' : withoutKeys(param(p, 'columns.value'), ['id'])) }],
      'record.get': ['AIRTABLE_GET_RECORD', { baseId: 'base', tableIdOrName: 'table', recordId: 'id' }],
      'record.read': ['AIRTABLE_GET_RECORD', { baseId: (p) => param(p, 'application') ?? param(p, 'base'), tableIdOrName: 'table', recordId: 'id' }],
      'record.delete': ['AIRTABLE_DELETE_RECORD', { baseId: 'base', tableIdOrName: 'table', recordId: 'id' }],
      'record.search': ['AIRTABLE_LIST_RECORDS', { baseId: 'base', tableIdOrName: 'table', filterByFormula: 'filterByFormula', maxRecords: 'limit', view: 'options.view' }],
      'record.list': ['AIRTABLE_LIST_RECORDS', { baseId: 'base', tableIdOrName: 'table', filterByFormula: 'filterByFormula', view: 'options.view' }],
      'record.deleteRecord': ['AIRTABLE_DELETE_RECORD', { baseId: 'base', tableIdOrName: 'table', recordId: 'id' }],
      'base.getSchema': ['AIRTABLE_GET_BASE_SCHEMA', { baseId: 'base' }],
      'base.getMany': ['AIRTABLE_LIST_BASES', {}],
      'base.create': ['AIRTABLE_CREATE_BASE', { name: 'name', tables: 'tables', workspaceId: 'workspaceId' }],
    },
  },
  'n8n-nodes-base.notion': {
    connector: 'notion',
    label: 'Notion',
    defaults: { resource: 'page', operation: 'create', byResource: { page: 'create', databasePage: 'create', database: 'get', block: 'append', user: 'get' } },
    ops: {
      'page.create': ['NOTION_CREATE_NOTION_PAGE', { parent_id: 'pageId', title: 'title' }],
      'page.search': ['NOTION_SEARCH_NOTION_PAGE', { query: 'text' }],
      'page.archive': ['NOTION_ARCHIVE_NOTION_PAGE', { page_id: 'pageId' }],
      'databasePage.create': ['NOTION_INSERT_ROW_DATABASE', { database_id: 'databaseId', properties: 'propertiesUi' }],
      'databasePage.getAll': ['NOTION_QUERY_DATABASE', { database_id: 'databaseId', page_size: 'limit' }],
      'databasePage.get': ['NOTION_GET_PAGE_PROPERTY_ACTION', { page_id: 'pageId' }],
      'databasePage.update': ['NOTION_UPDATE_ROW_DATABASE', { row_id: 'pageId', properties: 'propertiesUi' }],
      'database.get': ['NOTION_FETCH_DATABASE', { database_id: 'databaseId' }],
      'database.getAll': ['NOTION_FETCH_DATA', { get_databases: { const: true } }],
      'database.search': ['NOTION_FETCH_DATA', { query: 'text', get_databases: { const: true } }],
      'database.create': ['NOTION_CREATE_DATABASE', { title: 'title', parent_id: 'parentId', properties: 'propertiesUi' }],
      'block.append': ['NOTION_ADD_PAGE_CONTENT', { parent_block_id: 'blockId', content_block: 'blockUi' }],
      'block.getAll': ['NOTION_FETCH_BLOCK_CONTENTS', { block_id: 'blockId' }],
    },
  },
  'n8n-nodes-base.discord': {
    connector: 'discordbot',
    label: 'Discord',
    defaults: { resource: 'message', operation: 'send' },
    ops: {
      'message.send': ['DISCORDBOT_CREATE_MESSAGE', { channel_id: 'channelId', content: (p) => param(p, 'content') ?? param(p, 'text'), embeds: 'embeds' }],
      'message.get': ['DISCORDBOT_GET_MESSAGE', { channel_id: 'channelId', message_id: 'messageId' }],
      'message.getAll': ['DISCORDBOT_LIST_MESSAGES', { channel_id: 'channelId', limit: 'limit' }],
      'message.react': ['DISCORDBOT_ADD_MY_MESSAGE_REACTION', { channel_id: 'channelId', message_id: 'messageId', emoji_name: 'emoji' }],
      'channel.create': ['DISCORDBOT_CREATE_GUILD_CHANNEL', { guild_id: 'guildId', name: 'name' }],
      'channel.getAll': ['DISCORDBOT_LIST_GUILD_CHANNELS', { guild_id: 'guildId' }],
    },
  },
  'n8n-nodes-base.whatsApp': {
    connector: 'whatsapp',
    label: 'WhatsApp',
    // n8n WhatsApp: the message operation defaults to sendTemplate, not send.
    defaults: { resource: 'message', operation: 'sendTemplate', byResource: { message: 'sendTemplate' } },
    ops: {
      'message.send': ['WHATSAPP_SEND_MESSAGE', { phone_number_id: 'phoneNumberId', to_number: 'recipientPhoneNumber', text: 'textBody' }],
      'message.sendTemplate': ['WHATSAPP_SEND_TEMPLATE_MESSAGE', { phone_number_id: 'phoneNumberId', to_number: 'recipientPhoneNumber', template_name: 'template' }],
      'message.sendAndWait': ['WHATSAPP_SEND_MESSAGE', { phone_number_id: 'phoneNumberId', to_number: 'recipientPhoneNumber', text: 'message' }],
      'media.mediaUrlGet': ['WHATSAPP_GET_MEDIA_INFO', { media_id: 'mediaGetId' }],
      'media.mediaDownload': ['WHATSAPP_GET_MEDIA', { media_id: 'mediaGetId' }],
    },
  },
  'n8n-nodes-base.wordpress': {
    connector: 'wordpress',
    label: 'WordPress',
    defaults: { resource: 'post', operation: 'create' },
    ops: {
      'post.create': ['WORDPRESS_CREATE_POST', { title: 'title', content: 'additionalFields.content', status: 'additionalFields.status', slug: 'additionalFields.slug', categories: 'additionalFields.categories', tags: 'additionalFields.tags', excerpt: 'additionalFields.excerpt' }],
      'post.update': ['WORDPRESS_UPDATE_POST', { id: 'postId', title: 'updateFields.title', content: 'updateFields.content', status: 'updateFields.status', categories: 'updateFields.categories', tags: 'updateFields.tags' }],
      'post.get': ['WORDPRESS_GET_POST', { id: 'postId' }],
      'post.getAll': ['WORDPRESS_GETALL_POST', { per_page: 'limit', status: 'options.status' }],
      'page.create': ['WORDPRESS_CREATE_PAGE', { title: 'title', content: 'additionalFields.content', status: 'additionalFields.status' }],
      'page.get': ['WORDPRESS_GET_PAGE', { id: 'pageId' }],
      'page.getAll': ['WORDPRESS_GETALL_PAGE', { per_page: 'limit' }],
    },
  },
  'n8n-nodes-base.jira': {
    connector: 'jira',
    label: 'Jira',
    defaults: { resource: 'issue', operation: 'create', byResource: { issue: 'create', issueComment: 'add', issueAttachment: 'add' } },
    ops: {
      'issue.create': ['JIRA_CREATE_ISSUE', { project_key: 'project', summary: 'summary', issue_type: 'issueType', description: 'additionalFields.description', labels: 'additionalFields.labels', priority: 'additionalFields.priority' }],
      'issue.get': ['JIRA_GET_ISSUE', { issue_id_or_key: 'issueKey' }],
      'issue.getAll': ['JIRA_SEARCH_ISSUES', { jql: 'options.jql', max_results: 'limit' }],
      'issue.update': ['JIRA_EDIT_ISSUE', { issue_id_or_key: 'issueKey', summary: 'updateFields.summary', description: 'updateFields.description' }],
      'issue.delete': ['JIRA_DELETE_ISSUE', { issue_id_or_key: 'issueKey' }],
      'issueComment.add': ['JIRA_ADD_COMMENT', { issue_id_or_key: 'issueKey', comment: 'comment' }],
      'issueComment.create': ['JIRA_ADD_COMMENT', { issue_id_or_key: 'issueKey', comment: 'comment' }],
      'issueComment.getAll': ['JIRA_LIST_ISSUE_COMMENTS', { issue_id_or_key: 'issueKey' }],
      'issueAttachment.add': ['JIRA_ADD_ATTACHMENT', { issue_key: 'issueKey', file_to_upload: 'binaryPropertyName' }],
      'issueAttachment.create': ['JIRA_ADD_ATTACHMENT', { issue_key: 'issueKey', file_to_upload: 'binaryPropertyName' }],
    },
  },
  'n8n-nodes-base.github': {
    connector: 'github',
    label: 'GitHub',
    defaults: { resource: 'issue', operation: 'create' },
    ops: {
      'issue.create': ['GITHUB_CREATE_AN_ISSUE', { owner: 'owner', repo: 'repository', title: 'title', body: 'body', labels: 'labels' }],
            'issue.createComment': ['GITHUB_CREATE_AN_ISSUE_COMMENT', { owner: 'owner', repo: 'repository', issue_number: 'issueNumber', body: 'body' }],
      // issue.edit has no catalog UPDATE action; convert-n8n emits a GitHub Issues PATCH HTTP step.
            'repository.getIssues': ['GITHUB_LIST_REPOSITORY_ISSUES', { owner: 'owner', repo: 'repository' }],
      'file.create': ['GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS', { owner: 'owner', repo: 'repository', path: 'filePath', content: 'fileContent', message: 'commitMessage' }],
      'file.edit': ['GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS', { owner: 'owner', repo: 'repository', path: 'filePath', content: 'fileContent', message: 'commitMessage' }],
      // file.get has no catalog action; convert-n8n emits an api.github.com contents HTTP step.
      'release.create': ['GITHUB_CREATE_A_RELEASE', { owner: 'owner', repo: 'repository', tag_name: 'releaseTag' }],
    },
  },
  'n8n-nodes-base.supabase': {
    connector: 'supabase',
    label: 'Supabase',
    defaults: { resource: 'row', operation: 'create' },
    // Row CRUD is SUPABASE_*_ROW (first-aid patch). Those actions compile table/fields into management-API SQL.
    ops: {
      'row.create': ['SUPABASE_INSERT_ROW', { table: 'tableId' }],
      'row.get': ['SUPABASE_SELECT_ROWS', { table: 'tableId', id: 'id' }],
      'row.getAll': ['SUPABASE_SELECT_ROWS', { table: 'tableId' }],
      'row.update': ['SUPABASE_UPDATE_ROW', { table: 'tableId', id: 'id' }],
      'row.delete': ['SUPABASE_DELETE_ROW', { table: 'tableId', id: 'id' }],
    },
  },
  'n8n-nodes-base.postgres': {
    connector: 'supabase',
    label: 'Postgres (via Supabase)',
    // n8n Postgres v1 and v2 both default to insert.
    defaults: { resource: 'database', operation: 'insert', byResource: { database: 'insert' } },
    // Row operations become SUPABASE_*_ROW (structured: the connector escapes every value);
    // convert-n8n emitPostgresRow handles insert/update/select/delete/upsert.
    ops: {
      'database.executeQuery': ['SUPABASE_BETA_RUN_SQL_QUERY', { ref: { const: '' }, query: 'query' }, { approximate: true, soft: true }],
    },
  },
  'n8n-nodes-base.mongoDb': {
    connector: 'mongodb',
    label: 'MongoDB',
    defaults: { resource: 'document', operation: 'find' },
    ops: {
      'document.find': ['MONGODB_FIND', { collection: 'collection', filter: 'query', limit: 'limit' }],
      'document.findOneAndUpdate': ['MONGODB_UPDATE_ONE', { collection: 'collection', filter: 'query', update: 'updateKey' }],
      'document.insert': ['MONGODB_INSERT_MANY', { collection: 'collection', documents: 'fields' }],
      'document.update': ['MONGODB_UPDATE_MANY', { collection: 'collection', filter: 'query' }],
      'document.delete': ['MONGODB_DELETE_MANY', { collection: 'collection', filter: 'query' }],
      'document.aggregate': ['MONGODB_AGGREGATE', { collection: 'collection', pipeline: 'query' }],
    },
  },
  'n8n-nodes-base.redis': {
    connector: 'redis',
    label: 'Redis',
    defaults: { resource: 'key', operation: 'get' },
    ops: {
      'key.get': ['REDIS_GET', { key: 'key' }],
      'key.set': ['REDIS_SET', { key: 'key', value: 'value', ttl: 'ttl' }],
      'key.delete': ['REDIS_DEL', { key: 'key' }],
      'key.keys': ['REDIS_KEYS', { pattern: 'keyPattern' }],
      'key.push': ['REDIS_LPUSH', { key: 'list', value: 'messageData' }],
      // No INCR action; SET is a lossy stand-in.
      'key.incr': ['REDIS_SET', { key: 'key' }, { approximate: true }],
    },
  },
  'n8n-nodes-base.spotify': {
    connector: 'spotify',
    label: 'Spotify',
    // n8n Spotify: resource defaults to player; each resource has its own default operation.
    defaults: { resource: 'player', operation: 'addSongToQueue', byResource: { player: 'addSongToQueue', album: 'get', artist: 'get', playlist: 'add', track: 'get', library: 'getLikedTracks', myData: 'getFollowingArtists' } },
    ops: {
      'track.search': ['SPOTIFY_SEARCH', { q: 'query', type: { const: 'track' }, limit: 'limit' }],
      'album.search': ['SPOTIFY_SEARCH', { q: 'query', type: { const: 'album' }, limit: 'limit' }],
      'artist.search': ['SPOTIFY_SEARCH', { q: 'query', type: { const: 'artist' }, limit: 'limit' }],
      'playlist.search': ['SPOTIFY_SEARCH', { q: 'query', type: { const: 'playlist' }, limit: 'limit' }],
      'playlist.create': ['SPOTIFY_CREATE_PLAYLIST', { name: 'name', public: 'additionalFields.public', description: 'additionalFields.description' }],
      'playlist.add': ['SPOTIFY_ADD_TRACKS_TO_PLAYLIST', { playlist_id: 'id', uris: 'trackID' }],
      'playlist.getUserPlaylists': ['SPOTIFY_GET_A_LIST_OF_CURRENT_USERS_PLAYLISTS', { limit: 'limit' }],
      'player.currentlyPlaying': ['SPOTIFY_GET_CURRENTLY_PLAYING_TRACK', {}],
      'player.addSongToQueue': ['SPOTIFY_ADD_ITEM_TO_PLAYBACK_QUEUE', { uri: 'id' }],
      // Playback operations belong to n8n's player resource.
      'player.nextSong': ['SPOTIFY_SKIP_TO_NEXT', { device_id: 'deviceId' }],
      'player.resume': ['SPOTIFY_START_RESUME_PLAYBACK', { device_id: 'deviceId' }],
      'player.startMusic': ['SPOTIFY_START_RESUME_PLAYBACK', { device_id: 'deviceId', context_uri: 'id' }],
      'player.recentlyPlayed': ['SPOTIFY_GET_RECENTLY_PLAYED_TRACKS', { limit: 'limit' }],
      'player.pause': ['SPOTIFY_PAUSE_PLAYBACK', { device_id: 'deviceId' }],
      'player.previousSong': ['SPOTIFY_SKIP_TO_PREVIOUS', { device_id: 'deviceId' }],
      'library.getLikedTracks': ['SPOTIFY_GET_USER_S_SAVED_TRACKS', { limit: 'limit' }],
      'library.search': ['SPOTIFY_SEARCH', { q: 'query', type: { const: 'track' }, limit: 'limit' }],
      'track.get': ['SPOTIFY_GET_TRACK', { id: 'id' }],
      'album.get': ['SPOTIFY_GET_ALBUM', { id: 'id' }],
      'artist.get': ['SPOTIFY_GET_ARTIST', { id: 'id' }],

    },
  },
  'n8n-nodes-base.twilio': {
    connector: 'twilio',
    label: 'Twilio',
    defaults: { resource: 'sms', operation: 'send', byResource: { sms: 'send', call: 'make' } },
    ops: {
      'sms.send': ['TWILIO_SEND_MESSAGE', { to: 'to', from: 'from', body: 'message' }],
      'call.make': ['TWILIO_CREATE_CALL', { to: 'to', from: 'from', twiml: 'message' }],
    },
  },
  'n8n-nodes-base.hubspot': {
    connector: 'hubspot',
    label: 'HubSpot',
    defaults: { resource: 'contact', operation: 'upsert', byResource: { contact: 'upsert', company: 'create', deal: 'create', engagement: 'create', ticket: 'create' } },
    ops: {
      'contact.upsert': ['HUBSPOT_CREATE_CONTACT', { email: 'email', firstname: 'additionalFields.firstName', lastname: 'additionalFields.lastName', company: 'additionalFields.companyName', phone: 'additionalFields.phoneNumber' }, { approximate: true, soft: true }],
      'contact.create': ['HUBSPOT_CREATE_CONTACT', { email: 'email', firstname: 'additionalFields.firstName', lastname: 'additionalFields.lastName' }],
      'deal.create': ['HUBSPOT_CREATE_DEAL', { dealname: 'additionalFields.dealName', dealstage: 'stage', amount: 'additionalFields.amount' }],
      'company.create': ['HUBSPOT_CREATE_COMPANY', { name: 'name' }],
      'engagement.create': ['HUBSPOT_CREATE_TIMELINE_EVENT_BASED_ON_TEMPLATE', {}, { approximate: true }],
    },
  },
  'n8n-nodes-base.todoist': {
    connector: 'todoist',
    label: 'Todoist',
    defaults: { resource: 'task', operation: 'create' },
    ops: {
      'task.create': ['TODOIST_CREATE_TASK', { content: 'content', project_id: 'project', due_string: 'options.dueString', priority: 'options.priority', description: 'options.description', labels: 'labels' }],
      'task.getAll': ['TODOIST_GET_ALL_TASKS', { project_id: 'filters.projectId' }],
      'task.close': ['TODOIST_CLOSE_TASK', { task_id: 'taskId' }],
      'task.update': ['TODOIST_UPDATE_TASK', { task_id: 'taskId', content: 'updateFields.content' }],
      'task.delete': ['TODOIST_DELETE_TASK', { task_id: 'taskId' }],
    },
  },
  'n8n-nodes-base.trello': {
    connector: 'trello',
    label: 'Trello',
    defaults: { resource: 'card', operation: 'create' },
    ops: {
      'card.create': ['TRELLO_ADD_CARDS', { idList: 'listId', name: 'name', desc: 'description', due: 'additionalFields.due' }],
      'card.get': ['TRELLO_GET_CARDS_BY_ID_CARD', { idCard: 'id' }],
            'list.getCards': ['TRELLO_GET_LISTS_CARDS_BY_ID_LIST', { idList: 'id' }],
    },
  },
  'n8n-nodes-base.linear': {
    connector: 'linear',
    label: 'Linear',
    defaults: { resource: 'issue', operation: 'create' },
    ops: {
      'issue.create': ['LINEAR_CREATE_LINEAR_ISSUE', { team_id: 'teamId', title: 'title', description: 'additionalFields.description', priority: 'additionalFields.priorityId', assignee_id: 'additionalFields.assigneeId' }],
      'issue.get': ['LINEAR_GET_LINEAR_ISSUE', { issue_id: 'issueId' }],
      'issue.getAll': ['LINEAR_LIST_LINEAR_ISSUES', { first: 'limit' }],
      'issue.update': ['LINEAR_UPDATE_ISSUE', { issue_id: 'issueId', title: 'updateFields.title', description: 'updateFields.description' }],
      'issue.delete': ['LINEAR_DELETE_LINEAR_ISSUE', { issue_id: 'issueId' }],
    },
  },
  'n8n-nodes-base.zendesk': {
    connector: 'zendesk',
    label: 'Zendesk',
    defaults: { resource: 'ticket', operation: 'create' },
    ops: {
      'ticket.create': ['ZENDESK_CREATE_ZENDESK_TICKET', { subject: 'additionalFields.subject', description: 'description', priority: 'additionalFields.priority' }],
      'ticket.get': ['ZENDESK_GET_ZENDESK_TICKET_BY_ID', { ticket_id: 'id' }],
      'ticket.getAll': ['ZENDESK_LIST_ZENDESK_TICKETS', { per_page: 'limit' }],
      'ticket.update': ['ZENDESK_REPLY_ZENDESK_TICKET', { ticket_id: 'id', body: 'updateFields.internalNote' }, { approximate: true }],
      'ticket.delete': ['ZENDESK_DELETE_ZENDESK_TICKET', { ticket_id: 'id' }],
    },
  },
  'n8n-nodes-base.shopify': { connector: 'shopify', label: 'Shopify', defaults: { resource: 'order', operation: 'getAll' }, ops: {
    'order.getAll': ['SHOPIFY_GET_ORDER_LIST', {}],
    'order.get': ['SHOPIFY_GET_ORDERSBY_ID', { order_id: 'orderId' }],
    'order.create': ['SHOPIFY_CREATE_ORDER', {}],
    'product.getAll': ['SHOPIFY_GET_PRODUCTS', { limit: 'limit' }],
    'product.get': ['SHOPIFY_GET_PRODUCT', { product_id: 'productId' }],
    'product.create': ['SHOPIFY_CREATE_PRODUCT', { title: 'title' }],
  } },
  'n8n-nodes-base.webflow': { connector: 'webflow', label: 'Webflow', defaults: { resource: 'item', operation: 'create' }, ops: {
    'item.create': ['WEBFLOW_CREATE_COLLECTION_ITEM', { collection_id: 'collectionId', field_data: 'fieldsUi', is_draft: 'live' }],
    'item.getAll': ['WEBFLOW_LIST_COLLECTION_ITEMS', { collection_id: 'collectionId', limit: 'limit' }],
    'item.get': ['WEBFLOW_GET_COLLECTION_ITEM', { collection_id: 'collectionId', item_id: 'itemId' }],
    'item.update': ['WEBFLOW_UPDATE_COLLECTION_ITEM', { collection_id: 'collectionId', item_id: 'itemId', field_data: 'fieldsUi' }],
    'item.delete': ['WEBFLOW_DELETE_COLLECTION_ITEM', { collection_id: 'collectionId', item_id: 'itemId' }],
  } },
  'n8n-nodes-base.mailchimp': { connector: 'mailchimp', label: 'Mailchimp', defaults: { resource: 'member', operation: 'create' }, ops: {
    'member.create': ['MAILCHIMP_ADD_MEMBER_TO_LIST', { list_id: 'list', email_address: 'email', status: 'status', merge_fields: 'mergeFieldsUi' }],
    'member.update': ['MAILCHIMP_ADD_OR_UPDATE_LIST_MEMBER', { list_id: 'list', email_address: 'email', status: 'updateFields.status' }],
    'member.getAll': ['MAILCHIMP_LIST_MEMBERS_INFO', { list_id: 'list', count: 'limit' }],
    'campaign.getAll': ['MAILCHIMP_LIST_CAMPAIGNS', { count: 'limit' }],
  } },
  'n8n-nodes-base.linkedIn': { connector: 'linkedin', label: 'LinkedIn', defaults: { resource: 'post', operation: 'create' }, ops: {
    'post.create': ['LINKEDIN_CREATE_LINKED_IN_POST', { author: 'person', commentary: 'text', visibility: { const: 'PUBLIC' } }],
  } },
  'n8n-nodes-base.twitter': { connector: 'twitter', label: 'X (Twitter)', defaults: { resource: 'tweet', operation: 'create' }, ops: {
    'tweet.create': ['TWITTER_CREATION_OF_A_POST', { text: 'text' }],
    'tweet.search': ['TWITTER_RECENT_SEARCH', { query: 'searchText', max_results: 'limit' }],
    'tweet.like': ['TWITTER_USER_LIKE_POST', { tweet_id: 'tweetId' }],
    'tweet.retweet': ['TWITTER_RETWEET_POST', { tweet_id: 'tweetId' }],
    'tweet.delete': ['TWITTER_POST_DELETE_BY_POST_ID', { id: 'tweetId' }],
    'user.searchUser': ['TWITTER_USER_LOOKUP_BY_USERNAME', { username: 'user' }],
  } },
  'n8n-nodes-base.reddit': { connector: 'reddit', label: 'Reddit', defaults: { resource: 'post', operation: 'search' }, ops: {
    'post.search': ['REDDIT_SEARCH_ACROSS_SUBREDDITS', { search_query: 'keyword', limit: 'limit', sort: 'additionalFields.sort' }],
    'post.create': ['REDDIT_CREATE_REDDIT_POST', { subreddit: 'subreddit', title: 'title', text: 'text', kind: 'kind', url: 'url' }],
    'post.get': ['REDDIT_RETRIEVE_REDDIT_POST', { subreddit: 'subreddit', post_id: 'postId' }],
    'postComment.create': ['REDDIT_POST_REDDIT_COMMENT', { thing_id: 'postId', text: 'commentText' }],
    'postComment.getAll': ['REDDIT_RETRIEVE_POST_COMMENTS', { subreddit: 'subreddit', article: 'postId' }],
  } },
  'n8n-nodes-base.facebookGraphApi': {
    connector: 'facebook',
    label: 'Facebook',
    defaults: { resource: 'page', operation: 'post' },
    ops: {
      'page.post': ['FACEBOOK_CREATE_POST', { page_id: 'pageId', message: 'message', link: 'url', published: { const: true } }],
    },
  },
  'n8n-nodes-base.hackerNews': { connector: 'hackernews', label: 'Hacker News', defaults: { resource: 'article', operation: 'get', byResource: { all: 'getAll', article: 'get', user: 'get' } }, ops: {
    'all.getAll': ['HACKERNEWS_SEARCH_POSTS', { query: 'additionalFields.keyword', size: 'limit', tags: 'additionalFields.tags' }],
    'article.get': ['HACKERNEWS_GET_ITEM_WITH_ID', { item_id: 'articleId' }],
  } },
  'n8n-nodes-base.strapi': { connector: 'strapi', label: 'Strapi', defaults: { resource: 'entry', operation: 'create' }, ops: {
    'entry.create': ['STRAPI_CREATE_ENTRY', { content_type: 'contentType', data: 'columns' }],
    'entry.getAll': ['STRAPI_GETALL_ENTRY', { content_type: 'contentType' }],
    'entry.get': ['STRAPI_GET_ENTRY', { content_type: 'contentType', id: 'entryId' }],
    'entry.update': ['STRAPI_UPDATE_ENTRY', { content_type: 'contentType', id: 'entryId' }],
  } },
  'n8n-nodes-base.pipedrive': {
    connector: 'pipedrive',
    label: 'Pipedrive',
    defaults: { resource: 'deal', operation: 'create', byResource: { note: 'create', person: 'get' } },
    ops: {
      'deal.create': ['PIPEDRIVE_ADD_A_DEAL', { title: 'title', value: 'additionalFields.value', person_id: 'additionalFields.person_id', org_id: 'additionalFields.org_id' }],
      'lead.create': ['PIPEDRIVE_ADD_A_LEAD', { title: 'title', person_id: 'additionalFields.person_id', organization_id: 'additionalFields.organization_id' }],
      'person.create': ['PIPEDRIVE_ADD_A_PERSON', { name: 'name', email: 'additionalFields.email', phone: 'additionalFields.phone' }],
      'person.get': ['PIPEDRIVE_GET_DETAILS_OF_A_PERSON', { id: 'personId' }],
      'person.search': ['PIPEDRIVE_GET_ALL_PERSONS', { first_char: 'term', limit: 'limit' }],
      'organization.create': ['PIPEDRIVE_ADD_AN_ORGANIZATION', { name: 'name' }],
      'note.create': ['PIPEDRIVE_ADD_A_NOTE', { content: 'content', person_id: 'additionalFields.person_id', deal_id: 'additionalFields.deal_id', org_id: 'additionalFields.org_id' }],
    },
  },
  'n8n-nodes-base.baserow': {
    connector: 'baserow',
    label: 'Baserow',
    defaults: { resource: 'row', operation: 'getAll', byResource: { row: 'getAll' } },
    // Row CRUD requires first-aid/patches/baserow/ (LIST/CREATE/UPDATE/DELETE/GET).
    ops: {
      'row.create': ['BASEROW_CREATE_ROW', { table_id: 'tableId' }],
      'row.getAll': ['BASEROW_LIST_ROWS', { table_id: 'tableId', size: 'limit' }],
      'row.get': ['BASEROW_GET_ROW', { table_id: 'tableId', row_id: 'rowId' }],
      'row.update': ['BASEROW_UPDATE_ROW', { table_id: 'tableId', row_id: 'rowId' }],
      'row.delete': ['BASEROW_DELETE_ROW', { table_id: 'tableId', row_id: 'rowId' }],
    },
  },
  'n8n-nodes-base.nocoDb': {
    connector: 'nocodb',
    label: 'NocoDB',
    defaults: { resource: 'row', operation: 'getAll' },
    // CREATE_ROW / UPDATE_ROW need first-aid/patches/nocodb/; delete uses stock DB_VIEW_ROW_DELETE.
    ops: {
      'row.create': ['NOCODB_CREATE_ROW', { table_id: 'table', base_id: 'projectId' }],
      'row.update': ['NOCODB_UPDATE_ROW', { table_id: 'table', base_id: 'projectId', row_id: 'id' }],
      'row.delete': ['NOCODB_DB_VIEW_ROW_DELETE', { table_id: 'table', row_id: 'id' }],
      'row.get': ['NOCODB_TABLE_READ', { base_id: 'projectId', table_id: 'table' }, { approximate: true }],
      'row.getAll': ['NOCODB_TABLE_READ', { base_id: 'projectId', table_id: 'table' }, { approximate: true }],
    },
  },
  'n8n-nodes-base.bambooHr': {
    connector: 'bamboohr',
    label: 'BambooHR',
    defaults: { resource: 'employee', operation: 'getAll' },
    ops: {
      'employee.getAll': ['BAMBOOHR_GET_EMPLOYEE_DIRECTORY', { companyDomain: 'companyDomain' }],
      'employee.get': ['BAMBOOHR_GET_EMPLOYEE', { id: 'employeeId', companyDomain: 'companyDomain' }],
      'file.getAll': ['BAMBOOHR_LIST_COMPANY_FILES_AND_CATEGORIES', { companyDomain: 'companyDomain' }],
      'file.download': ['BAMBOOHR_GET_AN_COMPANY_FILE', { fileId: 'fileId', companyDomain: 'companyDomain' }],
      'file.get': ['BAMBOOHR_GET_AN_COMPANY_FILE', { fileId: 'fileId', companyDomain: 'companyDomain' }],
    },
  },
  'n8n-nodes-base.erpNext': {
    connector: 'erpnext',
    label: 'ERPNext',
    defaults: { resource: 'document', operation: 'get' },
    ops: {
      'document.get': ['ERPNEXT_GET_DOCUMENT', { doctype: 'docType', name: 'documentName' }],
      'document.update': ['ERPNEXT_UPDATE_DOCUMENT', { doctype: 'docType', name: 'documentName', fields: 'properties' }],
      'document.create': ['ERPNEXT_CREATE_DOCUMENT', { doctype: 'docType', data: 'properties' }],
      'document.getAll': ['ERPNEXT_LIST_DOCUMENTS', { doctype: 'docType' }],
    },
  },
  'n8n-nodes-base.lemlist': {
    connector: 'lemlist',
    label: 'Lemlist',
    defaults: { resource: 'lead', operation: 'get' },
    ops: {
      'lead.unsubscribe': ['LEMLIST_DELETE_DELETE_UNSUBSCRIBE_EMAIL', { email: 'email' }],
      'lead.get': ['LEMLIST_GET_RETRIEVE_LEAD_BY_EMAIL', { email: 'email' }],
      'lead.create': ['LEMLIST_ADD_LEAD', { campaign_id: 'campaignId', email: 'email', firstName: 'additionalFields.firstName', lastName: 'additionalFields.lastName', companyName: 'additionalFields.companyName', deduplicate: 'additionalFields.deduplicate' }],
      'lead.upsert': ['LEMLIST_ADD_LEAD', { campaign_id: 'campaignId', email: 'email', firstName: 'additionalFields.firstName', lastName: 'additionalFields.lastName', companyName: 'additionalFields.companyName' }],
    },
  },
  'n8n-nodes-base.s3': {
    connector: 'aws-s3',
    label: 'AWS S3',
    defaults: { resource: 'file', operation: 'upload' },
    ops: {
      'file.upload': ['AWSS3_UPLOAD_FILE', { Bucket: (p) => param(p, 'bucketName') ?? param(p, 'bucket'), FileKey: (p) => param(p, 'fileName') ?? param(p, 'fileKey') ?? param(p, 'name'), Body: 'binaryPropertyName' }, { approximate: true, soft: true }],
      'file.download': ['AWSS3_DOWNLOAD_FILE', { Bucket: (p) => param(p, 'bucketName') ?? param(p, 'bucket'), FileKey: (p) => param(p, 'fileKey') ?? param(p, 'fileName') }],
      'file.delete': ['AWSS3_DELETE_FILE', { Bucket: (p) => param(p, 'bucketName') ?? param(p, 'bucket'), FileKey: (p) => param(p, 'fileKey') ?? param(p, 'fileName') }],
      'folder.create': ['AWSS3_CREATE_FOLDER', { Bucket: (p) => param(p, 'bucketName') ?? param(p, 'bucket'), FolderKey: (p) => param(p, 'folderName') ?? param(p, 'name') }],
      'bucket.getAll': ['AWSS3_LIST_BUCKETS', {}],
    },
  },
  'n8n-nodes-base.humanticAi': {
    connector: 'humantic-a-i',
    label: 'Humantic AI',
    defaults: { resource: 'profile', operation: 'create' },
    ops: {
      'profile.create': ['HUMANTIC_A_I_CREATE_PROFILE', {}],
      'profile.get': ['HUMANTIC_A_I_GET_PROFILE', { id: 'userId' }],
      'profile.update': ['HUMANTIC_A_I_UPDATE_PROFILE', { id: 'userId' }],
    },
    approximate: true,
  },
  // GA4 report ops have no matching connector actions (catalog is account/audience only).
  // convert-n8n emits an HTTP Data API stand-in via buildService special-case.
  'n8n-nodes-base.googleAnalytics': {
    connector: 'google-analytics',
    label: 'Google Analytics',
    defaults: { resource: 'report', operation: 'get' },
    ops: {
      'account.getAll': ['GOOGLE_ANALYTICS_LIST_ACCOUNTS', {}],
      'account.get': ['GOOGLE_ANALYTICS_GET_ACCOUNT', { name: 'accountId' }],
      'audience.getAll': ['GOOGLE_ANALYTICS_LIST_AUDIENCES', { parent: 'propertyId' }],
    },
  },
  'n8n-nodes-base.elasticsearch': {
    connector: 'elasticsearch',
    label: 'Elasticsearch',
    defaults: { resource: 'document', operation: 'getAll' },
    // INDEX/UPDATE/DELETE need first-aid/patches/elasticsearch/
    ops: {
      'document.getAll': ['ELASTICSEARCH_QUERY_INDEX', { index_name: 'indexId', query: 'query', size: 'limit' }],
      'document.create': ['ELASTICSEARCH_INDEX_DOCUMENT', { index: 'indexId' }],
      'document.update': ['ELASTICSEARCH_UPDATE_DOCUMENT', { index: 'indexId', id: 'documentId' }],
      'document.delete': ['ELASTICSEARCH_DELETE_DOCUMENT', { index: 'indexId', id: 'documentId' }],
      'document.get': ['ELASTICSEARCH_QUERY_INDEX', { index_name: 'indexId', query: 'query' }, { approximate: true }],
    },
  },
  'n8n-nodes-base.clickUp': { connector: 'clickup', label: 'ClickUp', defaults: { resource: 'task', operation: 'create' }, ops: {
    'task.create': ['CLICKUP_CREATE_TASK', { list_id: 'list', name: 'name', description: 'additionalFields.content', priority: 'additionalFields.priority', due_date: 'additionalFields.dueDate' }],
  } },
  'n8n-nodes-base.mondayCom': { connector: 'monday', label: 'monday.com', defaults: { resource: 'boardItem', operation: 'create' }, ops: {
    'boardItem.create': ['MONDAY_CREATE_ITEM', { board_id: 'boardId', group_id: 'groupId', item_name: 'name', column_values: 'additionalFields.columnValues' }],
    'boardItem.getAll': ['MONDAY_LIST_BOARD_ITEMS', { board_id: 'boardId' }],
  } },
  'n8n-nodes-base.zoom': { connector: 'zoom', label: 'Zoom', defaults: { resource: 'meeting', operation: 'create' }, ops: {
    'meeting.create': ['ZOOM_CREATE_A_MEETING', { userId: { const: 'me' }, topic: 'topic', start_time: 'additionalFields.startTime', duration: 'additionalFields.duration', agenda: 'additionalFields.agenda' }],
    'meeting.get': ['ZOOM_GET_A_MEETING', { meetingId: 'meetingId' }],
    'meeting.getAll': ['ZOOM_LIST_MEETINGS', { userId: { const: 'me' } }],
  } },
  'n8n-nodes-base.asana': { connector: 'asana', label: 'Asana', defaults: { resource: 'task', operation: 'create' }, ops: {
    'task.create': ['ASANA_CREATE_A_TASK', { data: (p) => ({ name: param(p, 'name'), workspace: param(p, 'workspace'), notes: param(p, 'otherProperties.notes'), projects: param(p, 'otherProperties.projects') }) }],
  } },
  'n8n-nodes-base.typeformTrigger': null,
  'n8n-nodes-base.calendly': {
    connector: 'calendly',
    label: 'Calendly',
    defaults: { resource: 'event', operation: 'getAll' },
    ops: {
      'event.getAll': ['CALENDLY_LIST_EVENTS', { count: 'limit' }],
      'event.get': ['CALENDLY_GET_EVENT', { uuid: 'eventId' }],
      'eventType.getAll': ['CALENDLY_LIST_USER_S_EVENT_TYPES', {}],
    },
  },
  'n8n-nodes-base.stripe': {
    connector: 'stripe',
    label: 'Stripe',
    defaults: { resource: 'customer', operation: 'create' },
    ops: {
      'customer.create': ['STRIPE_CREATE_CUSTOMER', { email: 'email', name: 'name', description: 'description', phone: 'phone' }],
      'customer.get': ['STRIPE_RETRIEVE_CUSTOMER', { customer_id: 'customerId' }],
      'customer.getAll': ['STRIPE_LIST_CUSTOMERS', { email: 'email', limit: 'limit' }],
      'customer.delete': ['STRIPE_DELETE_CUSTOMER', { customer_id: 'customerId' }],
      'charge.getAll': ['STRIPE_LIST_CHARGES', { customer: 'customerId', limit: 'limit' }],
      'coupon.getAll': ['STRIPE_LIST_COUPONS', { limit: 'limit' }],
    },
  },
  'n8n-nodes-base.dropbox': { connector: 'dropbox', label: 'Dropbox', defaults: { resource: 'file', operation: 'upload', byResource: { file: 'upload', folder: 'create', search: 'query' } }, ops: {
    'file.upload': ['DROPBOX_UPLOAD_FILE', { path: 'path', content: 'fileContent' }],
    'file.download': ['DROPBOX_READ_FILE', { path: 'path' }],
    'folder.list': ['DROPBOX_LIST_FILES_IN_FOLDER', { path: 'path' }],
    'search.query': ['DROPBOX_SEARCH_FILE_OR_FOLDER', { query: 'query' }],
  } },
  'n8n-nodes-base.microsoftOneDrive': { connector: 'one-drive', label: 'OneDrive', defaults: { resource: 'file', operation: 'upload', byResource: { file: 'upload' } }, ops: {
    'file.upload': ['ONE_DRIVE_ONEDRIVE_UPLOAD_FILE', { file: 'binaryPropertyName', folder: 'parentId' }],
    'file.download': ['ONE_DRIVE_DOWNLOAD_FILE', { item_id: 'fileId' }],
    'file.get': ['ONE_DRIVE_GET_ITEM', { item_id: 'fileId' }],
  } },
  'n8n-nodes-base.matrix': { connector: 'matrix', label: 'Matrix', defaults: { resource: 'message', operation: 'create' }, ops: {
    'message.create': ['MATRIX_M_TEXT_MESSAGE', { room_id: 'roomId', text: 'text' }],
  } },
  'n8n-nodes-base.mattermost': {
    connector: 'mattermost',
    label: 'Mattermost',
    defaults: { resource: 'message', operation: 'post' },
    // Create-post requires first-aid/patches/mattermost/
    ops: {
      'message.post': ['MATTERMOST_CREATE_POST', { channel_id: 'channelId', message: 'message', props: 'attachments' }],
    },
  },
  'n8n-nodes-base.gitlab': { connector: 'gitlab', label: 'GitLab', defaults: { resource: 'issue', operation: 'create' }, ops: {
    'issue.create': ['GITLAB_CREATE_PROJECT_ISSUE', { id: 'repository', title: 'title', description: 'body', labels: 'labels' }],
  } },
  'n8n-nodes-base.bannerbear': {
    connector: 'bannerbear',
    label: 'Bannerbear',
    defaults: { resource: 'image', operation: 'create' },
    // CREATE_IMAGE needs first-aid/patches/bannerbear/
    ops: {
      'image.create': ['BANNERBEAR_CREATE_IMAGE', { template: 'templateId', modifications: 'modificationsUi' }],
      'image.getAll': ['BANNERBEAR_LIST_IMAGES', { page: 'page', limit: 'limit' }],
      'template.getAll': ['BANNERBEAR_LIST_TEMPLATES', { limit: 'limit' }],
    },
  },
  'n8n-nodes-base.freshdesk': { connector: 'freshdesk', label: 'Freshdesk', defaults: { resource: 'ticket', operation: 'create' }, ops: {
    'ticket.create': ['FRESHDESK_CREATE_TICKET', { subject: 'subject', description: 'description', email: 'requester', priority: 'priority', status: 'status' }],
  } },
  'n8n-nodes-base.intercom': {
    connector: 'intercom',
    label: 'Intercom',
    defaults: { resource: 'user', operation: 'create' },
    ops: {
      'user.create': ['INTERCOM_UPDATE_A_CONTACT', { id: (p) => param(p, 'id') ?? param(p, 'userId') ?? param(p, 'email') }],
      'user.update': ['INTERCOM_UPDATE_A_CONTACT', { id: (p) => param(p, 'id') ?? param(p, 'userId') ?? param(p, 'email') }],
      'user.get': ['INTERCOM_GET_A_CONTACT', { id: (p) => param(p, 'id') ?? param(p, 'userId') }],
      'company.create': ['INTERCOM_CREATE_OR_UPDATE_A_COMPANY', { company_id: 'companyId', name: 'name' }],
    },
    approximate: true,
  },
  'n8n-nodes-base.salesforce': { connector: 'salesforce', label: 'Salesforce', defaults: { resource: 'lead', operation: 'create' }, ops: {
    'lead.create': ['SALESFORCE_CREATE_LEAD', { company: 'company', last_name: 'lastname', email: 'additionalFields.email', first_name: 'additionalFields.firstname' }],
    'contact.create': ['SALESFORCE_CREATE_CONTACT', { last_name: 'lastname', email: 'additionalFields.email' }],
  } },
  'n8n-nodes-base.mySql': {
    connector: 'clickhouse',
    label: 'SQL (MySQL original → ClickHouse stand-in)',
    defaults: { resource: 'database', operation: 'executeQuery' },
    ops: {
      // Hard approximate: ClickHouse is not MySQL-compatible; keep needs-setup.
      'database.executeQuery': ['CLICKHOUSE_EXECUTE_QUERY', { query: 'query' }, { approximate: true }],
      'database.select': ['CLICKHOUSE_EXECUTE_QUERY', { query: (p) => `SELECT * FROM ${param(p, 'table') ?? 'table'}` }, { approximate: true }],
      'database.insert': ['CLICKHOUSE_EXECUTE_QUERY', { query: (p) => `INSERT INTO ${param(p, 'table') ?? 'table'} ...` }, { approximate: true }],
      'database.update': ['CLICKHOUSE_EXECUTE_QUERY', { query: (p) => `UPDATE ${param(p, 'table') ?? 'table'} SET ...` }, { approximate: true }],
      'database.delete': ['CLICKHOUSE_EXECUTE_QUERY', { query: (p) => `DELETE FROM ${param(p, 'table') ?? 'table'} WHERE ...` }, { approximate: true }],
    },
  },
  'n8n-nodes-base.coda': { connector: 'coda', label: 'Coda', defaults: { resource: 'table', operation: 'createRow' }, ops: {
    'table.createRow': ['CODA_UPSERT_ROWS', { docId: 'docId', tableIdOrName: 'tableId', rows: 'options' }],
    'table.getAllRows': ['CODA_LIST_TABLE_ROWS', { docId: 'docId', tableIdOrName: 'tableId' }],
  } },
  'n8n-nodes-base.typeform': { connector: 'typeform', label: 'Typeform', defaults: { resource: 'form', operation: 'getResponses' }, ops: {
    'form.getResponses': ['TYPEFORM_GET_FORM_RESPONSES', { form_id: 'formId' }],
  } },
  'n8n-nodes-base.wooCommerce': {
    connector: 'shopify',
    label: 'Store (WooCommerce original)',
    defaults: { resource: 'product', operation: 'getAll' },
    ops: {
      'product.getAll': ['SHOPIFY_GET_PRODUCTS', {}],
      'customer.getAll': ['SHOPIFY_GET_ALL_CUSTOMERS', { limit: 'limit' }],
      'customer.get': ['SHOPIFY_GET_CUSTOMER', { customer_id: 'customerId' }],
      'order.getAll': ['SHOPIFY_GET_ORDER_LIST', {}],
    },
    approximate: true,
  },
  'n8n-nodes-base.emailSend': {
    connector: G,
    label: 'Email (SMTP original)',
    defaults: { resource: 'email', operation: 'send' },
    ops: {
      'email.send': ['GOOGLESUPER_SEND_EMAIL', { recipient_email: 'toEmail', subject: 'subject', body: (p) => param(p, 'html') ?? param(p, 'text') ?? param(p, 'message'), cc: 'ccEmail', bcc: 'bccEmail', is_html: (p) => (param(p, 'html') ? true : undefined) }],
      'email.sendAndWait': ['GOOGLESUPER_SEND_EMAIL', { recipient_email: 'toEmail', subject: 'subject', body: (p) => param(p, 'html') ?? param(p, 'text') ?? param(p, 'message') }],
    },
  },
  // No Outlook connector yet: mail steps run on Gmail; folders/categories → labels (soft).
  'n8n-nodes-base.microsoftOutlook': {
    connector: G,
    label: 'Email (Outlook original)',
    defaults: { resource: 'message', operation: 'send' },
    ops: {
      'message.send': ['GOOGLESUPER_SEND_EMAIL', { recipient_email: 'toRecipients', subject: 'subject', body: 'bodyContent', is_html: (p) => (param(p, 'additionalFields.bodyContentType') === 'html' ? true : undefined) }],
      'message.getAll': ['GOOGLESUPER_FETCH_EMAILS', { query: { const: 'in:inbox' }, max_results: 'limit' }],
      'message.get': ['GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: 'messageId' }],
      'message.reply': ['GOOGLESUPER_REPLY_TO_THREAD', { thread_id: 'messageId', message_body: 'message' }],
      'message.update': ['GOOGLESUPER_ADD_LABEL_TO_EMAIL', { message_id: 'messageId', add_label_ids: (p) => outlookLabels(param(p, 'updateFields.categories')) }, { approximate: true, soft: true }],
      'message.move': ['GOOGLESUPER_ADD_LABEL_TO_EMAIL', { message_id: 'messageId', add_label_ids: (p) => outlookLabels(param(p, 'folderId')) }, { approximate: true, soft: true }],
      'draft.create': ['GOOGLESUPER_CREATE_EMAIL_DRAFT', { recipient_email: 'additionalFields.toRecipients', subject: 'subject', body: 'bodyContent' }],
      'folder.getAll': ['GOOGLESUPER_LIST_LABELS', {}, { approximate: true, soft: true }],
    },
  },
  'n8n-nodes-base.emailReadImap': {
    connector: G,
    label: 'Mailbox (IMAP original)',
    defaults: { resource: 'email', operation: 'read' },
    ops: {
      'email.read': ['GOOGLESUPER_FETCH_EMAILS', { query: { const: 'is:unread' }, max_results: { const: 20 } }, { approximate: true, soft: true }],
      'email.getAll': ['GOOGLESUPER_FETCH_EMAILS', { query: { const: 'in:inbox' }, max_results: 'limit' }, { approximate: true, soft: true }],
    },
  },
  // SSH is first-class in cdecli; templates need a permitted host credential.
  'n8n-nodes-base.ssh': {
    connector: 'ssh',
    label: 'SSH',
    defaults: { resource: 'command', operation: 'execute' },
    ops: {
      'command.execute': ['SSH_RUN_COMMAND', { command: 'command', cwd: 'cwd' }, { approximate: true, soft: true }],
      'command.run': ['SSH_RUN_COMMAND', { command: 'command', cwd: 'cwd' }, { approximate: true, soft: true }],
    },
  },
  'n8n-nodes-base.dhl': {
    connector: 'dhl',
    label: 'DHL',
    defaults: { resource: 'shipment', operation: 'get' },
    ops: {
      'shipment.get': ['DHL_GET_SHIPMENTS', { trackingNumber: 'trackingNumber' }],
    },
    approximate: true,
  },
  'n8n-nodes-base.pdfCo': {
    connector: 'pdf-co',
    label: 'PDF.co',
    defaults: { resource: 'pdf', operation: 'fromHtml' },
    ops: {
      'pdf.fromHtml': ['PDF_CO_PDF_FROM_HTML', {}],
      'pdf.fromText': ['PDF_CO_PDF_FROM_DOCUMENT_TXT', {}],
    },
  },
  // Community pdfMint → PDF.co (markdown/html → PDF; usage → balance).
  'n8n-nodes-pdfmint.pdfMint': {
    connector: 'pdf-co',
    label: 'PDF (pdfMint original)',
    defaults: { resource: 'pdf', operation: 'pdf' },
    ops: {
      'pdf.pdf': ['PDF_CO_PDF_FROM_HTML', {}],
      'pdf.fromMarkdown': ['PDF_CO_PDF_FROM_HTML', {}],
      'pdf.usage': ['PDF_CO_ACCOUNT_BALANCE_INFO', {}],
    },
    approximate: true,
  },
  // n8n / Perspective / Venafi / magicHour / fiwano / cradl / youtubeTranscripter → HTTP_NODES stand-ins.
  // gcf / spreadsheetFile → DATA_NODES Transforms.
  'n8n-nodes-base.rssFeedRead': null, // handled as HTTP request
  // yantra-youtube-search has an empty action catalog; convert-n8n emits a YouTube Data API HTTP search.
  'n8n-nodes-base.youTube': { connector: 'yantra-youtube-search', label: 'YouTube', defaults: { resource: 'video', operation: 'getAll' }, ops: {} },
  '@apify/n8n-nodes-apify.apify': { connector: 'apify', label: 'Apify', defaults: { resource: 'actors', operation: 'Run actor' }, ops: {
    'actors.Run actor': ['APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', { actorId: 'actorId', body: 'customBody' }],
    'actors.Run actor and get dataset': ['APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', { actorId: 'actorId', body: 'customBody' }],
    // Upstream Apify node uses capital-A resource label in some graphs.
    'Actors.Run actor': ['APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', { actorId: 'actorId', body: 'customBody' }],
    'Actors.Run actor and get dataset': ['APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', { actorId: 'actorId', body: 'customBody' }],
    'datasets.Get items': ['APIFY_GET_DATASET_ITEMS', { datasetId: 'datasetId' }],
  } },
  // Media and search nodes land on Yantra's system connectors (no credential).
  'n8n-nodes-base.editImage': {
    connector: 'yantra-image-editing',
    label: 'Image editing',
    defaults: { resource: 'image', operation: 'resize' },
    ops: {
      'image.resize': ['YANTRA_IMAGE_EDIT_RESIZE', { input_url: { const: '' }, width: 'width', height: 'height', fit: 'resizeOption' }],
      'image.crop': ['YANTRA_IMAGE_EDIT_CROP', { input_url: { const: '' }, width: 'width', height: 'height', left: 'positionX', top: 'positionY' }],
      'image.rotate': ['YANTRA_IMAGE_EDIT_ROTATE', { input_url: { const: '' }, angle: 'rotate' }],
      'image.text': ['YANTRA_IMAGE_EDIT_ANNOTATE', { input_url: { const: '' }, text: 'text', font_size: 'fontSize' }],
      'image.composite': ['YANTRA_IMAGE_EDIT_COMPOSE', { input_url: { const: '' } }],
      'image.information': ['YANTRA_IMAGE_EDIT_CONVERT', { input_url: { const: '' } }],
      'image.multiStep': ['YANTRA_IMAGE_EDIT_COMPOSE', { input_url: { const: '' } }, { approximate: true }],
    },
  },
};

// n8n `<service>Tool` nodes are the same integrations wired as agent tools.
for (const [type, spec] of Object.entries({ ...SERVICES })) {
  if (spec && type.startsWith('n8n-nodes-base.')) SERVICES[`${type}Tool`] = spec;
}

/** A simple SQL identifier (the Supabase row actions accept no other form), else null. */
export function sqlIdent(name) {
  const v = String(name ?? '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? v : null;
}

/**
 * Column values of an n8n Postgres insert/update: `columns.value` (v2 name ->
 * value map), or a comma-separated `columns` string (v1) read off the item.
 * Returns undefined when the node auto-maps the whole item.
 */
export function postgresColumns(p) {
  const valueMap = param(p, 'columns.value');
  if (valueMap && typeof valueMap === 'object' && !Array.isArray(valueMap)) {
    const entries = Object.entries(valueMap).filter(([k, v]) => k && v !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (typeof p.columns === 'string' && p.columns.trim() && !p.columns.trim().startsWith('=')) {
    const cols = p.columns.split(',').map((c) => c.trim()).filter(Boolean);
    return cols.length ? Object.fromEntries(cols.map((c) => [c, `={{ $json[${JSON.stringify(c)}] }}`])) : undefined;
  }
  return undefined;
}

/**
 * The row an n8n Postgres insert/update/select/delete targets, as the
 * structured params of SUPABASE_*_ROW. Values stay values (the connector
 * escapes each one); nothing is spliced into SQL text here.
 * Returns { table, schema, fields?, filters?, problems[] }.
 */
export function postgresRow(p, operation) {
  const problems = [];
  const schema = String(rl(param(p, 'schema')) || 'public');
  const tableRaw = rl(param(p, 'table'));
  const table = typeof tableRaw === 'string' && !tableRaw.startsWith('=') ? sqlIdent(tableRaw) : null;
  if (!table) problems.push(`table ${JSON.stringify(tableRaw ?? '')} is not a plain table name`);
  if (schema !== 'public') problems.push(`schema "${schema}" is not public (the Supabase row actions only address public tables)`);
  const out = { table: table || undefined, schema, problems };
  const cols = postgresColumns(p);
  const autoMap = !cols && (param(p, 'columns.mappingMode') === 'autoMapInputData' || param(p, 'dataMode') === 'autoMapInputData' || operation === 'insert');
  if (operation === 'insert' || operation === 'upsert' || operation === 'update') {
    let fields = cols;
    const match = param(p, 'columns.matchingColumns') ?? (p.updateKey ? String(p.updateKey).split(',').map((s) => s.trim()) : undefined);
    if (operation === 'update' || operation === 'upsert') {
      const keys = Array.isArray(match) ? match.filter(Boolean) : [];
      if (!keys.length) problems.push('no matching column to find the row');
      if (fields) {
        out.filters = Object.fromEntries(keys.filter((k) => k in fields).map((k) => [k, fields[k]]));
        fields = Object.fromEntries(Object.entries(fields).filter(([k]) => !keys.includes(k)));
      } else if (keys.length) {
        out.filters = Object.fromEntries(keys.map((k) => [k, `={{ $json[${JSON.stringify(k)}] }}`]));
      }
    }
    for (const k of Object.keys(fields || {})) if (!sqlIdent(k)) problems.push(`column "${k}" is not a plain column name`);
    out.fields = fields || (autoMap ? '={{ $json }}' : undefined);
    if (!out.fields) problems.push('no columns to write');
  }
  if (operation === 'select' || operation === 'delete') {
    const where = param(p, 'where.values') ?? [];
    const filters = {};
    for (const w of Array.isArray(where) ? where : []) {
      if (!w?.column) continue;
      if ((w.condition ?? 'equal') !== 'equal') problems.push(`where ${w.column} ${w.condition} is not an equality filter`);
      else filters[w.column] = w.value;
    }
    if (Object.keys(filters).length) out.filters = filters;
    if (operation === 'delete' && (param(p, 'deleteCommand') ?? 'truncate') !== 'delete') problems.push(`delete command "${param(p, 'deleteCommand') ?? 'truncate'}" is not a row delete`);
    if (operation === 'delete' && !out.filters) problems.push('no row filter');
  }
  return out;
}

/** Airtable v2 "map each column automatically" matched on the record id. */
function airtableAllFields(p) {
  if (param(p, 'options.addAllFields') === false) return undefined;
  return param(p, 'columns.mappingMode') === 'autoMapInputData' || param(p, 'application') !== undefined ? '={{ $json }}' : undefined;
}

function airtableAutoMap(p) {
  const match = param(p, 'columns.matchingColumns');
  return param(p, 'columns.mappingMode') === 'autoMapInputData' && Array.isArray(match) && match.length === 1 && match[0] === 'id';
}

/** An expression-mode constant (`=abc`, no `{{ }}`) as its plain value; `default` n8n folder ids mean none. */
function constant(v) {
  if (typeof v === 'string' && v.startsWith('=') && !v.includes('{{')) v = v.slice(1);
  return v === '' || v === 'default' ? undefined : v;
}

/** A copy of an object without some keys (undefined when nothing is left). */
function withoutKeys(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
  return Object.keys(out).length ? out : undefined;
}

/** Gmail search query from the n8n filters UI (query text plus label ids). */
export function gmailQuery(p) {
  const q = param(p, 'filters.q');
  const labels = param(p, 'filters.labelIds');
  const parts = [];
  if (q !== undefined && q !== '') parts.push(q);
  if (Array.isArray(labels)) for (const l of labels) if (l) parts.push(`label:${l}`);
  if (!parts.length) return undefined;
  if (parts.some((x) => typeof x === 'string' && x.startsWith('='))) return '=' + parts.map((x) => (typeof x === 'string' && x.startsWith('=') ? x.slice(1) : x)).join(' ');
  return parts.join(' ');
}

/** Drive search query (`q`) from the n8n fileFolder search UI. */
export function driveSearchQuery(p) {
  const clauses = [];
  const folder = param(p, 'filter.folderId');
  const text = param(p, 'queryString');
  const what = param(p, 'filter.whatToSearch');
  // `={{ expr }}` stays an expression; `=text` (expression mode, no braces) is literal text.
  const isExpr = (v) => typeof v === 'string' && v.startsWith('=') && v.includes('{{');
  const dyn = [folder, text].some(isExpr);
  const lit = (v) => (isExpr(v) ? v.slice(1).trim() : String(v).replace(/^=/, '').replace(/'/g, "\\'"));
  if (folder && folder !== 'root') clauses.push(`'${lit(folder)}' in parents`);
  if (text) clauses.push(param(p, 'searchMethod') === 'query' ? lit(text) : `name contains '${lit(text)}'`);
  if (what === 'folders') clauses.push("mimeType = 'application/vnd.google-apps.folder'");
  else if (what === 'files') clauses.push("mimeType != 'application/vnd.google-apps.folder'");
  clauses.push('trashed = false');
  return (dyn ? '=' : '') + clauses.join(' and ');
}

/** n8n Supabase row filter UI: condition rows, or a PostgREST `filterString`. */
export function supabaseFilterConditions(p) {
  const conditions = param(p, 'filters.conditions');
  if (Array.isArray(conditions)) {
    const out = conditions.filter((c) => c && (c.keyName || c.key));
    if (out.length) return out;
  }
  const filterString = param(p, 'filterString');
  if (typeof filterString === 'string' && filterString.trim()) return filterString.trim();
  return undefined;
}

/** Google Sheets columns UI -> a values matrix for the append/update actions. */
export function rowValues(p) {
  const mapping = param(p, 'columns.value') ?? param(p, 'fieldsUi.values') ?? param(p, 'columns.mappings');
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping) && Object.keys(mapping).length) return [Object.values(mapping)];
  if (Array.isArray(mapping) && mapping.length) return [mapping.map((f) => f?.fieldValue ?? f?.value ?? f)];
  // "Map automatically": every input item is one row, its fields in order.
  if (param(p, 'dataMode') === 'autoMapInputData' || param(p, 'columns.mappingMode') === 'autoMapInputData' || (!mapping && !param(p, 'dataMode'))) return AUTO_MAP_ROWS;
  return undefined;
}

/** Sheets rows from every input item (n8n "Map automatically"); column order follows each item's field order. */
export const AUTO_MAP_ROWS = '={{ $input.all().map((i) => Object.values(i.json ?? {})) }}';

/** Baserow fieldsUi → flat name→value map for CREATE_ROW body (user_field_names). */
export function baserowFieldMap(p) {
  const ui = param(p, 'fieldsUi') ?? param(p, 'fieldsUi.fieldValues') ?? param(p, 'fields');
  if (!ui) return undefined;
  if (Array.isArray(ui)) {
    const out = {};
    for (const f of ui) {
      let k = f?.fieldId ?? f?.fieldName ?? f?.name ?? f?.key;
      // n8n sometimes stores a plain field name in expression mode (`=News_Source`).
      if (typeof k === 'string' && k.startsWith('=') && !k.includes('{{')) k = k.slice(1);
      if (k != null && k !== '') out[k] = f?.fieldValue ?? f?.value ?? f?.val;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof ui === 'object') {
    if (Array.isArray(ui.fieldValues)) return baserowFieldMap({ fieldsUi: ui.fieldValues });
    return ui;
  }
  return undefined;
}

/** Outlook categories or a folder id -> Gmail label ids (an expression stays as-is). */
function outlookLabels(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v;
  return typeof v === 'string' && v.startsWith('=') ? v : [v];
}

/**
 * LLM-style services whose result should feed the flow as text. The
 * converter turns these into `NodeCdecliChatCompletion` when the resource is a
 * chat/text completion, or a connector action for images and audio.
 */
export const OPENAI_MEDIA = {
  image: { connector: 'yantra-image-generation', action: 'YANTRA_GEMINI_IMAGE_GENERATE', params: { prompt: 'prompt', model: 'options.model' } },
  audio: {
    // Platform speech (no credential): Whisper transcription of an audio URL, TTS to a stored audio URL.
    transcribe: { connector: 'yantra-voicebox', action: 'YANTRA_VOICEBOX_TRANSCRIBE', params: { language: 'options.language' } },
    generate: { connector: 'yantra-voicebox', action: 'YANTRA_VOICEBOX_SPEAK', params: { text: 'input' } },
    translate: { connector: 'yantra-voicebox', action: 'YANTRA_VOICEBOX_TRANSCRIBE', params: { language: { const: 'en' } } },
  },
  file: {
    upload: { connector: 'openai', action: 'OPENAI_UPLOAD_FILE', params: { file: 'binaryPropertyName', purpose: 'options.purpose' } },
    list: { connector: 'openai', action: 'OPENAI_LIST_FILES', params: { limit: 'limit' } },
    delete: { connector: 'openai', action: 'OPENAI_DELETE_FILE', params: { file_id: 'fileId' } },
  },
};

// ---------------------------------------------------------------------------
// 2. Categories
// ---------------------------------------------------------------------------

/** Provider triggers that have a webhook trigger slug on Yantra. */
export const WEBHOOK_TRIGGERS = {
  'n8n-nodes-base.airtableTrigger': { connector: 'airtable', slug: 'AIRTABLE_VIEW_CREATED_TRIGGER' },
  'n8n-nodes-base.notionTrigger': { connector: 'notion', slug: (p) => (param(p, 'event') === 'pageUpdatedInDatabase' ? 'NOTION_PAGE_UPDATED_TRIGGER' : 'NOTION_PAGE_ADDED_TO_DATABASE') },
  'n8n-nodes-base.linearTrigger': { connector: 'linear', slug: 'LINEAR_ISSUE_CREATED_TRIGGER' },
  'n8n-nodes-base.pipedriveTrigger': { connector: 'pipedrive', slug: 'PIPEDRIVE_NEW_DEAL_TRIGGER' },
  'n8n-nodes-base.whatsAppTrigger': { connector: 'whatsapp', slug: 'WHATSAPP_MESSAGE_STATUS_UPDATED_TRIGGER' },
  'n8n-nodes-base.slackTrigger': { connector: 'slack', slug: 'SLACK_RECEIVE_MESSAGE' },
  'n8n-nodes-base.githubTrigger': { connector: 'github', slug: 'GITHUB_ISSUE_CREATED_TRIGGER' },
  'n8n-nodes-base.jiraTrigger': { connector: 'jira', slug: 'JIRA_NEW_ISSUE_TRIGGER' },
  'n8n-nodes-base.hubspotTrigger': { connector: 'hubspot', slug: 'HUBSPOT_CONTACT_CREATED_TRIGGER' },
  'n8n-nodes-base.stripeTrigger': { connector: 'stripe', slug: 'STRIPE_PAYMENT_FAILED_TRIGGER' },
  'n8n-nodes-base.todoistTrigger': { connector: 'todoist', slug: 'TODOIST_NEW_TASK_CREATED' },
  'n8n-nodes-base.trelloTrigger': { connector: 'trello', slug: 'TRELLO_NEW_CARD_TRIGGER' },
  'n8n-nodes-base.zendeskTrigger': { connector: 'zendesk', slug: 'ZENDESK_NEW_ZENDESK_TICKET_TRIGGER' },
  'n8n-nodes-base.mailchimpTrigger': { connector: 'mailchimp', slug: 'MAILCHIMP_SUBSCRIBE_TRIGGER' },
  'n8n-nodes-base.googleDriveTrigger': { connector: G, slug: 'GOOGLESUPER_FILE_CREATED_TRIGGER' },
  'n8n-nodes-base.googleSheetsTrigger': { connector: G, slug: 'GOOGLESUPER_SPREADSHEET_ROW_CHANGED_TRIGGER' },
  'n8n-nodes-base.googleCalendarTrigger': { connector: G, slug: 'GOOGLESUPER_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER' },
  'n8n-nodes-base.asanaTrigger': { connector: 'asana', slug: 'ASANA_TASK_TRIGGER' },
  'n8n-nodes-base.zoomTrigger': { connector: 'zoom', slug: 'ZOOM_NEW_MEETING_CREATED_TRIGGER' },
  // New Gmail message (googlesuper trigger); the event payload is the Gmail message, not n8n's simplified email.
  'n8n-nodes-base.gmailTrigger': { connector: G, slug: 'GOOGLESUPER_NEW_MESSAGE' },
};

/** Triggers that become the plain Start node (run on demand or via the API). */
export const START_TRIGGERS = new Set([
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.start',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.form',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.localFileTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger',
  '@n8n/n8n-nodes-langchain.manualChatTrigger',
  // Polling triggers without a Yantra webhook slug: run on demand or add a Cron.
  'n8n-nodes-base.telegramTrigger',
  'n8n-nodes-base.microsoftOutlookTrigger',
  'n8n-nodes-base.rssFeedReadTrigger',
  'n8n-nodes-base.twilioTrigger',
  'n8n-nodes-base.typeformTrigger',
  'n8n-nodes-base.stravaTrigger',
  'n8n-nodes-base.lemlistTrigger',
  'n8n-nodes-fiwano.fiwanoTrigger',
]);

export const SCHEDULE_TRIGGERS = new Set(['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.cron', 'n8n-nodes-base.interval']);

/** Helper nodes that attach to an LLM node through ai_* connections and fold into it. */
export function isFoldType(type) {
  if (!type.startsWith('@n8n/n8n-nodes-langchain.')) return type.endsWith('Tool') && !!SERVICES[type];
  const t = type.slice('@n8n/n8n-nodes-langchain.'.length);
  return (
    t.startsWith('lm') ||
    t.startsWith('memory') ||
    t.startsWith('outputParser') ||
    t.startsWith('embeddings') ||
    t.startsWith('textSplitter') ||
    t.startsWith('document') ||
    t.startsWith('retriever') ||
    t.startsWith('tool') ||
    t === 'rerankerCohere'
  );
}

export const LLM_NODES = new Set([
  '@n8n/n8n-nodes-langchain.agent',
  '@n8n/n8n-nodes-langchain.chainLlm',
  '@n8n/n8n-nodes-langchain.openAi',
  '@n8n/n8n-nodes-langchain.openAiAssistant',
  '@n8n/n8n-nodes-langchain.informationExtractor',
  '@n8n/n8n-nodes-langchain.textClassifier',
  '@n8n/n8n-nodes-langchain.sentimentAnalysis',
  '@n8n/n8n-nodes-langchain.chainSummarization',
  '@n8n/n8n-nodes-langchain.chainRetrievalQa',
  'n8n-nodes-base.openAi',
  'n8n-nodes-base.googleCloudNaturalLanguage',
  'n8n-nodes-base.awsComprehend',
]);

export const VECTOR_STORES = new Set([
  '@n8n/n8n-nodes-langchain.vectorStoreQdrant',
  '@n8n/n8n-nodes-langchain.vectorStorePinecone',
  '@n8n/n8n-nodes-langchain.vectorStoreSupabase',
  '@n8n/n8n-nodes-langchain.vectorStoreInMemory',
  '@n8n/n8n-nodes-langchain.vectorStorePGVector',
]);

export const DATA_NODES = new Set([
  'n8n-nodes-base.set',
  'n8n-nodes-base.code',
  'n8n-nodes-base.function',
  'n8n-nodes-base.functionItem',
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.splitOut',
  'n8n-nodes-base.itemLists',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.aggregate',
  'n8n-nodes-base.summarize',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.removeDuplicates',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.renameKeys',
  'n8n-nodes-base.dateTime',
  'n8n-nodes-base.markdown',
  'n8n-nodes-base.html',
  'n8n-nodes-base.wait',
  'n8n-nodes-base.executionData',
  'n8n-nodes-base.crypto',
  'n8n-nodes-base.extractFromFile',
  'n8n-nodes-base.convertToFile',
  'n8n-nodes-base.executeWorkflow',
  'n8n-nodes-base.readWriteFile',
  'n8n-nodes-base.readBinaryFile',
  'n8n-nodes-base.writeBinaryFile',
  'n8n-nodes-base.moveBinaryData',
  'n8n-nodes-base.readPDF',
  'n8n-nodes-base.compression',
  'n8n-nodes-base.executeCommand',
  'n8n-nodes-base.dataTable',
  'n8n-nodes-base.spreadsheetFile',
  'n8n-nodes-gcf.gcf',
  '@n8n/n8n-nodes-langchain.code',
]);

export const END_NODES = new Set(['n8n-nodes-base.respondToWebhook', 'n8n-nodes-base.stopAndError']);
export const HTTP_NODES = new Set([
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.httpRequestTool',
  'n8n-nodes-base.graphql',
  'n8n-nodes-base.rssFeedRead',
  'n8n-nodes-base.quickChart',
  'n8n-nodes-base.googleCloudStorage',
  // Community / niche APIs with no rich cdecli surface — convert emits HTTP stand-ins.
  'n8n-nodes-base.n8n',
  'n8n-nodes-base.googlePerspective',
  'n8n-nodes-base.venafiTlsProtectCloud',
  '@gladiator1st/n8n-nodes-magichour.magicHour',
  'n8n-nodes-fiwano.fiwano',
  '@cradl/n8n-nodes-cradlai.cradlAi',
  'n8n-nodes-youtube-transcription.youtubeTranscripter',
]);
export const DROP_NODES = new Set(['n8n-nodes-base.stickyNote', 'n8n-nodes-base.noOp']);

/** Where an n8n node lands. */
export function classify(type) {
  if (DROP_NODES.has(type)) return 'drop';
  if (START_TRIGGERS.has(type)) return 'start';
  if (SCHEDULE_TRIGGERS.has(type)) return 'cron';
  if (WEBHOOK_TRIGGERS[type]) return 'webhook';
  if (END_NODES.has(type)) return 'end';
  if (HTTP_NODES.has(type)) return 'http';
  if (LLM_NODES.has(type)) return 'llm';
  if (VECTOR_STORES.has(type)) return 'vector';
  if (isFoldType(type)) return 'fold';
  if (DATA_NODES.has(type)) return 'data';
  if (SERVICES[type]) return 'service';
  if (type.endsWith('Trigger')) return 'start';
  return 'stub';
}

// ---------------------------------------------------------------------------
// 3. Connectors the converter may emit
// ---------------------------------------------------------------------------

export const CONNECTORS = [
  ...new Set([
    ...Object.values(SERVICES).filter(Boolean).map((s) => s.connector),
    ...Object.values(WEBHOOK_TRIGGERS).map((t) => t.connector),
    'pinecone',
    'openai',
    'deepgram',
    'yantra-image-generation',
    'yantra-audio',
    'yantra-youtube-search',
    'yantra-voicebox',
    'yantra-storage',
    'firecrawl',
    'fal-ai',
    'cloudinary',
  ]),
].sort();
