// Node-тағы setTimeout/setInterval қайтаратын объектінің .unref()/.ref() әдістері Workers-те жоқ болуы мүмкін.
const wrap = fn => (...args) => {
  const id = fn(...args);
  if (id !== null && typeof id === 'object') {
    if (typeof id.unref !== 'function') id.unref = () => id;
    if (typeof id.ref !== 'function') id.ref = () => id;
    return id;
  }
  return {
    _id: id,
    unref() { return this; },
    ref() { return this; },
    hasRef() { return true; },
    refresh() { return this; },
    [Symbol.toPrimitive]() { return id; }
  };
};
const rawSetTimeout = globalThis.setTimeout.bind(globalThis);
const rawSetInterval = globalThis.setInterval.bind(globalThis);
const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);
const rawClearInterval = globalThis.clearInterval.bind(globalThis);
const unwrap = t => (t && typeof t === 'object' && '_id' in t ? t._id : t);
globalThis.setTimeout = wrap(rawSetTimeout);
globalThis.setInterval = wrap(rawSetInterval);
globalThis.clearTimeout = t => rawClearTimeout(unwrap(t));
globalThis.clearInterval = t => rawClearInterval(unwrap(t));
