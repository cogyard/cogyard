// core/memo.mjs — change-signal-keyed memoization for git-derived views.
//
// Generalizes the two ad-hoc caches already in the codebase — `sizeCache`
// (core/overview.mjs) and `staleCache` (core/project.mjs) — into one helper.
// A cached value is reused only while a cheap "signal" of the underlying repo
// state is unchanged; when the signal changes, the value is recomputed. The
// portal polls most endpoints every 7s, so this turns the common case (nothing
// changed between two ticks) into one cheap signal call instead of a full
// recompute, and makes per-poll cost scale with what *changed*, not with the
// number of projects/commits.
//
//   signalFn() -> Promise<string|null>
//     A cheap fingerprint that fully determines computeFn's output. Returning
//     null BYPASSES the cache (e.g. not a git repo / a git error) — computeFn
//     runs and its result is NOT stored, so a transient failure never poisons
//     the cache.
//   computeFn() -> Promise<value>
//     The expensive recompute, run only on a miss (or when the signal is null).
//
// signalFn runs on EVERY call (that's the point — it's the cheap part). To feed
// work already done by signalFn into computeFn without recomputing it, stash it
// on a closure variable: signalFn always runs before computeFn, so computeFn
// can read what signalFn set (see core/overview.mjs for that idiom).
//
// Caches live for the process lifetime (the server is one long-lived process via
// the LaunchAgent); a restart clears them. Keyed by (namespace, key) so distinct
// views over the same repo never collide.

const caches = new Map(); // namespace -> Map(key -> { signal, value })

async function memoize(namespace, key, signalFn, computeFn) {
  const signal = await signalFn();
  let ns = caches.get(namespace);
  if (!ns) { ns = new Map(); caches.set(namespace, ns); }
  const hit = ns.get(key);
  if (signal != null && hit && hit.signal === signal) return hit.value;
  const value = await computeFn();
  if (signal != null) ns.set(key, { signal, value });
  return value;
}

// Test / diagnostic helper: drop a namespace's cache, or everything when called
// with no argument. Not used in production paths.
function clearMemo(namespace) {
  if (namespace === undefined) caches.clear();
  else caches.delete(namespace);
}

export { memoize, clearMemo };
