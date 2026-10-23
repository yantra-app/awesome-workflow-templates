import * as X from './expressions.mjs';
import { waitInterval } from './repeat-loops.mjs';

const ref = (node, socket = 'transformed') => `ctx.steps?.[${JSON.stringify(node.label)}]?.[${JSON.stringify(socket)}]`;
const transform = (c, n, role, label, jsCode) => c.addNode(role, n, 'NodeTransform', label, { mode: 'jsCode', jsCode });
const trigger = (c, from, port, to) => c.addEdge(c.sock(from, port), c.sock(to, 'RUN'));
const data = (c, from, port, to, input) => c.addEdge(c.sock(from, port), c.sock(to, input));

function errorHandler(c, n, repeat) {
  const fail = transform(c, n, `repeat-error-${repeat.nodeId}`, `Failed: ${repeat.label}`,
    "throw Object.assign(new Error(source?.message || 'Repeat Until failed'), { name: source?.name || 'Error' });");
  trigger(c, repeat, 'onError', fail);
  data(c, repeat, 'error', fail, 'source');
}

export function beginRepeat(c, n, plan) {
  const capture = c.transformNode(n, 'repeat-input', `Before repeat: ${n.name}`, 'return source;', c.predInfo(n.name));
  const bodyText = [...plan.body].map((name) => JSON.stringify(c.byName.get(name).parameters || {})).join('\n');
  // Retain explicit bounds where the upstream keeps a poll budget in its state.
  // Otherwise use the native node's editable limit, including the first check.
  const maxAttempts = /\battempt\s*<\s*(\d+)/.exec(bodyText)?.[1];
  const repeat = c.addNode('repeat', n, 'NodeRepeatUntil', `Repeat: ${n.name}`, { delaySeconds: 0, maxAttempts: maxAttempts ? Number(maxAttempts) : 30 });
  if (/\$json\.maxPolls\b/.test(bodyText)) {
    const limit = c.transformNode(n, 'repeat-limit', `Attempt limit: ${n.name}`, 'return Number($json.maxPolls || 120);', { nodeType: 'NodeTransform', key: 'transformed' });
    trigger(c, capture, 'onDone', limit);
    data(c, capture, 'transformed', limit, 'source');
    trigger(c, limit, 'onDone', repeat);
    data(c, limit, 'transformed', repeat, 'maxAttempts');
  } else trigger(c, capture, 'onDone', repeat);
  const state = transform(c, n, 'repeat-state', `Return to repeat: ${n.name}`, 'return source;');
  const ready = transform(c, n, 'repeat-ready', `Ready: ${n.name}`, 'return source.ready;');
  trigger(c, state, 'onDone', ready);
  data(c, state, 'transformed', ready, 'source');
  c.addEdge(c.sock(ready, 'onDone'), c.sock(repeat, 'NEXT'));
  data(c, ready, 'transformed', repeat, 'condition');
  data(c, state, 'transformed', repeat, 'result');
  const check = transform(c, n, 'repeat-check', `Check input: ${n.name}`,
    `const ctx = {{ctx}};\nreturn ${ref(repeat, 'attempt')} === 1 ? ${ref(capture)} : ${ref(state)}?.value;`);
  trigger(c, repeat, 'onCheck', check);
  errorHandler(c, n, repeat);
  Object.assign(plan, { capture, repeat, state, check });
  c.predOverride = { name: n.name, pred: { key: 'transformed', nodeType: 'NodeTransform' } };
  c.setup.add(`"${repeat.label}" uses NodeRepeatUntil: carry each retry's state, return readiness through NEXT, and resume the selected exit only after onDone. Original interval waits are preserved. ${maxAttempts ? `The original ${maxAttempts}-attempt bound is retained.` : /\$json\.maxPolls\b/.test(bodyText) ? 'maxPolls controls the attempt limit.' : 'The attempt limit defaults to 30; adjust maxAttempts for the service or retry budget.'} Exhaustion stops with an error.`);
}

/** Preserve an interval at its original position, including before check one. */
export function buildRepeatWait(c, n, pred) {
  const { amount, factor } = waitInterval(n);
  if (!factor) throw new Error(`Unknown wait unit at ${n.name}`);
  const capture = c.transformNode(n, 'wait-input', `Before wait: ${n.name}`, 'return source;', pred);
  const seconds = c.transformNode(n, 'wait-seconds', `Seconds: ${n.name}`, `return Number(${X.toJs(amount)}) * ${factor};`, { nodeType: 'NodeTransform', key: 'transformed' });
  const repeat = c.addNode('wait-repeat', n, 'NodeRepeatUntil', n.name, { delaySeconds: 0, maxAttempts: 2 });
  const ready = transform(c, n, 'wait-ready', `Wait elapsed: ${n.name}`, 'return source === 2;');
  trigger(c, capture, 'onDone', seconds);
  data(c, capture, 'transformed', seconds, 'source');
  trigger(c, seconds, 'onDone', repeat);
  data(c, seconds, 'transformed', repeat, 'delaySeconds');
  trigger(c, repeat, 'onCheck', ready);
  data(c, repeat, 'attempt', ready, 'source');
  c.addEdge(c.sock(ready, 'onDone'), c.sock(repeat, 'NEXT'));
  data(c, ready, 'transformed', repeat, 'condition');
  data(c, capture, 'transformed', repeat, 'result');
  errorHandler(c, n, repeat);
  return { name: n.name, kind: 'repeat-wait', entry: c.sock(capture, 'RUN'), dataIn: () => c.sock(capture, 'source'),
    exits: [{ trigger: c.sock(repeat, 'onDone'), data: c.dataExit(repeat) }], lastNode: repeat, flags: {} };
}

