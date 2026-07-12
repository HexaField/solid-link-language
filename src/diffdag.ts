/**
 * Diff-DAG convergence substrate (Role A) — emulated on top of LDP.
 *
 * Solid/LDP has NO native causal DAG; it is a plain document store. This
 * module EMULATES a hash-linked diff-DAG the way the AD4M `perspective-sync`
 * contract requires (spec §1, §2 of SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE):
 *
 *   - Each `commit(diff)` becomes an IMMUTABLE diff-commit named by its own
 *     content hash. The commit body carries the link diff PLUS `ad4m:previous`
 *     pointers to its parent commit hash(es). These parent pointers form a
 *     content-addressed causal DAG inside the pod (resources at `diffs/<hash>`).
 *
 *   - `currentRevision()` = the head diff-commit content hash. When there are
 *     multiple concurrent heads (multi-writer), it is a deterministic digest of
 *     the SORTED set of head hashes (a version-vector digest) — never a
 *     container ETag, timestamp, or sequence counter.
 *
 *   - Removals are FIRST-CLASS diff entries. A removal is a tombstone carrying
 *     the ORIGINAL link's content hash, so it converges against the original
 *     add across replicas. Removal is NEVER an HTTP DELETE of a link resource
 *     (owner-only, destroys history).
 *
 *   - Merge is an OR-Set (observed-remove set) keyed by link content hash:
 *     add = insert hash; remove = tombstone the observed hash; the materialised
 *     link set = union of adds MINUS union of tombstoned hashes. Folding the
 *     reachable DAG in any order yields the same set (order-independent).
 *
 * This module is pure w.r.t. the runtime: it takes an injected `hash` function
 * and plain data. No ad4m:host imports, no network. The pod I/O (PUT/GET of the
 * `diffs/<hash>` resources, head discovery, ancestor walk) lives in sync.ts and
 * index.ts, which call the (de)serialisation + fold helpers here.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { RdfTriple, RdfGraph } from "./rdf.js";
import { triplesToTurtle } from "./rdf.js";
import { DEFAULT_PREFIXES, ad4m, rdf, xsd } from "./ontology.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A tombstone — a first-class removal carrying the ORIGINAL link's content
 * hash. `link` is retained so that a fold can emit a fully-formed removal
 * `LinkExpression` for AD4M subscribers even if the original add is not
 * locally present; it is NOT part of the OR-Set key (the hash is).
 */
export interface Tombstone {
    /** Content hash of the removed link (OR-Set key — matches the add). */
    linkHash: string;
    /** The removed link's data, for reconstructing the emitted removal diff. */
    link: LinkExpression;
}

/**
 * A diff-commit: one immutable node in the emulated DAG. Named by
 * `commitHash(this)`. `previous` are the parent commit hashes.
 */
export interface DiffCommit {
    additions: LinkExpression[];
    removals: Tombstone[];
    /** Parent commit hashes. Empty ⇒ genesis. Multiple ⇒ merge commit. */
    previous: string[];
    /** DID that authored the commit. */
    author: string;
    /** ISO-8601 authoring timestamp. */
    timestamp: string;
}

// ---------------------------------------------------------------------------
// Canonicalisation + hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic content hash of a single link. This is the OR-Set element key
 * and the identifier a tombstone references. Field order is fixed and parents
 * are irrelevant, so the same logical link always hashes identically across
 * replicas and restarts.
 *
 * The key is the link's STABLE IDENTITY — source, predicate, target, author,
 * timestamp — and DELIBERATELY EXCLUDES `proof` (signature + key). A removal
 * must converge against its original add, but AD4M's `removeLink` hands the
 * language a LinkExpression with an EMPTY proof (the executor does not
 * round-trip the original signature into the removal diff). If proof were part
 * of the key, a tombstone (empty proof) could never reference an add whose hash
 * baked in the real signature, so removals silently failed to fold out on peer
 * replicas — the observed C1 A=20/B=20 add-converged-but-removal-frozen bug.
 * timestamp DOES survive the round-trip (queryLinks returns the original) and is
 * kept, matching the sibling diff-DAG languages (nostr/ipfs key identically:
 * source:predicate:target:author:timestamp). Regression: tests/diffdag.test.ts
 * → "a tombstone converges against its add even when proof is stripped".
 */
