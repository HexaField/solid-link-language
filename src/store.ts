/**
 * Local store — wraps the ad4m:host storage KV API.
 *
 * Two layers live here, matching the spec's two roles:
 *
 *  1. The DAG cache (source of truth, Role A). Every diff-commit seen — locally
 *     authored or pulled from a pod — is persisted under `dag/commit/<hash>`,
 *     and the current head set under `dag/heads`. `currentRevision()` is
 *     derived from the heads; the link set is derived by folding the commits.
 *     This cache lets us walk/fold the DAG offline and across restarts without
 *     re-reading it from the pod every time.
 *
 *  2. The materialised link cache (derived, for fast query/render). Rebuilt by
 *     folding the DAG. NEVER the source of truth — it is fully reconstructible
 *     from layer 1.
 *
 * Key scheme:
 *   dag/commit/{commit-hash}         → serialized DiffCommit
 *   dag/heads                        → JSON array of head commit hashes
 *   links/{link-hash}                → serialized LinkExpression (derived cache)
 *   links-by-source/{source}/{hash}  → link-hash
 *   links-by-target/{target}/{hash}  → link-hash
 *   links-by-pred/{predicate}/{hash} → link-hash
 *   peers/{did}                      → peer metadata JSON
 */

import type { StorageAdapter } from "./adapters.js";
import { getStorage } from "./adapters.js";
import { getRuntime } from "./adapters.js";

import type { LinkExpression, PerspectiveDiff, Perspective } from "./types.js";
import type { DiffCommit } from "./diffdag.js";
import {
    commitHash as computeCommitHash,
    computeHeads,
    revisionOfHeads,
    foldCommits,
    hashLinkContent,
} from "./diffdag.js";

let _hashFn: ((data: string) => string) | null = null;

export function initStore(hashFn?: (data: string) => string): void {
    _hashFn = hashFn ?? null;
}

