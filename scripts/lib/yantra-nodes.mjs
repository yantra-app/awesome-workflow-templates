// Socket catalog for the Yantra workflow node types this repository emits.
//
// Source of truth: yantra-stack packages-modules/workflow-editor/core/src/nodes/**
// (published as @adminide-stack/workflow-editor-core; checked against
// 5.12.1-alpha.263: flow/control/iterator.js, flow/control/update-context.js,
// flow/timing/cron.js, integrations/workflow-configs.js).
// Every key below is an `x-key` from those node definitions. The converter uses
// this table to wire edges and the validator uses it to reject edges that name a
// socket the editor does not have. Keep it in sync when a node gains a socket.

/** @typedef {{ type: string, trigger?: boolean }} Socket */

/** @type {Record<string, { inputs: Record<string, Socket>, outputs: Record<string, Socket>, size: {width:number,height:number}, color: string }>} */
export const NODE_TYPES = {
  NodeStart: {
    inputs: {},
    outputs: { trigger: { type: 'trigger', trigger: true } },
    size: { width: 240, height: 100 },
    color: '#22C55E',
  },
  NodeEnd: {
    inputs: { result: { type: 'any' } },
    outputs: { result: { type: 'object' } },
    size: { width: 240, height: 100 },
    color: '#EF4444',
  },
  NodeCron: {
    inputs: {
      interval: { type: 'number' },
      cronExpression: { type: 'string' },
      payload: { type: 'object' },
      maxRuns: { type: 'number' },
      startTime: { type: 'string' },
      endTime: { type: 'string' },
      timezone: { type: 'string' },
      START: { type: 'trigger', trigger: true },
      STOP: { type: 'trigger', trigger: true },
    },
    outputs: {
      onTick: { type: 'trigger', trigger: true },
      tick: { type: 'string' },
      payload: { type: 'object' },
      count: { type: 'number' },
    },
    size: { width: 280, height: 200 },
    color: '#14B8A6',
  },
  NodeCdeWebhookTrigger: {
    inputs: {
      connector: { type: 'string' },
      webhookEndpointId: { type: 'string' },
      triggerSlug: { type: 'string' },
      connectedAccountId: { type: 'string' },
      config: { type: 'object' },
      simulatePayload: { type: 'object' },
      responseMode: { type: 'string' },
      START: { type: 'trigger', trigger: true },
      STOP: { type: 'trigger', trigger: true },
      SIMULATE: { type: 'trigger', trigger: true },
    },
    outputs: {
      onEvent: { type: 'trigger', trigger: true },
      eventName: { type: 'string' },
      payload: { type: 'object' },
      connectedAccountId: { type: 'string' },
      triggerSlug: { type: 'string' },
      count: { type: 'number' },
      headers: { type: 'object' },
      query: { type: 'object' },
      method: { type: 'string' },
      rawBody: { type: 'string' },
      deliveryId: { type: 'string' },
      idempotencyKey: { type: 'string' },
      responseMode: { type: 'string' },
      responseUrl: { type: 'string' },
      responseToken: { type: 'string' },
    },
    size: { width: 320, height: 220 },
    color: '#6366F1',
  },
  NodeCdeConnector: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      action: { type: 'string' },
      params: { type: 'object' },
      credential: { type: 'string' },
      connectorVersion: { type: 'string' },
      timeout: { type: 'number' },
      authType: { type: 'string' },
    },
    outputs: {
      onDone: { type: 'trigger', trigger: true },
      result: { type: 'object' },
      error: { type: 'object' },
    },
    size: { width: 280, height: 200 },
    color: '#6366F1',
  },
  NodeTransform: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      source: { type: 'any' },
      fields: { type: 'array' },
      mode: { type: 'string' },
      jsCode: { type: 'string' },
    },
    outputs: {
      onDone: { type: 'trigger', trigger: true },
      transformed: { type: 'any' },
      error: { type: 'object' },
    },
    size: { width: 280, height: 220 },
    color: '#F59E0B',
  },
  NodeHttpRequest: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      url: { type: 'string' },
      method: { type: 'string' },
      headers: { type: 'object' },
      body: { type: 'any' },
    },
    outputs: {
      statusCode: { type: 'number' },
      body: { type: 'any' },
      headers: { type: 'object' },
      error: { type: 'object' },
      onDone: { type: 'trigger', trigger: true },
    },
    size: { width: 280, height: 220 },
    color: '#0EA5E9',
  },
  NodeBranch: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      condition: { type: 'boolean' },
    },
    outputs: {
      TRUE: { type: 'trigger', trigger: true },
      FALSE: { type: 'trigger', trigger: true },
    },
    size: { width: 240, height: 140 },
    color: '#0EA5E9',
  },
  // flow/control/loop.ts: sequential body, explicit return, ordered results.
  NodeLoop: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      items: { type: 'array' },
      NEXT: { type: 'trigger', trigger: true },
      result: { type: 'any' },
      error: { type: 'any' },
    },
    outputs: {
      onItem: { type: 'trigger', trigger: true },
      item: { type: 'any' },
      index: { type: 'number' },
      onDone: { type: 'trigger', trigger: true },
      results: { type: 'array' },
      onError: { type: 'trigger', trigger: true },
      error: { type: 'any' },
    },
    size: { width: 280, height: 220 },
    color: '#0EA5E9',
  },
  NodeRepeatUntil: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      NEXT: { type: 'trigger', trigger: true },
      condition: { type: 'boolean' },
      delaySeconds: { type: 'number' },
      maxAttempts: { type: 'number' },
      result: { type: 'any' },
      error: { type: 'any' },
    },
    outputs: {
      onCheck: { type: 'trigger', trigger: true },
      attempt: { type: 'number' },
      onDone: { type: 'trigger', trigger: true },
      result: { type: 'any' },
      onError: { type: 'trigger', trigger: true },
      error: { type: 'any' },
    },
    size: { width: 280, height: 220 },
    color: '#0EA5E9',
  },
  // A manual cursor, not a body runner. NEXT past the end is a no-op.
  NodeIterator: {
    inputs: {
      source: { type: 'array' },
      NEXT: { type: 'trigger', trigger: true },
      PREV: { type: 'trigger', trigger: true },
      RESET: { type: 'trigger', trigger: true },
    },
    outputs: {
      index: { type: 'number' },
      value: { type: 'any' },
    },
    size: { width: 240, height: 180 },
    color: '#0EA5E9',
  },
  // Shallow-patches the run context mid-run (reserved keys are protected).
  NodeUpdateContext: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      patch: { type: 'object' },
    },
    outputs: {
      onDone: { type: 'trigger', trigger: true },
      context: { type: 'object' },
    },
    size: { width: 240, height: 140 },
    color: '#0EA5E9',
  },
  NodeSync: {
    inputs: { data1: { type: 'any' }, data2: { type: 'any' } },
    outputs: {
      onDone: { type: 'trigger', trigger: true },
      data1: { type: 'any' },
      data2: { type: 'any' },
    },
    size: { width: 240, height: 160 },
    color: '#0EA5E9',
  },
  // yantra-stack core/src/nodes/ai/{chat-model,llm-chain}. Legacy definitions
  // remain below for the converter's intermediate graph and migration input.
  NodeChatModel: {
    inputs: {
      provider: { type: 'string' },
      credential: { type: 'string' },
      model: { type: 'string' },
      temperature: { type: 'number' },
      maxTokens: { type: 'number' },
    },
    outputs: { config: { type: 'object' }, status: { type: 'string' } },
    size: { width: 280, height: 220 },
    color: '#8B5CF6',
  },
  NodeLlmChain: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      prompt: { type: 'string' },
      system: { type: 'string' },
      messages: { type: 'array' },
      llm: { type: 'object' },
      outputMode: { type: 'string' },
      schemaMode: { type: 'string' },
      schema: { type: 'object' },
    },
    outputs: {
      onDone: { type: 'trigger', trigger: true },
      text: { type: 'string' },
      object: { type: 'object' },
      usage: { type: 'object' },
      error: { type: 'object' },
    },
    size: { width: 320, height: 260 },
    color: '#8B5CF6',
  },
  NodeCdecliChatCompletion: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      message: { type: 'string' },
      system: { type: 'string' },
      model: { type: 'string' },
      temperature: { type: 'number' },
      credential: { type: 'string' },
      skill: { type: 'string' },
      noTools: { type: 'boolean' },
      sessionId: { type: 'string' },
    },
    outputs: {
      onDone: { type: 'trigger', trigger: true },
      text: { type: 'string' },
      delta: { type: 'string' },
      sessionId: { type: 'string' },
      error: { type: 'object' },
    },
    size: { width: 320, height: 260 },
    color: '#8B5CF6',
  },
  NodeCdeGenerateObject: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      prompt: { type: 'string' },
      system: { type: 'string' },
      schema: { type: 'object' },
      model: { type: 'string' },
      temperature: { type: 'number' },
      credential: { type: 'string' },
    },
    outputs: {
      onDone: { type: 'trigger', trigger: true },
      object: { type: 'object' },
      error: { type: 'object' },
    },
    size: { width: 320, height: 260 },
    color: '#8B5CF6',
  },
  NodeCdecliAgent: {
    inputs: {
      RUN: { type: 'trigger', trigger: true },
      message: { type: 'string' },
      system: { type: 'string' },
      model: { type: 'string' },
      skills: { type: 'array' },
      sessionId: { type: 'string' },
      credential: { type: 'string' },
      plan: { type: 'boolean' },
      smartRouting: { type: 'boolean' },
      noTools: { type: 'boolean' },
      permissionMode: { type: 'string' },
      yolo: { type: 'boolean' },
      sandbox: { type: 'boolean' },
      sandboxId: { type: 'string' },
    },
    outputs: {
      onDone: { type: 'trigger', trigger: true },
      text: { type: 'string' },
      delta: { type: 'string' },
      usedTools: { type: 'array' },
      sessionId: { type: 'string' },
      error: { type: 'object' },
      onToolCall: { type: 'trigger', trigger: true },
      toolName: { type: 'string' },
      toolInput: { type: 'object' },
    },
    size: { width: 320, height: 260 },
    color: '#8B5CF6',
  },
  NodeWorkflowConfigs: {
    inputs: {
      projectId: { type: 'string' },
      environmentTagId: { type: 'string' },
      commandOnServer: { type: 'boolean' },
      forceUpdateConnector: { type: 'boolean' },
      tokenExpirySeconds: { type: 'number' },
      cdecliMinVersion: { type: 'string' },
      initialContext: { type: 'object' },
      // One child run per item, each seeded with that item as its initial context.
      iteratingInitialContexts: { type: 'array' },
      initialContextMaxConcurrency: { type: 'number' },
    },
    outputs: {},
    size: { width: 280, height: 200 },
    color: 'default',
  },
};

