import * as X from './expressions.mjs';
import { waitInterval } from './repeat-loops.mjs';

const MAX_WAIT_SECONDS = 604800;
const isDated = (value) => typeof value === 'string' &&
  /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

function blockedWait(c, node, pred, reason) {
  c.approximateStep(node, 'wait', reason, { blocker: 'wait-resume', reason });
  c.setup.add(`"${node.name}": ${reason}`);
  const stop = c.transformNode(node, 'unsupported-wait', node.name, `throw new Error(${JSON.stringify(reason)});`, pred);
  return c.simpleUnit(node.name, 'data', stop, { approximate: true });
}

export function buildWorkflowWait(c, node, pred) {
  const params = node.parameters || {};
  const mode = params.resume ?? 'timeInterval';
  let settings;
  let dynamic;
  if (mode === 'timeInterval') {
    const { amount, factor } = waitInterval(node);
    if (!factor) return blockedWait(c, node, pred, 'Choose a supported Wait interval unit in Yantra.');
    if (X.isExpression(amount)) dynamic = { socket: 'seconds', code: `return Number(${X.toJs(amount)}) * ${factor};` };
    else {
      const seconds = Number(amount) * factor;
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS) {
        return blockedWait(c, node, pred, 'Configure a Wait duration between zero and seven days in Yantra.');
      }
      settings = { seconds };
    }
    settings = { mode: 'delay', ...settings };
  } else if (mode === 'specificTime' || mode === 'specifiedTime') {
    const until = params.dateTime;
    if (X.isExpression(until)) dynamic = { socket: 'until', code: `return ${X.toJs(until)};` };
    else if (!isDated(until)) return blockedWait(c, node, pred, 'Configure a Wait timestamp with an explicit timezone in Yantra.');
    settings = { mode: 'date', ...(dynamic ? {} : { until }) };
  } else {
    return blockedWait(c, node, pred, `Configure an authenticated event or approval for the original ${mode} Wait before running.`);
  }

  const wait = c.addNode('durable-wait', node, 'NodeWorkflowWait', node.name, { ...settings, ...(pred.start ? { data: '{{ctx}}' } : {}) });
  const unit = c.simpleUnit(node.name, 'data', wait);
  unit.dataIn = () => c.sock(wait, 'data');
  if (!dynamic) return unit;

  const expression = c.transformNode(node, 'wait-expression', `Timing: ${node.name}`, dynamic.code, pred);
  c.addEdge(c.sock(expression, 'onDone'), unit.entry);
  c.addEdge(c.sock(expression, 'transformed'), c.sock(wait, dynamic.socket));
  return {
    ...unit,
    entry: c.sock(expression, 'RUN'),
    dataInAll: [unit.dataIn, () => c.sock(expression, 'source')],
  };
}
