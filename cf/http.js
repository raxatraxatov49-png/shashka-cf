// Node http.createServer орнына: handler-ді сақтап қояды, listen шақырылғанда "дайын" деп белгілейді.
const state = (globalThis.__CF = globalThis.__CF || {});
module.exports = {
  createServer(handler) {
    state.handler = handler;
    return {
      listen(_port, cb) {
        // «Дайын» белгісі жаһандық күйде сақталады: DO объектісі қайта жасалса да жоғалмайды
        state.isListening = true;
        try {
          if (typeof cb === 'function') cb();
        } finally {
          // cb қате берсе де, сервер «дайын» деп белгіленеді
          if (typeof state.listening === 'function') state.listening();
        }
        return this;
      },
      on() { return this; },
      close() {}
    };
  }
};