/**
 * Which output socket carries a node's "payload" for the next step, and under
 * which key the run context (`{{last.<key>...}}`) exposes it. Nodes that carry
 * no data (Start, Branch) have none: their successors read run inputs directly
 * or inherit the data of the node before them.
 */
export const DATA_OUTPUT = {
  NodeRepeatUntil: 'result',
  NodeLoop: 'results',
  NodeCron: 'payload',
  NodeCdeWebhookTrigger: 'payload',
  NodeCdeConnector: 'result',
  NodeTransform: 'transformed',
  NodeHttpRequest: 'body',
  NodeCdecliChatCompletion: 'text',
  NodeCdeGenerateObject: 'object',
  NodeCdecliAgent: 'text',
  NodeSync: 'data1',
  NodeUpdateContext: 'context',
};

/** The trigger output that fires when a node completes normally. */
export const DONE_OUTPUT = {
  NodeRepeatUntil: 'onDone',
  NodeLoop: 'onDone',
  NodeLlmChain: 'onDone',
  NodeStart: 'trigger',
  NodeCron: 'onTick',
  NodeCdeWebhookTrigger: 'onEvent',
  NodeCdeConnector: 'onDone',
  NodeTransform: 'onDone',
  NodeHttpRequest: 'onDone',
  NodeSync: 'onDone',
  NodeUpdateContext: 'onDone',
  NodeCdecliChatCompletion: 'onDone',
  NodeCdeGenerateObject: 'onDone',
  NodeCdecliAgent: 'onDone',
};

/** The trigger input that starts a node, when it has one. */
export const RUN_INPUT = {
  NodeRepeatUntil: 'RUN',
  NodeLoop: 'RUN',
  NodeLlmChain: 'RUN',
  NodeCdeConnector: 'RUN',
  NodeTransform: 'RUN',
  NodeHttpRequest: 'RUN',
  NodeBranch: 'RUN',
  NodeUpdateContext: 'RUN',
  NodeCdecliChatCompletion: 'RUN',
  NodeCdeGenerateObject: 'RUN',
  NodeCdecliAgent: 'RUN',
};

/** The data input that receives the previous node's payload, when it has one. */
export const DATA_INPUT = {
  NodeLoop: 'items',
  NodeTransform: 'source',
  NodeEnd: 'result',
};

export const ENTRY_TYPES = new Set(['NodeStart', 'NodeCron', 'NodeCdeWebhookTrigger']);

/** Socket types that may be connected. `any` is compatible with everything. */
export function socketsCompatible(outType, inType) {
  if (outType === 'any' || inType === 'any') return true;
  return outType === inType;
}
