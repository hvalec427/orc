# Flicker Stabilization — Implementation Plan (test-first)

Status: planner output. Execute steps IN ORDER; each leaves the tree green (typecheck + tests).
Gates: `npm run typecheck`, `npm test`, `npm run build`. Run `npm install` first (node_modules absent).

File map (verified): UI in `src/ui/` (App.tsx, AgentView.tsx, Sidebar.tsx, layout.ts). Core in
`src/agent/` (AgentManager.ts, AgentSession.ts). tmux in `src/tmux/TmuxController.ts`.

## Verified facts that shape the plan
- `AgentSession extends EventEmitter` (AgentSession.ts:235). Each session IS an emitter, emits 'update'.
- `AgentManager extends EventEmitter` (AgentManager.ts:84). Each new session's 'update' is fanned into
  the manager's single global 'update' at AgentManager.ts:398-400. Roster-mutation emits: create 267,
  archive 915, unarchive 924, remove 980, restore 1112.
- `getEvents()` returns the live `this.events` array (AgentSession.ts:721-723); push/splice in
  `pushEntry` (1328-1329), cap MAX_EVENTS=800. `agentSession.test.ts` re-calls getEvents() each time,
  so returning the SAME ref is fine — but React cannot see growth via reference identity.
- There is ALREADY a `private nextEventId = 1` counter (AgentSession.ts:326) bumped per entry
  (1311,1318). It is NOT monotonic-per-append in a way we can rely on for a version (it only bumps on
  certain entry kinds). Introduce a dedicated `eventsVersion` counter bumped in `pushEntry`.
- `getInfo()` (AgentSession.ts:700-719) builds a FRESH object every call. `pendingApproval`
  (public field, 330) and `name` (public) are read directly off the session in App/AgentView, NOT via
  getInfo().
- `scheduleEmit` 66ms coalescer (1341-1348); `emitNow` immediate (1350-1352) used by setStatus.
- App bumps `setTick` on every manager 'update' (App.tsx:20,44) → full tree repaint. 4fps throttle
  while reply box open (App.tsx:57-78) is the symptom patch to delete LAST.
- tmux: `showAgentInPane` (AgentManager.ts:126-129) sets selectedId SYNCHRONOUSLY then calls
  `tmux.showAgent(id)`. The debounce MUST live inside `TmuxController.showAgent` (TmuxController.ts:372)
  and MUST NOT delay `this.selectedId = id` (line 373) — the runInPane guard (455) and
  `agentManagerTmux.test.ts:111-113` depend on selectedId/show being set synchronously.

## The 9 ink/Sidebar tests and their mock shapes (MUST be kept green)
Render `<App>` with a duck-typed manager that is `new EventEmitter()` and duck-typed sessions that are
PLAIN OBJECTS (NOT EventEmitters) exposing: `id, name, parentId, project, pendingApproval, getInfo(),
getEvents()`, sometimes `retry/send/resume/pause/stop/resolveApproval`.
- tests/sidebarNav.test.ts  (App; nav)
- tests/archiveNav.test.ts  (App; nav + archive)
- tests/archiveUi.test.ts   (App; archive/unarchive via manager.emit('update'))
- tests/cleanupUi.test.ts   (App)
- tests/mergeChildUi.test.ts(App)
- tests/newAgentForm.test.ts(App)
- tests/quitPopup.test.ts   (App)
- tests/frameHeight.test.ts (App; frame-height invariants)
- tests/sidebarScroll.test.ts (Sidebar directly with AgentInfo[])

CONSEQUENCE FOR DESIGN: Do NOT make the UI subscribe to each AgentSession as an EventEmitter via a
raw `session.on(...)`, because the mock sessions have no `on/off`. Instead route ALL subscription
through the manager (which IS an emitter in every mock) plus session-provided snapshot getters
(`getInfo`, `getEvents`, and new `eventsVersion()` / `pendingApproval`). The granular split is done by
giving AgentManager typed subscribe helpers that the mocks already satisfy by being EventEmitters
(they emit 'update'; new events are additive and default to 'update' behavior). This keeps mock churn
to a MINIMUM: mocks that never push new events need NO change; mocks that mutate state already call
`manager.emit('update')`, which the new subscription path still honors.