function connect(c, e, output, value) {
  const unit = c.units.get(e.dst);
  if (c.loopReturns.has(e)) {
    c.addEdge(output, c.sock(unit.loopNode, 'NEXT'));
    c.addEdge(value, c.sock(unit.loopNode, 'result'));
    return;
  }
  const next = c.repeatLoops.get(e.dst);
  const entry = next ? c.sock(next.capture, 'RUN') : unit.entry;
  if (entry) c.addEdge(output, entry);
  const inputs = next ? [() => c.sock(next.capture, 'source')] : unit.dataInAll || (unit.dataIn ? [unit.dataIn] : []);
  for (const input of inputs) {
    const target = input(e.inIdx);
    if (target && value && !value.start) c.addEdge(value, target);
  }
}

export function wireRepeats(c) {
  for (const [name, plan] of c.repeatLoops) {
    const n = c.byName.get(name);
    const { capture, repeat, check, state } = plan;
    const entry = c.units.get(name);
    c.addEdge(c.sock(check, 'onDone'), entry.entry);
    for (const input of entry.dataInAll || (entry.dataIn ? [entry.dataIn] : [])) {
      const target = input(0);
      if (target) c.addEdge(c.sock(check, 'transformed'), target);
    }
    for (const e of plan.incoming) {
      // An exit from a preceding conditional loop is connected by its router.
      if (c.repeatIntercepts.has(e)) continue;
      const source = c.units.get(e.src);
      const exit = source.exits[e.outIdx];
      if (!exit?.trigger) throw new Error(`Missing repeat entry trigger: ${e.src}`);
      c.addEdge(exit.trigger, c.sock(capture, 'RUN'));
      const value = c.resolveData(source, e.outIdx);
      if (value && !value.start) c.addEdge(value, c.sock(capture, 'source'));
    }
    const ports = new Map();
    for (const e of [...plan.returns, ...plan.exits]) {
      const key = JSON.stringify([e.src, e.outIdx]);
      if (!ports.has(key)) ports.set(key, { src: e.src, index: e.outIdx, retry: plan.returns.includes(e), edges: [] });
      ports.get(key).edges.push(e);
    }
    // Unconnected branch outputs mean stop in the original. Complete the
    // controller with that payload instead of leaving an active check stranded.
    for (const name of plan.body) {
      const unit = c.units.get(name);
      if (unit.kind !== 'branch') continue;
      unit.exits.forEach((exit, index) => {
        if (exit?.trigger && !c.rawEdges.some((e) => e.src === name && e.outIdx === index)) {
          ports.set(JSON.stringify([name, index]), { src: name, index, retry: false, edges: [] });
        }
      });
    }
    let route = 0;
    for (const port of ports.values()) {
      const source = c.units.get(port.src);
      const exit = source.exits[port.index];
      if (!exit?.trigger) throw new Error(`Unsupported repeat return output: ${port.src}[${port.index}]`);
      const value = c.resolveData(source, port.index);
      const id = route++;
      const ret = transform(c, n, `repeat-return-${id}`, `${port.retry ? 'Retry' : 'Finish'}: ${port.src} (${port.index})`,
        `return { ready: ${!port.retry}, route: ${id}, value: source };`);
      c.addEdge(exit.trigger, c.sock(ret, 'RUN'));
      if (value && !value.start) c.addEdge(value, c.sock(ret, 'source'));
      trigger(c, ret, 'onDone', state);
      data(c, ret, 'transformed', state, 'source');
      if (port.retry) continue;
      const selected = transform(c, n, `repeat-route-${id}`, `Exit ${id}: ${name}`, `return source.route === ${id};`);
      const branch = c.addNode(`repeat-branch-${id}`, n, 'NodeBranch', `Select exit ${id}: ${name}`, {});
      const result = transform(c, n, `repeat-result-${id}`, `Result ${id}: ${name}`, 'return source.value;');
      trigger(c, repeat, 'onDone', selected);
      data(c, repeat, 'result', selected, 'source');
      trigger(c, selected, 'onDone', branch);
      data(c, selected, 'transformed', branch, 'condition');
      trigger(c, branch, 'TRUE', result);
      data(c, repeat, 'result', result, 'source');
      if (port.edges.length) {
        for (const e of port.edges) connect(c, e, c.sock(result, 'onDone'), c.sock(result, 'transformed'));
      } else {
        const end = c.addNode(`repeat-end-${id}`, n, 'NodeEnd', `End: ${port.src} (${port.index})`, {});
        data(c, result, 'transformed', end, 'result');
      }
    }
  }
}
