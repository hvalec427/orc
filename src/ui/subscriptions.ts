/**
 * Typed subscribe helpers for the TUI's per-slice useSyncExternalStore wiring.
 *
 * Each helper returns an unsubscribe function (the shape useSyncExternalStore's `subscribe`
 * argument expects). They listen to the manager's specific, fine-grained event when it is emitted
 * (roster membership / a single agent's content) AND always fall back to the global `'update'` event
 * so the 8 duck-typed mock managers in the ink tests — which only ever emit `'update'` — keep
 * working without gaining new methods. Waking on the global event is harmless: each React consumer
 * only re-renders when ITS getSnapshot value actually changes, so the per-slice granularity comes
 * from the snapshot, not from which event fired.
 */

/** The minimal event-emitter surface these helpers need; AgentManager and the mocks both satisfy it. */
export interface Subscribable {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

function subscribeEvents(
  manager: Subscribable,
  events: string[],
  onChange: () => void,
): () => void {
  const listener = () => onChange();
  for (const event of events) manager.on(event, listener);
  return () => {
    for (const event of events) manager.off(event, listener);
  };
}

/** Wake when the agent roster (membership / archived state) changes. Falls back to `'update'`. */
export function subscribeRoster(manager: Subscribable, onChange: () => void): () => void {
  return subscribeEvents(manager, ['roster', 'update'], onChange);
}

/** Wake when a single agent's content/status changes. Falls back to `'update'`. */
export function subscribeAgent(
  manager: Subscribable,
  id: string | undefined,
  onChange: () => void,
): () => void {
  const events = id ? [`agent:${id}`, 'update'] : ['update'];
  return subscribeEvents(manager, events, onChange);
}