export function hashLinkContent(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    const canonical = JSON.stringify([
        link.data.source ?? null,
        link.data.predicate ?? null,
        link.data.target ?? null,
        link.author ?? null,
        link.timestamp ?? null,
    ]);
    return hashFn(canonical);
}

/**
 * Canonical serialisation of a commit for content-addressing. Parents are
 * SORTED (parent order is not semantically meaningful), additions/removals are
 * sorted by their link hash, so two replicas that build the same logical commit
 * derive the same hash regardless of insertion order.
 */
export function canonicalCommitString(
    commit: DiffCommit,
    hashFn: (data: string) => string,
): string {
    const additions = commit.additions
        .map((l) => hashLinkContent(l, hashFn))
        .sort();
    const removals = commit.removals.map((t) => t.linkHash).sort();
    const previous = [...commit.previous].sort();
    return JSON.stringify({
        additions,
        removals,
        previous,
        author: commit.author,
        timestamp: commit.timestamp,
    });
}

/**
 * The content hash that names a commit resource (`diffs/<hash>`). Deterministic
 * for given commit content — the litmus test for genuine convergence.
 */
export function commitHash(
    commit: DiffCommit,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalCommitString(commit, hashFn));
}

// ---------------------------------------------------------------------------
// currentRevision — head-set digest
// ---------------------------------------------------------------------------

/**
 * `currentRevision()` value for a set of head commit hashes.
 *
 * - 0 heads (empty DAG) ⇒ null.
 * - 1 head ⇒ that head hash (a pointer into the DAG).
 * - N heads ⇒ a deterministic digest of the SORTED head hashes (version-vector
 *   digest). This is a content hash of the DAG frontier — never an ETag,
 *   timestamp, or counter.
 */
export function revisionOfHeads(
    heads: string[],
    hashFn: (data: string) => string,
): string | null {
    const unique = [...new Set(heads)].sort();
    if (unique.length === 0) return null;
    if (unique.length === 1) return unique[0];
    return hashFn(JSON.stringify(unique));
}

/**
 * Compute the head set of a commit DAG: every commit hash that is not
 * referenced as a parent by any other commit in the set. Deterministic and
 * order-independent.
 */
export function computeHeads(commits: Map<string, DiffCommit>): string[] {
    const referenced = new Set<string>();
    for (const commit of commits.values()) {
        for (const p of commit.previous) referenced.add(p);
    }
    return [...commits.keys()].filter((h) => !referenced.has(h)).sort();
}

// ---------------------------------------------------------------------------
// Fold — OR-Set materialisation
// ---------------------------------------------------------------------------

export interface FoldResult {
    /** Materialised link set, keyed by link content hash. */
    links: Map<string, LinkExpression>;
    /** Every link hash that has been tombstoned by some reachable commit. */
    tombstoned: Set<string>;
}

/**
 * Fold a set of diff-commits into the materialised link set using OR-Set
 * semantics: a link is present iff SOME reachable commit adds it and NO
 * reachable commit tombstones its exact content hash.
 *
 * This is order-independent: adds and tombstones are accumulated commutatively
 * (set union of adds, set union of tombstones, then subtract). It does not
 * matter which order the commits are visited in — the result is a pure function
 * of the reachable set. This is what makes concurrent add/remove converge with
 * no scribe or coordinator.
 *
 * @param commits All reachable commits (by hash). Ancestors must be included;
 *   dangling parent pointers are simply ignored (their diffs are absent).
 */
export function foldCommits(
    commits: Map<string, DiffCommit>,
    hashFn: (data: string) => string,
): FoldResult {
    const adds = new Map<string, LinkExpression>();
    const tombstoned = new Set<string>();

    for (const commit of commits.values()) {
        for (const link of commit.additions) {
            adds.set(hashLinkContent(link, hashFn), link);
        }
        for (const t of commit.removals) {
            tombstoned.add(t.linkHash);
        }
    }

    const links = new Map<string, LinkExpression>();
    for (const [h, link] of adds) {
        if (!tombstoned.has(h)) links.set(h, link);
    }

    return { links, tombstoned };
}

/**
 * Materialise the link array from a folded DAG.
 */
export function foldToLinks(
    commits: Map<string, DiffCommit>,
    hashFn: (data: string) => string,
): LinkExpression[] {
    return [...foldCommits(commits, hashFn).links.values()];
}

