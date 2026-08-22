function makeAbortError(message = 'The request was aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Correlates app-server requests initiated by DSHX with responses from the TUI.
 * The broker owns no approval policy: transport loss, timeout and cancellation
 * reject the presentation request so the DSH answerer can fail closed.
 */
export class UiRequestBroker {
  constructor({ send, timeoutMs = 120_000, idPrefix = 'dshx-ui' } = {}) {
    if (typeof send !== 'function') throw new Error('UiRequestBroker requires send(message)');
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.idPrefix = idPrefix;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  request(method, params, { signal } = {}) {
    if (this.closed) return Promise.reject(new Error('UI request broker is closed'));
    if (signal?.aborted) return Promise.reject(makeAbortError());

    const id = `${this.idPrefix}-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(entry.timer);
        signal?.removeEventListener('abort', entry.onAbort);
        this.pending.delete(id);
      };
      const entry = {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
        onAbort: () => entry.reject(makeAbortError()),
        timer: undefined
      };
      entry.timer = setTimeout(
        () => entry.reject(new Error(`UI request timed out: ${method}`)),
        this.timeoutMs
      );
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.pending.set(id, entry);

      try {
        this.send({ id, method, params });
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Consume a client response (`{id,result}` or `{id,error}`). Returns false
   * when the id does not belong to an outstanding server-initiated request.
   */
  handleResponse(message) {
    if (!message || message.id === undefined || message.method !== undefined) return false;
    const entry = this.pending.get(String(message.id));
    if (!entry) return false;
    if (message.error !== undefined) {
      const error = new Error(message.error?.message ?? 'TUI request failed');
      error.code = message.error?.code;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
    return true;
  }

  close(reason = 'UI transport closed') {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.pending.values()];
    for (const entry of entries) entry.reject(new Error(reason));
  }
}