export function getHashFn(): (data: string) => string {
    if (_hashFn) return _hashFn;
    return getRuntime().hash;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function linkKey(linkHash: string): string {
    return `links/${linkHash}`;
}

function sourceIndexKey(source: string, linkHash: string): string {
    return `links-by-source/${source}/${linkHash}`;
}

function targetIndexKey(target: string, linkHash: string): string {
    return `links-by-target/${target}/${linkHash}`;
}

function predIndexKey(predicate: string, linkHash: string): string {
    return `links-by-pred/${predicate}/${linkHash}`;
}

function peerKey(did: string): string {
    return `peers/${did}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The content hash that keys a link everywhere — the derived cache index AND
 * the OR-Set element key in the DAG fold. Delegates to the single canonical
 * definition in diffdag so the two layers cannot drift apart.
 */
export function hashLink(link: LinkExpression): string {
    return hashLinkContent(link, getHashFn());
}

export function putLink(link: LinkExpression): string {
    const h = hashLink(link);
    const storage = getStorage();
    storage.put(linkKey(h), JSON.stringify(link));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";

    if (source) storage.put(sourceIndexKey(source, h), h);
    if (target) storage.put(targetIndexKey(target, h), h);
    if (predicate) storage.put(predIndexKey(predicate, h), h);

    return h;
}

export function removeLink(link: LinkExpression): void {
    const h = hashLink(link);
    const storage = getStorage();
    storage.delete(linkKey(h));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";

    if (source) storage.delete(sourceIndexKey(source, h));
    if (target) storage.delete(targetIndexKey(target, h));
    if (predicate) storage.delete(predIndexKey(predicate, h));
}

export function getLink(linkHash: string): LinkExpression | null {
    const raw = getStorage().get(linkKey(linkHash));
    if (!raw) return null;
    return JSON.parse(raw) as LinkExpression;
}

export function applyDiff(diff: PerspectiveDiff): void {
    for (const addition of diff.additions) {
        putLink(addition);
    }
    for (const removal of diff.removals) {
        removeLink(removal);
    }
}

// ---------------------------------------------------------------------------
// DAG cache (Role A — source of truth)
// ---------------------------------------------------------------------------

const DAG_COMMIT_PREFIX = "dag/commit/";
const DAG_HEADS_KEY = "dag/heads";

function commitKey(hash: string): string {
    return `${DAG_COMMIT_PREFIX}${hash}`;
}

/** True if a commit with this hash is already in the local DAG cache. */
export function hasCommit(hash: string): boolean {
    return getStorage().get(commitKey(hash)) !== null;
}

/** Read a single commit from the DAG cache, or null. */
export function getCommit(hash: string): DiffCommit | null {
    const raw = getStorage().get(commitKey(hash));
    if (!raw) return null;
    return JSON.parse(raw) as DiffCommit;
}

/** Persist a commit into the DAG cache under its content hash. */
export function putCommit(hash: string, commit: DiffCommit): void {
    getStorage().put(commitKey(hash), JSON.stringify(commit));
}

/** Every commit hash currently in the local DAG cache. */
export function allCommitHashes(): string[] {
    return getStorage()
        .listKeys(DAG_COMMIT_PREFIX)
        .map((k) => k.slice(DAG_COMMIT_PREFIX.length));
}

/** Load the entire local DAG (hash → commit) for folding / head computation. */
export function loadDag(): Map<string, DiffCommit> {
    const dag = new Map<string, DiffCommit>();
    for (const hash of allCommitHashes()) {
        const commit = getCommit(hash);
        if (commit) dag.set(hash, commit);
    }
    return dag;
}

/** Persist the head set (deduped, sorted). */
export function setHeads(heads: string[]): void {
    const unique = [...new Set(heads)].sort();
    getStorage().put(DAG_HEADS_KEY, JSON.stringify(unique));
}

/** Read the persisted head set. */
export function getHeads(): string[] {
    const raw = getStorage().get(DAG_HEADS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
}

/**
 * Insert a commit into the DAG cache and update the head set: the new commit
 * becomes a head; any parents it references are no longer heads. Idempotent —
 * re-inserting the same commit is a no-op for the head set.
 *
 * @returns true if the commit was newly added, false if already present.
 */
export function addCommitToDag(hash: string, commit: DiffCommit): boolean {
    const isNew = !hasCommit(hash);
    putCommit(hash, commit);

    const heads = new Set(getHeads());
    // Parents are no longer heads.
    for (const p of commit.previous) heads.delete(p);
    // This commit is a head unless something already references it as a parent.
    if (!isReferencedAsParent(hash)) heads.add(hash);
    setHeads([...heads]);

    return isNew;
}

/** True if any cached commit lists `hash` among its parents. */
function isReferencedAsParent(hash: string): boolean {
    for (const h of allCommitHashes()) {
        const c = getCommit(h);
        if (c && c.previous.includes(hash)) return true;
    }
    return false;
}

/**
 * Recompute the head set from scratch by scanning the whole DAG cache. Used
 * after bulk ingestion (e.g. an ancestor walk) to guarantee heads are exact.
 */
export function recomputeHeads(): string[] {
    const heads = computeHeads(loadDag());
    setHeads(heads);
    return heads;
}

/**
 * Fold the entire local DAG and rebuild the derived link cache to match.
 * The DAG is authoritative; this makes the query/render cache consistent with
 * it. Returns the folded link set.
 */
export function rebuildLinksFromDag(): LinkExpression[] {
    const dag = loadDag();
    const { links } = foldCommits(dag, getHashFn());

    // Clear the derived link cache.
    const storage = getStorage();
    for (const key of storage.listKeys("links/")) storage.delete(key);
    for (const key of storage.listKeys("links-by-source/")) storage.delete(key);
    for (const key of storage.listKeys("links-by-target/")) storage.delete(key);
    for (const key of storage.listKeys("links-by-pred/")) storage.delete(key);

    // Repopulate from the fold.
    const result: LinkExpression[] = [];
    for (const link of links.values()) {
        putLink(link);
        result.push(link);
    }
    return result;
}

/** Compute a commit's content hash under the store's hash function. */
export function hashCommit(commit: DiffCommit): string {
    return computeCommitHash(commit, getHashFn());
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface LinkQuery {
    source?: string;
    target?: string;
    predicate?: string;
}

export function queryLinks(query: LinkQuery): LinkExpression[] {
    const { source, target, predicate } = query;
    const storage = getStorage();

    let candidateHashes: string[];

    if (source) {
        const keys = storage.listKeys(`links-by-source/${source}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (target) {
        const keys = storage.listKeys(`links-by-target/${target}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (predicate) {
        const keys = storage.listKeys(`links-by-pred/${predicate}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else {
        const keys = storage.listKeys("links/");
        candidateHashes = keys.map((k: string) => k.replace("links/", ""));
    }

    const results: LinkExpression[] = [];
    const seen = new Set<string>();

    for (const h of candidateHashes) {
        if (seen.has(h)) continue;
        seen.add(h);

        const link = getLink(h);
        if (!link) continue;

        if (source && link.data.source !== source) continue;
        if (target && link.data.target !== target) continue;
        if (predicate && link.data.predicate !== predicate) continue;

        results.push(link);
    }

    return results;
}

export function allLinks(): Perspective {
    const keys = getStorage().listKeys("links/");
    const links: LinkExpression[] = [];

    for (const key of keys) {
        const raw = getStorage().get(key);
        if (raw) {
            links.push(JSON.parse(raw) as LinkExpression);
        }
    }

    return { links };
}

// ---------------------------------------------------------------------------
// Revision — derived from the DAG head set (NOT an opaque cursor)
// ---------------------------------------------------------------------------

/**
 * The current revision: a content hash of the DAG head(s).
 *
 * - No commits ⇒ null (empty perspective).
 * - Single head ⇒ that head's commit hash (a pointer into the DAG).
 * - Multiple concurrent heads ⇒ a deterministic digest of the sorted head
 *   hashes (a version-vector digest).
 *
 * This is deterministic for a given DAG state and stable across restarts (the
 * DAG cache is persisted). It is emphatically NOT the container ETag,
 * a timestamp, or a sequence counter.
 */
export function getRevision(): string | null {
    return revisionOfHeads(getHeads(), getHashFn());
}

// ---------------------------------------------------------------------------
// Peer management
// ---------------------------------------------------------------------------

export function setPeer(did: string, metadata: Record<string, unknown> = {}): void {
    getStorage().put(peerKey(did), JSON.stringify(metadata));
}

export function removePeer(did: string): void {
    getStorage().delete(peerKey(did));
}

export function listPeers(prefix: string = "peers/"): string[] {
    const keys = getStorage().listKeys(prefix);
    return keys.map((k: string) => k.replace(prefix, ""));
}

export function getPeerMetadata(did: string): Record<string, unknown> | null {
    const raw = getStorage().get(peerKey(did));
    if (!raw) return null;
    return JSON.parse(raw);
}
