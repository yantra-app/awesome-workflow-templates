// n8n v1/v2 put the batch on output 0; v3 puts it on output 1.
// Return edges belong to the loop protocol, not to the DAG used to order nodes.
export function planItemLoops(nodes, edges) {
  const plans = new Map();
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const outgoing = (name) => edges.filter((e) => e.src === name);
  for (const n of nodes) {
    if (n.type !== 'n8n-nodes-base.splitInBatches') continue;
    const bodyIndex = Number(n.typeVersion || 1) >= 3 ? 1 : 0;
    const doneIndex = bodyIndex === 1 ? 0 : 1;
    const body = new Set();
    const queue = outgoing(n.name).filter((e) => e.outIdx === bodyIndex).map((e) => e.dst);
    while (queue.length) {
      const name = queue.pop();
      if (name === n.name || body.has(name)) continue;
      body.add(name);
      queue.push(...outgoing(name).map((e) => e.dst));
    }
    const returns = edges.filter((e) => e.dst === n.name && body.has(e.src));
    const selfEdges = edges.filter((e) => e.src === n.name && e.dst === n.name);
    const reset = n.parameters?.options?.reset;
    const earlyExit = [...body].some((name) => outgoing(name).length === 0 && byName.get(name)?.type !== 'n8n-nodes-base.stopAndError');
    // A single exclusive If branch can leave the loop before the remaining batches.
    // Keep the exit path outside the body so it runs with the parent scope.
    let breakEdge;
    if (earlyExit && !reset && !outgoing(n.name).some((e) => e.outIdx === doneIndex)) {
      const returning = new Set(returns.map((e) => e.src));
      const upstream = [...returning];
      while (upstream.length) {
        const target = upstream.pop();
        for (const e of edges) {
          if (e.dst !== target || !body.has(e.src) || returning.has(e.src)) continue;
          returning.add(e.src);
          upstream.push(e.src);
        }
      }
      const exits = edges.filter((e) => returning.has(e.src) && e.dst !== n.name && !returning.has(e.dst));
      const exit = exits[0];
      if (exits.length === 1 &&
          byName.get(exit.src)?.type === 'n8n-nodes-base.if' &&
          outgoing(exit.src).filter((e) => e.outIdx === exit.outIdx).length === 1 &&
          outgoing(n.name).filter((e) => e.outIdx === bodyIndex).every((e) => returning.has(e.dst))) {
        breakEdge = exit;
        for (const name of body) if (!returning.has(name)) body.delete(name);
      }
    }
    plans.set(n.name, {
      bodyIndex, doneIndex, body, returns, selfEdges, earlyExit, breakEdge,
      // No return means n8n only emits its first batch. Do not invent repetition.
      native: returns.length > 0 && !reset && (!earlyExit || !!breakEdge),
      takeOnly: returns.length === 0 && !reset,
      batchSize: n.parameters?.batchSize ?? (Number(n.typeVersion || 1) >= 3 ? 1 : 10),
    });
  }
  return plans;
}

/** Ignore feedback when computing canvas columns. */
export function isLoopReturn(edge) {
  return (edge.targetNodeType === 'NodeLoop' && ['NEXT', 'result', 'error', 'BREAK', 'breakResult'].includes(edge.targetInput)) ||
    (edge.targetNodeType === 'NodeRepeatUntil' && ['NEXT', 'condition', 'result', 'error'].includes(edge.targetInput));
}

/** Structural checks shared by fixtures and the repository validator. */
export function validateItemLoops(wf) {
  const errors = [];
  for (const n of wf.nodes.filter((n) => n.type === 'NodeLoop')) {
    const input = (port) => wf.edges.filter((e) => e.target === n.nodeId && e.targetInput === port);
    const output = (port) => wf.edges.filter((e) => e.source === n.nodeId && e.sourceOutput === port);
    if (!input('RUN').length) errors.push(`${n.label}: NodeLoop needs an initial RUN trigger`);
    if (!input('items').length && !Array.isArray(n.inputs?.items)) errors.push(`${n.label}: NodeLoop needs an items array`);
    if (!output('onItem').length || !input('NEXT').length) errors.push(`${n.label}: NodeLoop needs a body and a NEXT return`);
    if (!output('onDone').length && !output('results').length && !output('onBreak').length) errors.push(`${n.label}: NodeLoop needs a final continuation`);
    if (!!input('BREAK').length !== !!output('onBreak').length) errors.push(`${n.label}: BREAK and On Break must both be wired`);
    const seen = new Set();
    const queue = output('onItem').map((e) => e.target);
    while (queue.length) {
      const id = queue.pop();
      if (id === n.nodeId || seen.has(id)) continue;
      seen.add(id);
      for (const e of wf.edges.filter((e) => e.source === id)) {
        if (e.target === n.nodeId && e.targetInput === 'RUN') errors.push(`${n.label}: body must return to NEXT, not RUN`);
        if (['RUN', 'NEXT'].includes(e.targetInput) || e.sourceNodeType === 'NodeBranch') queue.push(e.target);
      }
    }
  }
  return [...new Set(errors)];
}
