// Plan single-entry conditional cycles after item-loop feedback is removed.
// Keep feedback separate from the DAG used to build nodes and place the canvas.
export function planRepeatLoops(nodes, edges, allEdges = edges) {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const reach = (start, allowed = edges) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const name = queue.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...allowed.filter((e) => e.src === name).map((e) => e.dst));
    }
    return seen;
  };
  const reachable = new Map(nodes.map((n) => [n.name, reach(n.name)]));
  const visited = new Set();
  const plans = new Map();
  const deferred = [];
  for (const n of nodes) {
    if (visited.has(n.name)) continue;
    const body = new Set([...reachable.get(n.name)].filter((name) => reachable.get(name)?.has(n.name)));
    for (const name of body) visited.add(name);
    if (body.size === 1 && !edges.some((e) => e.src === n.name && e.dst === n.name)) continue;
    const members = [...body].map((name) => byName.get(name));
    const incoming = edges.filter((e) => !body.has(e.src) && body.has(e.dst));
    const entries = [...new Set(incoming.map((e) => e.dst))];
    let reason;
    if (members.some((n) => n.type === 'n8n-nodes-base.form' || n.parameters?.operation === 'sendAndWait' ||
      (n.type === 'n8n-nodes-base.wait' && ![undefined, 'timeInterval'].includes(n.parameters?.resume)))) {
      reason = 'requires a resumable human/form/webhook response before another attempt';
    } else if (members.some((n) => n.type === 'n8n-nodes-base.splitInBatches')) {
      reason = 'requires an item cursor with successful early exit and separate service-error returns';
    } else if (members.some((n) => /\$runIndex|\.all\([^)]*,/.test(JSON.stringify(n.parameters || {})))) {
      reason = 'requires per-attempt execution history for its accumulated results';
    } else if (entries.length !== 1) reason = 'has multiple cycle entry points';
    const entry = entries[0];
    const returns = edges.filter((e) => body.has(e.src) && e.dst === entry);
    const forward = edges.filter((e) => !returns.includes(e) && body.has(e.src) && body.has(e.dst));
    if (!reason && forward.some((e) => reach(e.dst, forward).has(e.src))) reason = 'contains another conditional cycle';
    if (reason) { deferred.push({ name: entry || n.name, reason }); continue; }
    const exits = allEdges.filter((e) => body.has(e.src) && !body.has(e.dst));
    plans.set(entry, { entry, body, returns, incoming, exits });
  }
  return { plans, deferred };
}

// n8n Wait v1 defaults to one hour; v1.1 defaults to five seconds.
export function waitInterval(n) {
  const p = n.parameters || {};
  const legacy = Number(n.typeVersion || 1) === 1;
  const unit = p.unit || (legacy ? 'hours' : 'seconds');
  return { amount: p.amount ?? (legacy ? 1 : 5), factor: { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[unit] };
}

export function validateRepeatLoops(wf) {
  const errors = [];
  for (const node of wf.nodes.filter((n) => n.type === 'NodeRepeatUntil')) {
    const input = (port) => wf.edges.filter((e) => e.target === node.nodeId && e.targetInput === port);
    const output = (port) => wf.edges.filter((e) => e.source === node.nodeId && e.sourceOutput === port);
    for (const port of ['RUN', 'NEXT', 'condition']) if (!input(port).length) errors.push(`${node.label}: NodeRepeatUntil needs ${port}`);
    for (const port of ['onCheck', 'onDone', 'onError']) if (!output(port).length) errors.push(`${node.label}: NodeRepeatUntil needs ${port} handling`);
    const max = node.inputs?.maxAttempts;
    if (!input('maxAttempts').length && (!Number.isSafeInteger(max) || max < 1)) errors.push(`${node.label}: NodeRepeatUntil needs a positive maxAttempts`);
    const delay = node.inputs?.delaySeconds;
    if (!input('delaySeconds').length && (!Number.isFinite(delay) || delay < 0 || delay > 2147483.647)) errors.push(`${node.label}: NodeRepeatUntil needs a valid delaySeconds`);
    const queue = output('onCheck').map((e) => e.target);
    const seen = new Set();
    while (queue.length) {
      const id = queue.pop();
      if (id === node.nodeId || seen.has(id)) continue;
      seen.add(id);
      for (const e of wf.edges.filter((e) => e.source === id)) {
        if (e.target === node.nodeId && e.targetInput === 'RUN') errors.push(`${node.label}: check must return to NEXT, not RUN`);
        if (['RUN', 'NEXT'].includes(e.targetInput)) queue.push(e.target);
      }
    }
  }
  return [...new Set(errors)];
}
