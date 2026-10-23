// Source: yantra-stack/.../nodes/ai/chat-model/providers.ts.
// Keep provider ids distinct from model names (a Gemini model on OpenRouter
// still uses the OpenRouter connector).
export const CHAT_MODEL_PROVIDERS = new Set(['openai', 'openrouter', 'gemini', 'ollama', 'deepseek']);

const providerNames = {
  OpenAI: 'openai', OpenRouter: 'openrouter', DeepSeek: 'deepseek', Gemini: 'gemini',
  Mistral: 'mistral', Groq: 'groq', Anthropic: 'anthropic',
};
const providerTypes = {
  lmChatOpenAi: 'openai', lmOpenAi: 'openai', lmChatOpenRouter: 'openrouter',
  lmChatGoogleGemini: 'gemini', lmChatDeepSeek: 'deepseek', lmChatOllama: 'ollama', lmOllama: 'ollama',
  lmChatMistralCloud: 'mistral', lmChatGroq: 'groq', lmChatAnthropic: 'anthropic',
};

function providerFromModel(model) {
  if (!model || /^(gpt-|o[134](?:-|$)|chatgpt-|ft:gpt-)/.test(model)) return 'openai';
  if (/^(?:models\/)?gemini-/.test(model)) return 'gemini';
  if (model.includes('/')) return 'openrouter';
  if (model.includes(':')) return 'ollama';
  if (/^deepseek-(?:chat|reasoner)$/.test(model)) return 'deepseek';
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^(?:mistral-|open-mixtral-)/.test(model)) return 'mistral';
  // Preserve unrecognized settings and flag the provider for manual selection.
  return 'unknown';
}

/** Recover settings from the saved inputs, folded model helpers and HTTP notes. */
export function legacyChatModel(wf, node) {
  const meta = wf.template.nodes?.[node.nodeId] || {};
  const originalName = meta.n8n || node.label;
  const folded = (wf.template.conversion?.folded || []).filter((f) => f.into === originalName && /\.lm/.test(f.type || ''));
  const providers = [...new Set(folded.map((f) => providerTypes[f.type.split('.').at(-1)] || f.type.split('.').at(-1)))];
  if (providers.length > 1) throw new Error(`${node.label}: multiple provider helpers require a manual mapping`);
  // Older HTTP conversions dropped the model input but kept it in this note.
  const prefix = `"${originalName}" called the `;
  const note = (wf.template.conversion?.hints || []).find((h) => h.startsWith(prefix));
  const http = note?.slice(prefix.length).match(/^(.+?) API(?: \(([^)]+)\))? over HTTP;/);
  const recordedModel = node.inputs?.model ?? meta.llmModel ?? folded.find((f) => f.model)?.model ?? http?.[2];
  const model = typeof recordedModel === 'string' && !recordedModel.startsWith('=') ? recordedModel : undefined;
  const inferred = providerFromModel(model);
  // n8n's OpenAI helper also represented compatible endpoints (DeepSeek and
  // OpenRouter). A recognizable non-OpenAI model disambiguates those exports.
  const foldedProvider = providers[0] === 'openai' && !['openai', 'unknown'].includes(inferred) ? inferred : providers[0];
  const provider = meta.llmProvider || foldedProvider || providerNames[http?.[1]] || inferred;
  // This is the previous platform default. Other providers have no catalog
  // default; an absent model becomes an explicit setup value, never a guess.
  return { provider, model: model || (provider === 'openai' ? 'gpt-4o-mini' : undefined) };
}