---

## STEP 0 — Install + baseline green
- `npm install`; then `npm run typecheck`, `npm test`, `npm run build` to record the green baseline.
- Done-criteria: all three pass unmodified. No code change. (No test to write.)

## STEP 1 — Flicker baseline instrumentation (measurement harness)
Purpose: prove later steps reduce repaints. Make it a TEST HARNESS (deterministic), not a dev counter.
Rationale: a dev-only counter can't gate CI; a render-counter probe in tests gives measurable
assertions reused by later steps.

- NEW test util `tests/helpers/renderProbe.ts` (or inline in the first test): a tiny wrapper that
  renders `<App>` and counts component render invocations. Approach: wrap `Sidebar` and `AgentView`
  with a module-level render counter via a React profiler (`<Profiler onRender>`), OR a lighter
  approach: export a test-only `__renderCounts` incremented in a `useEffect(() => {count++})` injected
  behind a prop/env. PREFER React's `<Profiler>` (no prod code change) wrapping the App subtree in the
  test. Assert on `onRender` call counts per committed update.

TESTS TO WRITE FIRST (tester):
- `tests/flickerBaseline.test.ts` (ink-testing-library + Profiler):
  - "a manager 'update' with no content change still commits the whole App" — BEFORE any fix this
    passes trivially (documents current behavior). Assert render count of AgentView increments on a
    bare `manager.emit('update')`. This is the RED-to-GREEN inversion target for Step 3.
  - Mark this test's strong assertions (`.todo` or skipped) until Step 3 flips them; keep a
    weak documentation assertion active so the file is green now.

Verify: typecheck/test/build green (the strong assertions are skipped/todo).
Risk: Profiler timing in ink-testing-library is async — use the existing `delay()` pattern (50ms).
Rollback: delete the test file + helper; no prod code touched.

NOTE: Pure "stdout bytes/sec" and "tmux redraws per j/k burst" cannot be asserted in
ink-testing-library (no real TTY/tmux). Those remain MANUAL/dev-only observations; the automated proxy
is render-commit counts (Step 3) and tmux call counts via the existing fakeRunner (Step 5).

## STEP 2 — Single-source the height/overlay/width math (lowest risk)
Collapse the mirrored math so Sidebar and App can't drift.

- Move the pure arithmetic into `src/ui/layout.ts` (already Ink-free, unit-testable):
  - `inputChrome(hasQuestion: boolean): number` → `2 + 1 + (hasQuestion?1:0)` (App.tsx:326).
  - `inputWidthFor(columns: number): number` → `Math.max(1, columns - 6)` (App.tsx:330).
  - `overlayRowsFor({confirmingQuit, approvalPending, mode, inputChrome, inputLines}): number`
    mirroring App.tsx:344-348.
  - `bodyHeightFor(rows, overlayRows): number` → `Math.max(6, rows - 2 - overlayRows)` (App.tsx:349).
  - `blockHeightOf` + the Done `+2` fold + `scrollOffset` ALREADY live in Sidebar.tsx:116-136; export
    `blockHeightOf`/`scrollOffset` from layout.ts and have Sidebar import them, so App/Sidebar share
    ONE source if App ever needs block math. (Minimal: just relocate, keep signatures identical.)
- App.tsx and Sidebar.tsx import these helpers instead of inlining the arithmetic. Behavior identical.

TESTS TO WRITE FIRST (tester):
- `tests/layout.test.ts` ALREADY EXISTS (visualRows). ADD cases:
  - `inputChrome(false)===3`, `inputChrome(true)===4`.
  - `inputWidthFor(80)===74`, `inputWidthFor(3)===1` (clamp).
  - `overlayRowsFor` returns 5 when confirmingQuit, 6 when approvalPending, `inputChrome+inputLines`
    in input mode, else 2 — covering the App.tsx:344-348 ladder.
  - `bodyHeightFor(30, 2)===26`, `bodyHeightFor(4, 2)===6` (clamp to 6).
  - `blockHeightOf` child vs top-level vs project-header cases; `scrollOffset` keeps selected block in
    view (port the invariants implied by sidebarScroll.test.ts but at the pure-function level).
