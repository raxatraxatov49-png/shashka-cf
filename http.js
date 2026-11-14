// Node http.createServer орнына: handler-ді сақтап қояды, listen шақырылғанда "дайын" деп белгілейді.
const state = (globalThis.__CF = globalThis.__CF || {});
module.exports = {
  createServer(handler) {
    state.handler = handler;
    return {
      listen(_port, cb) {
        if (typeof cb === 'function') cb();
        if (typeof state.listening === 'function') state.listening();
        return this;
      },
      on() { return this; },
      close() {}
    };
  }
};
