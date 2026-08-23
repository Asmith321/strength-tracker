/* ============================================================================
   In-progress session draft.

   Extracted into its own module rather than left inline in App.jsx so it can
   be tested against the REAL implementation. The existing App-level test
   (app_touched_flag_test.mjs) has to replicate its boundary by hand because
   App.jsx cannot be imported in Node — that works, but a replicated test only
   ever proves the replica behaves, which is precisely the self-consistency
   trap this project has been bitten by before. Nothing here imports React or
   Supabase, so the test loads the same code the app runs.

   WHY THIS EXISTS. Logs for a session in progress lived only in React state.
   Phones suspend backgrounded tabs aggressively — answer a message mid-workout
   and every entry so far was gone. It is the one bug guaranteed to be hit on a
   real training floor.

   WHY localStorage AND NOT THE CLOUD. A half-finished session is worthless on
   another device, has to survive with no signal in a basement gym, and has to
   write synchronously on every keystroke without a round trip. Completed
   sessions still go to cloud storage; this is strictly a local crash-mat.
   ========================================================================== */

export const K_DRAFT = "strength.engine.draft.v1";

/* Every accessor is wrapped. Safari in private mode throws on write, storage
   can be full, and an embedded webview may deny access outright — none of
   which may be allowed to take down the logging screen. A draft is a
   convenience; losing it must degrade to today's behaviour, not to a crash. */
export function readDraft(store = globalThis.localStorage) {
  try {
    const raw = store?.getItem(K_DRAFT);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writeDraft(d, store = globalThis.localStorage) {
  try { store?.setItem(K_DRAFT, JSON.stringify(d)); return true; } catch { return false; }
}

export function clearDraft(store = globalThis.localStorage) {
  try { store?.removeItem(K_DRAFT); return true; } catch { return false; }
}

/* Should this draft be restored over today's prescription?
   Both guards exist to stop a draft being applied to the WRONG session, which
   would be worse than losing it — the athlete would silently inherit numbers
   from work they didn't do:
     - sessionCount pins it to one specific session, so a leftover draft from a
       completed session 12 is ignored when 13 opens.
     - the exercise keys must line up position for position, because the
       rotation can change under a stored draft (an exercise swapped, a program
       migrated). Restoring by index alone would attribute the athlete's logged
       numbers to a different lift entirely. */
export function draftMatches(draft, sessionCount, itemKeys) {
  if (!draft || !Array.isArray(draft.logs)) return false;
  if (draft.sessionCount !== sessionCount) return false;
  if (draft.logs.length !== itemKeys.length) return false;
  return draft.logs.every((l, i) => l && l.key === itemKeys[i]);
}