- These are RED first (functions don't exist), then GREEN after the implementer adds them.

Existing tests to update: none should break (frameHeight.test.ts + sidebarScroll.test.ts must stay
green unchanged — they're the integration guard that the relocation preserved behavior).
Verify: typecheck/test/build green. Done: layout.test.ts green AND frameHeight/sidebarScroll unchanged.
Risk: off-by-one if a helper's formula diverges from the inlined one — the integration tests catch it.
Rollback: re-inline; helpers are additive so low blast radius.

## STEP 3 — Granular subscriptions + stable snapshots (the core fix)
Goal: a background update for a NON-selected agent must not re-render the selected AgentView; an events
push must be detectable; AgentInfo snapshot must be referentially stable when unchanged. THEN delete
the 4fps throttle.

### 3a. AgentSession: stable snapshots (AgentSession.ts)
- Add `private eventsVersion = 0`; bump it in `pushEntry` (1328) right after the push/splice. Add
  `eventsVersion(): number { return this.eventsVersion }`. (Keep `getEvents()` returning the live
  array — do NOT replace the ref; tests + AgentView rely on reading it.)
- Cache AgentInfo: add `private infoSnapshot?: AgentInfo` and `private infoDirty = true`. Build in
  `getInfo()` only when dirty, else return the cached object (referential stability). Set
  `infoDirty = true` in EVERY mutator of a getInfo field: setStatus (1334), setArchived (283), and
  wherever `name/template/branch/worktree/metroPort/question/sessionId/totalCostUsd/parentId` change
  (search for `this.status =`, `this.question =`, `this.totalCostUsd =`, `this.sessionId =`,
  `this._archived`, etc.). Simplest robust approach: bump a single `private infoVersion = 0` on ANY
  such mutation and rebuild the snapshot when infoVersion changed since last build.
- Include `pendingApproval` and `name` reads: keep them as-is (public fields) — the UI snapshot layer
  (3c) will read `session.pendingApproval` and `session.name` directly; just ensure
  setting/clearing `pendingApproval` (888, 646) ALSO bumps infoVersion so a snapshot-based subscriber
  re-reads it. (They are not in AgentInfo; do not add them unless 3c needs them there — see 3c.)

### 3b. AgentManager: split roster vs content events (AgentManager.ts)
- Keep the existing global 'update' for backward-compat (mocks + waitUntilFinished rely on it).
- ADD two more-specific events, emitted ALONGSIDE 'update' (never instead), so nothing regresses:
  - `'roster'` — emit wherever the SET of agents or their archived flag changes: create 267,
    archive 915, unarchive 924, remove 980, restore 1112. (These already emit 'update'; add a
    sibling `this.emit('roster')`.)
  - per-agent content: the fan-in at 398-400 currently does `session.on('update', () => this.emit('update'))`.
    Change to also emit a targeted `this.emit('agent:'+id)` (and keep the global `this.emit('update')`).
    Mocks don't exercise this path (their sessions never emit), so no mock breaks.
- Add typed subscribe helpers so the UI never touches raw emitter strings and mocks stay satisfied by
  being EventEmitters:
  - `onRoster(cb): () => void` → subscribes to 'roster' (FALLBACK: also 'update', so a mock that only
    emits 'update' still triggers roster recompute — keeps all 9 mocks green).
  - `onAgent(id, cb): () => void` → subscribes to `'agent:'+id` AND 'update' (fallback) so mock
    managers that only emit 'update' still refresh the selected view.
  - `onLog(cb)` → existing 'log'.
  Each returns an unsubscribe. Implement with `this.on/off`; they are additive and safe.

### 3c. App.tsx: useSyncExternalStore per slice + memo
- Replace the single `setTick` effect (App.tsx:20,43-79) with slice subscriptions:
  - ROSTER slice via `useSyncExternalStore(onRoster, snapshotRoster)` where snapshot returns a stable
    value that only changes when roster identity/order/archived changes. Cheapest correct snapshot:
    a version number the manager increments on 'roster'/'update' (add `rosterVersion()` to manager),
    so getSnapshot returns a number (referentially stable, cache-friendly). The agent LISTS
    (active()/archived()) are then recomputed in render from manager, memoized on rosterVersion.
  - SELECTED-AGENT content slice: `useSyncExternalStore(subscribe=onAgent(selectedId), getSnapshot=() =>
    selected?.eventsVersion() ?? 0)` so only selected-agent pushes re-render AgentView. A
    non-selected agent's push emits `agent:<otherId>` (plus global 'update'); subscribe only to the
    selected id's channel. NOTE: because onAgent falls back to 'update' for mock compatibility, in
    PROD you want the targeted channel to be the trigger — acceptable: the getSnapshot returns the
    selected agent's eventsVersion, so even if 'update' fires for another agent, the snapshot value is
    unchanged and React bails out of the re-render. THIS is what satisfies the "background update for a
    non-selected agent does not change selected AgentView" assertion.
  - SELECTED-AGENT info/approval slice: getSnapshot returns selected.getInfo() (now referentially
    stable) — or a composite `{info, pendingApproval}` built only when infoVersion changes. Since
    getInfo() is now cached, `useSyncExternalStore(onAgent(selectedId), () => selected?.getInfo())`
    is referentially stable across no-op updates.
  - NOTICE slice: keep `manager.on('log', setNotice)` (unchanged) — it's cheap and orthogonal.
- Wrap `Sidebar`, `AgentView`, and the Sidebar row component in `React.memo`. Sidebar props are the
  memoized `activeInfos/archivedInfos` arrays (stable when rosterVersion unchanged) + primitives.
  AgentView props: `session` (stable ref), `height/width/active/preview` (primitives/strings).
- DELETE the 4fps throttle branch (App.tsx:57-78) and the `replyOpen` conditional entirely once the
  above lands — the targeted subscription makes it unnecessary.

TESTS TO WRITE FIRST (tester) — these are the measurable flicker assertions:
- `tests/agentSession.test.ts` ADD:
  - "eventsVersion bumps on push": record `v0 = session.eventsVersion()`, inject a message block that
    appends an entry, assert `session.eventsVersion() > v0` and `getEvents().length` grew.
  - "getInfo() is referentially equal when nothing changed": `const a = session.getInfo(); const b =
    session.getInfo(); assert.equal(a, b)` (same ref). Then after a status change
    (`setStatus`-driving input), assert `session.getInfo() !== a` and `.status` updated.
  - "setting pendingApproval invalidates the info snapshot" (if 3c reads approval via snapshot): assert
    getInfo ref changes OR a dedicated approvalVersion bumps after an approval arrives.
- `tests/flickerSubscription.test.ts` (NEW, ink-testing-library + Profiler, the Step-1 harness):
  - "a content update for a NON-selected agent does not change the selected AgentView's lastFrame()":
    build a REAL-ish manager (can be the duck-typed EventEmitter mock EXTENDED so the two sessions
    expose `eventsVersion()` and allow mutating their events array), select agent A, mutate agent B's
    events + emit the targeted channel, assert `lastFrame()` for the selected pane is byte-identical
    before/after AND AgentView's Profiler render count did not increase.
  - "a content update for the SELECTED agent DOES update its AgentView": mutate selected agent's events
    + bump eventsVersion + emit, assert lastFrame() changed.
  - "a bare manager.emit('update') with no snapshot change does not re-commit AgentView": assert
    Profiler render count unchanged (this is the throttle-removal proof — flicker eliminated).
  Flip the Step-1 skipped/.todo assertions to active here.

Existing tests to update (the 9 mocks) — EXACT migration:
- Add `eventsVersion: () => 0` to EVERY mock `session()` factory (sidebarNav, archiveNav, archiveUi,
  cleanupUi, mergeChildUi, newAgentForm, quitPopup, frameHeight). One line each. Required because 3c's
  selected-content getSnapshot calls `selected.eventsVersion()`.
- Mock managers: NO change needed IF `onRoster`/`onAgent` fall back to 'update' (they do). The mocks
  already `emit('update')` on state changes (archiveUi 55/60, sidebarNav 164, mergeChildUi). Verify
  each still re-renders after its `emit('update')`. If a mock manager is missing `onRoster`/`onAgent`,
  App must feature-detect: `manager.onRoster?.(cb) ?? manager.on('update', cb)` — PREFER making App
  call `manager.on`/`off` directly for the fallback so mocks need zero new methods. RECOMMENDED:
  implement the subscribe helpers as free functions in App that take the manager and do
  `manager.onRoster ? manager.onRoster(cb) : (manager.on('update',cb), ()=>manager.off('update',cb))`.
  This keeps ALL 9 mocks working with only the one-line `eventsVersion` addition to sessions.
- sidebarScroll.test.ts: renders Sidebar directly with AgentInfo[]. React.memo on Sidebar is
  transparent to it — NO change, must stay green.
- frameHeight.test.ts: must stay green unchanged (integration guard for the subscription refactor).

Verify: typecheck/test/build green; flickerSubscription assertions GREEN. Done-criteria: non-selected
background update produces identical selected lastFrame() AND zero extra AgentView commits; 4fps
throttle code deleted; all 9 ink mocks green.
Risk: useSyncExternalStore getSnapshot MUST be stable or React throws "getSnapshot should be cached".
Ensure snapshots return primitives (version numbers) or cached refs — never fresh objects/arrays.
Rollback: this is the largest step; land 3a (snapshots, additive, no behavior change) and 3b (additive
events) FIRST as separate commits that keep the old setTick path, THEN 3c swaps the subscription and
deletes the throttle in its own commit so it can be reverted alone.

## STEP 4 — Memoize AgentView wrapText on (events-version, width)
AgentView re-wraps up to 800 entries every render (AgentView.tsx:50-59).

- In AgentView, compute the wrapped `lines` inside `useMemo` keyed on
  `[previewing ? preview : session?.id, session?.eventsVersion?.(), contentWidth, previewing]`.
  Guard `eventsVersion?.()` optional-call so mock sessions (now returning 0) are stable.
- Keep the slice/scroll logic (it depends on scroll state, not memoized).

TESTS TO WRITE FIRST (tester):
- `tests/agentViewMemo.test.ts` (NEW, ink-testing-library + Profiler OR a spy on wrapText):
  - "wrapText is not recomputed when an unrelated re-render occurs with same events-version & width":
    render AgentView, force a parent re-render that doesn't change events/width, assert the wrap work
    didn't rerun. Easiest: export `wrapText` is module-private — instead assert via Profiler that
    AgentView's own render is cheap/bailed, OR temporarily expose a counter. PREFER: assert lastFrame()
    stable across a no-op width-equal re-render and rely on Step-3 Profiler counts; if a direct
    wrapText spy is wanted, inject via a test-only prop defaulting to the real wrapText.
  - "changing width recomputes wrapping" and "an events push (eventsVersion bump) recomputes".
Existing tests: none should break. Verify typecheck/test/build. Done: memo verified, frames unchanged.
Risk: stale view if a mutation forgets to bump eventsVersion — covered by Step-3's eventsVersion test.
Rollback: drop the useMemo; pure optimization.

## STEP 5 — Debounce showAgentInPane break/join (keep selectedId SYNC)
Debounce only the tmux break/join I/O inside TmuxController; selectedId stays synchronous.

- TmuxController.showAgent (TmuxController.ts:372): set `this.selectedId = id` IMMEDIATELY (line 373
  unchanged). Debounce ONLY the async break/join block (384-411): store the latest requested id, and
  schedule the IIFE via a trailing debounce (e.g. 80-120ms) so a j/k burst collapses to ONE
  break/join for the FINAL selection. Coalesce: if a new showAgent arrives before the timer fires,
  replace the pending target; when it fires, run break(prev-occupant)→join(final) once.
- Make the delay INJECTABLE via the constructor opts (`showDebounceMs`, default ~100, 0 in tests) so
  existing tmuxController tests can set 0 (synchronous) OR the tests `await` a flush. Preserve
  break-before-join ordering (the single coalesced run still breaks the old occupant then joins the
  new one).

TESTS TO WRITE FIRST (tester):
- `tests/tmuxController.test.ts` ADD (reuse fakeRunner/flush harness at 335-390):
  - "rapid showAgent A,B,C within the debounce window collapses to a single join of C (and at most one
    break of the prior occupant)": call showAgent('a1'); showAgent('a2'); showAgent('a3') back-to-back,
    flush, assert only C (%for a3) is join-pane'd and A/B are not each separately joined; break happens
    before join; nothing killed.
  - "selectedId is set synchronously even before the debounce fires": after showAgent('a1') (no flush),
    assert the controller treats a1 as selected (e.g. runInPane('a1',...) is not rejected by the
    selected-guard that returned null for non-selected — OR expose/inspect selectedId). This locks
    constraint 6.
  - Keep existing 336-389 tests GREEN by constructing the controller with `showDebounceMs: 0` (or add
    an explicit flush). Update those two tests ONLY if the default debounce would otherwise defer their
    single showAgent — set delay 0 there.
- `tests/agentManagerTmux.test.ts:107-113` MUST stay green: `showAgentInPane('a1')` →
  `calls.show===['a1']` synchronously. Since the debounce is INSIDE TmuxController.showAgent and the
  fake tmux's `show` records the call immediately (fakeTmux's showAgent pushes synchronously), confirm
  the fake records at call-time. If the fake defers, keep AgentManager calling `tmux.showAgent` synchronously
  (it does) — the fake's push is synchronous, so this test is unaffected. DO NOT move the debounce into
  AgentManager.
