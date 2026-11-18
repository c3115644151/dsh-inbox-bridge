/**
 * Keys.
 *
 * Every fact the collector produces is named `<owner/name>#<inner>`, for
 * example `c3115644151/dsh-inbox-bridge#pr:42:author:failed|review:REVIEW_REQUIRED`.
 * The repository prefix exists for two reasons: the same PR number in two
 * repositories is two facts, and a fact that lost its `repo` field in a round
 * trip can still be routed by its name alone.
 *
 * Both the host (`index.js`) and the queue (`scripts/inbox-bridge.mjs`) need
 * that parse, so it lives here once instead of in five ad-hoc slices.
 */

/**
 * Split a key into the repository it names and what remains.
 *
 * Returns `{ repo: null, inner: key }` when the key carries no repository.
 */
export function splitKey(key) {
  if (typeof key !== "string") return { repo: null, inner: "" };
  const cut = key.indexOf("#");
  if (cut <= 0) return { repo: null, inner: key };
  const repo = key.slice(0, cut);
  // A prefix only counts when it looks like `owner/name`; anything else is part
  // of the inner name (for instance `dependabot`, which has no prefix).
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) return { repo: null, inner: key };
  return { repo, inner: key.slice(cut + 1) };
}

/** The repository a key names, or `null`. */
export function repoOfKey(key) {
  return splitKey(key).repo;
}