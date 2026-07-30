export function createScreenWakeLock({
  navigatorObject = globalThis.navigator,
  documentObject = globalThis.document,
} = {}) {
  let sentinel = null;
  let active = false;
  let listening = false;
  let pendingAcquire = null;

  const acquire = async () => {
    if (
      !active ||
      sentinel ||
      !navigatorObject?.wakeLock?.request ||
      documentObject?.visibilityState !== 'visible'
    ) {
      return sentinel;
    }
    if (pendingAcquire) return pendingAcquire;

    const request = (async () => {
      try {
        const acquired = await navigatorObject.wakeLock.request('screen');
        if (!acquired) return null;
        if (!active || documentObject?.visibilityState !== 'visible') {
          try {
            await acquired.release?.();
          } catch {
            // The lock is already inactive; there is nothing else to release.
          }
          return null;
        }

        sentinel = acquired;
        try {
          acquired.addEventListener?.('release', () => {
            if (sentinel === acquired) sentinel = null;
          });
        } catch {
          // Some partial Wake Lock implementations omit event support.
        }
        return acquired;
      } catch {
        return null;
      }
    })();
    pendingAcquire = request;

    try {
      return await request;
    } finally {
      if (pendingAcquire === request) pendingAcquire = null;
    }
  };

  const handleVisibilityChange = () => {
    if (documentObject?.visibilityState === 'visible') void acquire();
  };

  return {
    async start() {
      active = true;
      if (!listening) {
        documentObject?.addEventListener?.('visibilitychange', handleVisibilityChange);
        listening = true;
      }
      return acquire();
    },

    async stop() {
      active = false;
      if (listening) {
        documentObject?.removeEventListener?.('visibilitychange', handleVisibilityChange);
        listening = false;
      }
      const current = sentinel;
      sentinel = null;
      try {
        await current?.release?.();
      } catch {
        // Treat a browser-side release race as already released.
      }
    },
  };
}
