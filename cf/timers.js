// Node-тағы setTimeout/setInterval қайтаратын объектінің .unref()/.ref() әдістері Workers-те жоқ болуы мүмкін.
// Таймер ішіндегі ұсталмаған қате Durable Object-ті құлатып, барлық ойыншыны бірден ағытады.
// Сондықтан әр callback қауіпсіз қабықпен орайды.
const guard = cb => typeof cb !== 'function' ? cb : (...a) => {
  try {
    const r = cb(...a);
    if (r && typeof r.catch === 'function') {
      r.catch(e => console.error('timer async error:', (e && e.stack) || e));
    }
  } catch (e) {
    console.error('timer error:', (e && e.stack) || e);
    try { globalThis.__CF && globalThis.__CF.logErr && globalThis.__CF.logErr('timer', e); } catch {}
  }
};
const wrap = fn => (cb, ...args) => {
  const id = fn(guard(cb), ...args);
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