Verify typecheck/test/build. Done: burst collapses to one I/O cycle; selectedId sync; ordering/no-kill
preserved; agentManagerTmux + existing tmuxController tests green.
Risk: a trailing-only debounce could drop the FINAL join if unmount races the timer — clear the timer
on a teardown/dispose path and run the pending join on flush. Rollback: set default debounce 0.

## STEP 6 — Resize debounce (net-new)
Debounce terminal resize so a drag doesn't repaint per pixel row.

- App.tsx currently reads `rows = stdout?.rows ?? 30` once per render (App.tsx:18) and has NO resize
  listener — Ink re-renders App on its own resize handling, but there is no debounce. Add a
  `useEffect` that subscribes `stdout.on('resize', handler)` and stores debounced `{rows, columns}` in
  state (debounce ~100ms, trailing), replacing the direct `stdout.rows/columns` reads with the
  debounced state. Clean up the listener + timer on unmount.
- Keep a synchronous initial read so the first paint has correct dimensions.

TESTS TO WRITE FIRST (tester):
- `tests/resizeDebounce.test.ts` (NEW): unit-test the debounce hook/util in isolation (extract the
  debounce into `src/ui/useDebouncedSize.ts` or a pure `debounce` in layout.ts so it's testable without
  a TTY). Assert: N rapid resize events within the window produce ONE state update with the LAST size;
  a trailing event after the window produces a second. Use fake timers (node:test + a controllable
  clock, or inject the timer).
