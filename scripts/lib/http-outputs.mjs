const strings = (value) => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const mapStrings = (value, replace) => {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, replace));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, replace)]));
  return value;
};

/** Give referenced HTTP actors distinct names and read their actual body socket. */
export function preserveHttpOutputs(wf) {
  let named = 0;
  for (const http of wf.nodes.filter((node) => node.type === 'NodeHttpRequest')) {
    const key = `http_${http.nodeId.slice(5)}`;
    const labelRead = `__namedCtx.steps?.[${JSON.stringify(http.label)}]?.["body"]`;
    const legacy = new RegExp(`\\{\\{steps\\.${key}\\.result(?=[.}])`, 'g');
    const rewrite = (text) => text.replaceAll(labelRead, `__namedCtx.steps?.[${JSON.stringify(key)}]?.["body"]`).replace(legacy, `{{steps.${key}.body`);
    const consumers = wf.nodes.filter((node) => strings(node.inputs).some((text) => rewrite(text) !== text));
    if (!consumers.length) continue;
    consumers.forEach((node) => { node.inputs = mapStrings(node.inputs, rewrite); });
    // Both cdecli and editor imports copy legacy data fields to the actor
    // context as well as inputs. data.name sets context.name; a canvas label
    // alone does not, so otherwise every HTTP actor is named "HTTP Request".
    http.data = { ...http.data, name: key };
    named++;
  }
  return named;
}
