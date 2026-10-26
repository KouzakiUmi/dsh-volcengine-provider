/** Keep a retired adapter scope alive while calls still hold its prepared state. */
export function createAdapterLease(dispose, onDisposeError) {
  let references = 0;
  let retired = false;
  let closed = false;
  let closing;
  async function close() {
    if (!closing) {
      closed = true;
      closing = Promise.resolve().then(dispose);
      if (onDisposeError) closing = closing.catch(error => { onDisposeError(error); });
    }
    return closing;
  }
  return {
    get closed() { return closed; },
    get references() { return references; },
    retain() {
      if (closed) throw new Error('模型适配器已卸载');
      references += 1;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        references -= 1;
        if (retired && references === 0) await close();
      };
    },
    async retire() {
      retired = true;
      if (references === 0) await close();
    },
    dispose: close
  };
}

// Keep the registry's held callback in a separate lexical scope. Otherwise it
// can retain the iterator's bound return/throw methods and prevent collection.
function streamRelease(held, finalizers, token) {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    finalizers?.unregister(token);
    await held();
  };
}

/** Release completed streams, including early cancellation and thrown errors. */
export function leasedStream(createStream, lease, release, finalizers) {
  const held = release ?? lease.retain();
  const token = {};
  let started = false;
  const finish = streamRelease(held, finalizers, token);
  const iterator = (async function* () {
    started = true;
    try {
      if (lease.closed) throw new Error('模型适配器已卸载');
      yield* createStream();
    } finally {
      await finish();
    }
  })();
  const originalReturn = iterator.return.bind(iterator);
  const originalThrow = iterator.throw.bind(iterator);
  iterator.return = async value => {
    if (!started) await finish();
    return originalReturn(value);
  };
  iterator.throw = async error => {
    if (!started) await finish();
    return originalThrow(error);
  };
  finalizers?.register(iterator, finish, token);
  return iterator;
}