// ---------------------------------------------------------------------------
// Diff derivation between two folds (for incremental sync emission)
// ---------------------------------------------------------------------------

/**
 * Compute the PerspectiveDiff that carries `before` → `after`, using the
 * materialised link sets of two folds. Additions are links present in `after`
 * but not `before`; removals are links present in `before` but not `after`.
 * Removals reference the exact original link (so AD4M sees the real removed
 * link, not a placeholder).
 */
export function diffBetweenFolds(
    before: FoldResult,
    after: FoldResult,
): PerspectiveDiff {
    const additions: LinkExpression[] = [];
    for (const [h, link] of after.links) {
        if (!before.links.has(h)) additions.push(link);
    }

    const removals: LinkExpression[] = [];
    for (const [h, link] of before.links) {
        if (!after.links.has(h)) removals.push(link);
    }

    return { additions, removals };
}

// ---------------------------------------------------------------------------
// Commit construction
// ---------------------------------------------------------------------------

/**
 * Build a diff-commit from an AD4M PerspectiveDiff and the current parent
 * heads. Removals are turned into tombstones carrying the ORIGINAL link hash.
 */
export function buildCommit(
    diff: PerspectiveDiff,
    parents: string[],
    author: string,
    timestamp: string,
    hashFn: (data: string) => string,
): DiffCommit {
    const removals: Tombstone[] = diff.removals.map((link) => ({
        linkHash: hashLinkContent(link, hashFn),
        link,
    }));
    return {
        additions: [...diff.additions],
        removals,
        previous: [...parents],
        author,
        timestamp,
    };
}

// ---------------------------------------------------------------------------
// Turtle (de)serialisation of a commit resource
// ---------------------------------------------------------------------------

/**
 * Serialise a diff-commit to a Turtle document (the body of `diffs/<hash>`).
 *
 * Layout:
 *   <>            a ad4m:DiffCommit ;
 *                 ad4m:author "did:..." ;
 *                 ad4m:timestamp "..."^^xsd:dateTime ;
 *                 ad4m:previous "<parentHash>" , ... ;   # 0..n
 *                 ad4m:addition <#add-<linkHash>> , ... ;
 *                 ad4m:removal  <#rm-<linkHash>> , ... .
 *   <#add-<h>>    a ad4m:LinkExpression ; ad4m:linkHash "<h>" ; rdf:subject ... .
 *   <#rm-<h>>     a ad4m:Tombstone ; ad4m:removesLinkHash "<h>" ; rdf:subject ... .
 *
 * The addition/tombstone nodes carry the full reified link (source/predicate/
 * target + provenance) so a peer that fetches this single resource can fold it
 * with no other lookups.
 */
export function commitToTurtle(
    commit: DiffCommit,
    hashFn: (data: string) => string,
): string {
    const triples: RdfTriple[] = [];
    const root = "";

    triples.push({ subject: root, predicate: rdf.type, object: ad4m.DiffCommit, objectIsLiteral: false });
    triples.push({ subject: root, predicate: ad4m.author, object: commit.author, objectIsLiteral: true });
    triples.push({
        subject: root,
        predicate: ad4m.timestamp,
        object: commit.timestamp,
        objectIsLiteral: true,
        objectDatatype: xsd.dateTime,
    });

    for (const parent of [...commit.previous].sort()) {
        triples.push({ subject: root, predicate: ad4m.previous, object: parent, objectIsLiteral: true });
    }

    const addNodes: RdfTriple[] = [];
    for (const link of commit.additions) {
        const h = hashLinkContent(link, hashFn);
        const node = `#add-${h}`;
        triples.push({ subject: root, predicate: ad4m.addition, object: node, objectIsLiteral: false });
        addNodes.push(...reifiedLinkTriples(node, ad4m.LinkExpression, h, ad4m.linkHash, link));
    }

    const rmNodes: RdfTriple[] = [];
    for (const t of commit.removals) {
        const node = `#rm-${t.linkHash}`;
        triples.push({ subject: root, predicate: ad4m.removal, object: node, objectIsLiteral: false });
        rmNodes.push(...reifiedLinkTriples(node, ad4m.Tombstone, t.linkHash, ad4m.removesLinkHash, t.link));
    }

    triples.push(...addNodes, ...rmNodes);
    return triplesToTurtle(triples, DEFAULT_PREFIXES);
}

