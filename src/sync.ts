/**
 * Pod sync — walks the emulated diff-DAG (Role A), not a container snapshot.
 *
 * Solid/LDP has no native causal DAG, so this language emulates one with
 * immutable, content-hash-named diff-commit resources (`diffs/diff-<hash>.ttl`)
 * whose bodies carry `ad4m:previous` parent pointers. Sync is a DAG walk:
 *
 *   1. Discover the commit hashes present in the pod's `diffs/` container.
 *      (This discovers WHICH COMMITS EXIST — it is not a link snapshot, and the
 *      container ETag is never used as a revision.)
 *   2. For any commit not already in the local DAG cache, fetch its resource,
 *      parse it, ingest it, then follow its `ad4m:previous` pointers, fetching
 *      any missing ancestors transitively. This converges the local DAG with
 *      the pod's, re-requesting missing parents just like the Holochain
 *      reference's `pull` walks ancestry.
 *   3. Recompute heads and fold the whole reachable DAG with OR-Set semantics.
 *      Emit the PerspectiveDiff between the pre-sync fold and the post-sync
 *      fold, so AD4M sees exactly the links that appeared/disappeared —
 *      including first-class removals carrying the original link.
 *
 * No ad4m:host imports — uses injected adapters only.
 */

import type { PerspectiveDiff } from "./types.js";
import { getStorage } from "./adapters.js";
import { fetchTurtle } from "./ldp.js";
import { parseTurtle, getObjects } from "./rdf.js";
import { ldp } from "./ontology.js";
import {
    linksContainerUrl,
    diffsContainerUrl,
    diffResourceUrl,
    extractCommitHash,
    extractContainedResources,
} from "./ldp.js";
import * as store from "./store.js";
import { commitFromGraph, foldCommits, diffBetweenFolds } from "./diffdag.js";

// ---------------------------------------------------------------------------
// Container discovery
// ---------------------------------------------------------------------------

/**
 * List the commit hashes present in the pod's `diffs/` container. Parses the
 * LDP container listing purely to discover which diff resources exist; the
 * bodies (and their causal structure) are fetched and folded separately.
 */
async function discoverPodCommitHashes(
    diffsContainer: string,
    authToken?: string,
): Promise<string[]> {
    const body = await fetchTurtle(diffsContainer, authToken);
    if (!body) return [];

    const graph = parseTurtle(body, diffsContainer);
    const contained = getObjects(graph, diffsContainer, ldp.contains);
    const urls = extractContainedResources(diffsContainer, contained);

    const hashes: string[] = [];
    for (const url of urls) {
        const h = extractCommitHash(url);
        if (h) hashes.push(h);
    }
    return hashes;
}

// ---------------------------------------------------------------------------
// Ancestor walk
// ---------------------------------------------------------------------------

/**
 * Ensure `hash` and all its ancestors are present in the local DAG cache,
 * fetching any that are missing from the pod. Follows `ad4m:previous` pointers
 * transitively. Cycles / already-present commits terminate the walk.
 *
 * @returns the set of commit hashes newly fetched during this walk.
 */
export async function fetchCommitWithAncestors(
    diffsContainer: string,
    hash: string,
    authToken: string | undefined,
    fetched: Set<string> = new Set(),
): Promise<Set<string>> {
    const stack = [hash];

    while (stack.length > 0) {
        const current = stack.pop()!;
        if (fetched.has(current)) continue;
        if (store.hasCommit(current)) continue;

        const url = diffResourceUrl(diffsContainer, current);
        const turtle = await fetchTurtle(url, authToken);
        if (!turtle) {
            // Missing on the pod — cannot fetch. Leave as a dangling parent
            // pointer; the fold simply lacks that commit's diff.
            continue;
        }

        const commit = commitFromGraph(parseTurtle(turtle, url), url);
        if (!commit) continue;

        store.putCommit(current, commit);
        fetched.add(current);

        // Walk parents that we don't yet have.
        for (const parent of commit.previous) {
            if (!store.hasCommit(parent) && !fetched.has(parent)) {
                stack.push(parent);
            }
        }
    }

    return fetched;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Perform a full sync cycle by walking the pod's diff-DAG and folding it.
 *
 * @param podUrl Pod base URL
 * @param containerPath Container path on the Pod
 * @param authToken Optional auth token
 * @returns PerspectiveDiff of links that appeared/disappeared vs. the pre-sync
 *   materialised state.
 */
export async function syncFromPod(
    podUrl: string,
    containerPath: string,
    authToken?: string,
): Promise<PerspectiveDiff> {
    const diffsContainer = diffsContainerUrl(podUrl, containerPath);
    const hashFn = store.getHashFn();

    // Snapshot the pre-sync fold so we can emit an incremental diff.
    const before = foldCommits(store.loadDag(), hashFn);

    // 1. Discover which commits the pod has.
    const podHashes = await discoverPodCommitHashes(diffsContainer, authToken);

    // 2. Fetch every commit we're missing, plus all their ancestors.
    const fetched = new Set<string>();
    for (const h of podHashes) {
        if (!store.hasCommit(h)) {
            await fetchCommitWithAncestors(diffsContainer, h, authToken, fetched);
        }
    }

    if (fetched.size === 0) {
        // Nothing new — DAG (and therefore revision) unchanged.
        return { additions: [], removals: [] };
    }

    // 3. Recompute heads from the converged DAG and fold it.
    store.recomputeHeads();
    const dag = store.loadDag();
    const after = foldCommits(dag, hashFn);

    // Rebuild the derived query/render cache to match the authoritative fold.
    store.rebuildLinksFromDag();

    return diffBetweenFolds(before, after);
}

/**
 * Full initial sync — identical to `syncFromPod` for the DAG model: it walks
 * every commit the pod exposes and its ancestry. Kept as a distinct entry point
 * for callers that want an explicit cold-start fetch.
 */
export async function fullSync(
    podUrl: string,
    containerPath: string,
    authToken?: string,
): Promise<PerspectiveDiff> {
    return syncFromPod(podUrl, containerPath, authToken);
}

/**
 * The current DAG head set (for external monitoring / debugging).
 */
export function getHeads(): string[] {
    return store.getHeads();
}
