/**
 * Trailing-edge debounce. Returns a wrapper that delays invoking `fn` until `delayMs` have elapsed
 * since the last call; a burst of calls collapses to a single trailing invocation. The returned
 * function carries a `cancel()` to drop any pending call (e.g. on unmount). delayMs<=0 invokes
 * synchronously (no timer), which keeps it trivially testable.
 */
export function debounce(fn: () => void, delayMs: number): (() => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = () => {
    if (delayMs <= 0) {
      fn();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, delayMs);
  };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return wrapped;
}