/**
 * Emit the reified triples for an addition or tombstone node: its type, the
 * link-hash property, and the full reified link (subject/predicate/object +
 * provenance).
 */
function reifiedLinkTriples(
    node: string,
    typeUri: string,
    linkHash: string,
    hashPredicate: string,
    link: LinkExpression,
): RdfTriple[] {
    const triples: RdfTriple[] = [
        { subject: node, predicate: rdf.type, object: typeUri, objectIsLiteral: false },
        { subject: node, predicate: hashPredicate, object: linkHash, objectIsLiteral: true },
        { subject: node, predicate: rdf.subject, object: link.data.source || "", objectIsLiteral: false },
        { subject: node, predicate: rdf.predicate, object: link.data.predicate || "", objectIsLiteral: false },
        { subject: node, predicate: rdf.object, object: link.data.target || "", objectIsLiteral: false },
        { subject: node, predicate: ad4m.author, object: link.author, objectIsLiteral: true },
        {
            subject: node,
            predicate: ad4m.timestamp,
            object: link.timestamp,
            objectIsLiteral: true,
            objectDatatype: xsd.dateTime,
        },
    ];
    if (link.proof?.signature) {
        triples.push({ subject: node, predicate: ad4m.proofSignature, object: link.proof.signature, objectIsLiteral: true });
    }
    if (link.proof?.key) {
        triples.push({ subject: node, predicate: ad4m.proofKey, object: link.proof.key, objectIsLiteral: true });
    }
    return triples;
}

/**
 * Parse a diff-commit from its Turtle resource graph. `baseUrl` is the resource
 * URL, used to resolve the `<>`/`<#...>` fragment subjects the parser produces.
 *
 * Returns null if the graph is not a diff-commit (no ad4m:DiffCommit type).
 */
export function commitFromGraph(graph: RdfGraph, baseUrl: string = ""): DiffCommit | null {
    // The turtle parser resolves `<>` to baseUrl and `<#x>` to baseUrl + "#x".
    const rootCandidates = new Set<string>([baseUrl, ""]);
    const rootSubject = graph.triples.find(
        (t) => t.predicate === rdf.type && t.object === ad4m.DiffCommit && rootCandidates.has(t.subject),
    )?.subject
        // fall back: any subject typed DiffCommit (covers non-empty baseUrl)
        ?? graph.triples.find((t) => t.predicate === rdf.type && t.object === ad4m.DiffCommit)?.subject;

    if (rootSubject === undefined) return null;

    const rootTriples = graph.triples.filter((t) => t.subject === rootSubject);
    const objectsOf = (pred: string): string[] =>
        rootTriples.filter((t) => t.predicate === pred).map((t) => t.object);
    const firstOf = (pred: string): string | undefined =>
        rootTriples.find((t) => t.predicate === pred)?.object;

    const author = firstOf(ad4m.author) ?? "";
    const timestamp = firstOf(ad4m.timestamp) ?? "";
    const previous = objectsOf(ad4m.previous);

    const additions: LinkExpression[] = [];
    for (const node of objectsOf(ad4m.addition)) {
        const link = linkFromNode(graph, node);
        if (link) additions.push(link);
    }

    const removals: Tombstone[] = [];
    for (const node of objectsOf(ad4m.removal)) {
        const nodeTriples = graph.triples.filter((t) => t.subject === node);
        const linkHash = nodeTriples.find((t) => t.predicate === ad4m.removesLinkHash)?.object;
        const link = linkFromNode(graph, node);
        if (linkHash && link) removals.push({ linkHash, link });
    }

    return { additions, removals, previous, author, timestamp };
}

/**
 * Reconstruct a LinkExpression from a reified addition/tombstone node.
 */
function linkFromNode(graph: RdfGraph, node: string): LinkExpression | null {
    const triples = graph.triples.filter((t) => t.subject === node);
    const val = (pred: string): string | undefined => triples.find((t) => t.predicate === pred)?.object;

    const source = val(rdf.subject);
    const predicate = val(rdf.predicate);
    const target = val(rdf.object);
    if (source === undefined || predicate === undefined || target === undefined) return null;

    return {
        author: val(ad4m.author) ?? "",
        timestamp: val(ad4m.timestamp) ?? "",
        data: { source, predicate, target },
        proof: {
            signature: val(ad4m.proofSignature) ?? "",
            key: val(ad4m.proofKey) ?? "",
        },
    };
}
