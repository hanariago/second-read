// Transport that forwards model calls to the Electron main process, which
// holds the OAuth tokens. A browser build would supply a different transport.
export function createBridgeTransport(bridge) {
  return {
    async complete({ instructions, input, schema, signal }) {
      const id = crypto.randomUUID();
      const onAbort = () => bridge.abort(id);
      signal?.addEventListener('abort', onAbort);
      try {
        const r = await bridge.complete(id, { instructions, input, schema });
        if (!r.ok) {
          const e = new Error(r.error?.message || r.error?.code);
          e.code = r.error?.code;
          e.fatal = r.error?.fatal;
          throw e;
        }
        return r;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