- ink-testing-library does NOT emit real resize events, so an App-level integration assertion is weak;
  the pure-util test is the meaningful automated coverage. CALL-OUT: the end-to-end "resize repaints
  once" is MANUAL (no TTY in tests).
Verify typecheck/test/build. Done: debounce util tested; App uses it; no regression in frameHeight.
Risk: debounced size lagging initial layout — keep the synchronous first read. Rollback: read
stdout.rows directly (current behavior).

---

## Commit sequencing (each commit green)
1. Step 0 baseline (no commit).
2. Step 2 layout helpers (+layout.test.ts).  ← safest, land first.
3. Step 3a session snapshots (additive) + agentSession.test.ts assertions.
4. Step 3b manager events (additive).
5. Step 1 + Step 3c subscriptions + delete throttle + flickerSubscription.test.ts + mock eventsVersion.
6. Step 4 AgentView memo (+agentViewMemo.test.ts).
7. Step 5 tmux debounce (+tmuxController assertions).
8. Step 6 resize debounce (+resizeDebounce.test.ts).

## Can't-be-automated call-outs
- Raw stdout bytes/sec, real tmux redraw counts, real terminal resize repaints: no TTY/tmux in the
  test runner. Automated proxies used instead: React Profiler commit counts (Steps 1/3/4), fakeRunner
  tmux call counts (Step 5), pure debounce util tests (Steps 5/6). End-to-end flicker is verified
  MANUALLY by running `npm run dev` in tmux.
