/**
 * Diff-DAG regression tests — the acceptance criteria of
 * SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE §5 for the Solid (emulated) language.
 *
 * These tests would all FAIL against the old fake (container-ETag revision,
 * snapshot-diff sync, owner-only HTTP DELETE removals). They pin:
 *   1. currentRevision = content hash of the DAG head(s), deterministic.
 *   2. DAG authoritative: folding from genesis reproduces the link set.
 *   3. Removal convergence + order-independent merge.
 *   4. Turtle commit resources carry ad4m:previous and round-trip losslessly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    hashLinkContent,
    commitHash,
    canonicalCommitString,
    revisionOfHeads,
    computeHeads,
    foldCommits,
    foldToLinks,
    diffBetweenFolds,
    buildCommit,
    commitToTurtle,
    commitFromGraph,
    type DiffCommit,
    type Tombstone,
} from "../src/diffdag.js";
import { parseTurtle } from "../src/rdf.js";
import { ad4m } from "../src/ontology.js";
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) { h = ((h << 5) - h + data.charCodeAt(i)) | 0; }
    let h2 = 5381;
    for (let i = 0; i < data.length; i++) { h2 = ((h2 << 5) + h2 + data.charCodeAt(i)) | 0; }
    return `Qm${Math.abs(h).toString(16)}${Math.abs(h2).toString(16)}`;
}

function makeLink(target: string, source = "channel://main", predicate = "flux://has_message"): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T12:00:00.000Z",
        data: { source, predicate, target },
        proof: { signature: "sig", key: "key" },
    };
}

/** Build a commit + its content hash together. */
function commit(diff: PerspectiveDiff, parents: string[], ts = "2026-05-02T12:00:00.000Z"): { hash: string; commit: DiffCommit } {
    const c = buildCommit(diff, parents, "did:key:z6MkTest", ts, simpleHash);
    return { hash: commitHash(c, simpleHash), commit: c };
}

function dagOf(...pairs: { hash: string; commit: DiffCommit }[]): Map<string, DiffCommit> {
    const m = new Map<string, DiffCommit>();
    for (const p of pairs) m.set(p.hash, p.commit);
    return m;
}

// ---------------------------------------------------------------------------
// 1. Content-hash naming + determinism
// ---------------------------------------------------------------------------

describe("commitHash: content-addressed + deterministic", () => {
    it("is stable for identical commit content", () => {
        const a = commit({ additions: [makeLink("expr://1")], removals: [] }, []);
        const b = commit({ additions: [makeLink("expr://1")], removals: [] }, []);
        assert.equal(a.hash, b.hash);
    });

    it("changes when the added link changes", () => {
        const a = commit({ additions: [makeLink("expr://1")], removals: [] }, []);
        const b = commit({ additions: [makeLink("expr://2")], removals: [] }, []);
        assert.notEqual(a.hash, b.hash);
    });

    it("changes when the parent set changes", () => {
        const genesis = commit({ additions: [makeLink("expr://1")], removals: [] }, []);
        const child = commit({ additions: [makeLink("expr://2")], removals: [] }, [genesis.hash]);
        const orphan = commit({ additions: [makeLink("expr://2")], removals: [] }, []);
        assert.notEqual(child.hash, orphan.hash);
    });

    it("is independent of addition insertion order (canonical sort)", () => {
        const l1 = makeLink("expr://1");
        const l2 = makeLink("expr://2");
        const a = commit({ additions: [l1, l2], removals: [] }, []);
        const b = commit({ additions: [l2, l1], removals: [] }, []);
        assert.equal(a.hash, b.hash);
        assert.equal(canonicalCommitString(a.commit, simpleHash), canonicalCommitString(b.commit, simpleHash));
    });

    it("is independent of parent order", () => {
        const p1 = commit({ additions: [makeLink("expr://p1")], removals: [] }, []);
        const p2 = commit({ additions: [makeLink("expr://p2")], removals: [] }, []);
        const mergeA = commit({ additions: [], removals: [] }, [p1.hash, p2.hash]);
        const mergeB = commit({ additions: [], removals: [] }, [p2.hash, p1.hash]);
        assert.equal(mergeA.hash, mergeB.hash);
    });
});

// ---------------------------------------------------------------------------
// 2. currentRevision = head-set content hash
// ---------------------------------------------------------------------------

describe("revisionOfHeads", () => {
    it("is null for the empty DAG", () => {
        assert.equal(revisionOfHeads([], simpleHash), null);
    });

    it("is the head hash itself for a single head", () => {
        assert.equal(revisionOfHeads(["Qmabc"], simpleHash), "Qmabc");
    });

    it("is a deterministic digest of the sorted head set for concurrent heads", () => {
        const r1 = revisionOfHeads(["QmB", "QmA"], simpleHash);
        const r2 = revisionOfHeads(["QmA", "QmB"], simpleHash);
        assert.equal(r1, r2);
        // Distinct from either head hash (it is a digest, not a member).
        assert.notEqual(r1, "QmA");
        assert.notEqual(r1, "QmB");
    });

    it("computeHeads picks commits not referenced as a parent", () => {
        const genesis = commit({ additions: [makeLink("expr://g")], removals: [] }, []);
        const child = commit({ additions: [makeLink("expr://c")], removals: [] }, [genesis.hash]);
        const heads = computeHeads(dagOf(genesis, child));
        assert.deepEqual(heads, [child.hash]);
    });

    it("computeHeads reports concurrent branches as multiple heads", () => {
        const genesis = commit({ additions: [makeLink("expr://g")], removals: [] }, []);
        const branchA = commit({ additions: [makeLink("expr://a")], removals: [] }, [genesis.hash]);
        const branchB = commit({ additions: [makeLink("expr://b")], removals: [] }, [genesis.hash]);
        const heads = computeHeads(dagOf(genesis, branchA, branchB));
        assert.deepEqual(heads.sort(), [branchA.hash, branchB.hash].sort());
    });
});

// ---------------------------------------------------------------------------
// 3. DAG authoritative — folding from genesis reproduces the link set
// ---------------------------------------------------------------------------

describe("foldCommits: DAG is authoritative", () => {
    it("folding a chain reproduces exactly the added links", () => {
        const c1 = commit({ additions: [makeLink("expr://1")], removals: [] }, []);
        const c2 = commit({ additions: [makeLink("expr://2")], removals: [] }, [c1.hash]);
        const c3 = commit({ additions: [makeLink("expr://3")], removals: [] }, [c2.hash]);

        const links = foldToLinks(dagOf(c1, c2, c3), simpleHash);
        const targets = links.map(l => l.data.target).sort();
        assert.deepEqual(targets, ["expr://1", "expr://2", "expr://3"]);
    });

    it("a link added then tombstoned is absent from the fold", () => {
        const link = makeLink("expr://gone");
        const add = commit({ additions: [link], removals: [] }, []);
        const rm = commit({ additions: [], removals: [link] }, [add.hash]);

        const result = foldCommits(dagOf(add, rm), simpleHash);
        assert.equal(result.links.size, 0);
        assert.ok(result.tombstoned.has(hashLinkContent(link, simpleHash)));
    });

    it("a tombstone converges against its add even when the removal's proof is stripped", () => {
        // The live-executor removal contract: perspective.removeLink hands the
        // language a LinkExpression with an EMPTY proof — the original signature
        // is NOT round-tripped into the removal diff. A peer replica folded the
        // ADD with its real proof; the tombstone must still reference the SAME
        // OR-Set key or the removal can never fold out. This models the exact C1
        // failure: adds converged 20/20 but the removal froze because the
        // tombstone (empty proof) and the folded add (real proof) hashed
        // differently. The previous tombstone test reused one object for add and
        // removal, so it never exercised this and passed while the live bug stood.
        const added: LinkExpression = {
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T12:00:00.000Z",
            data: { source: "channel://main", predicate: "flux://has_message", target: "expr://signed" },
            proof: { signature: "210c5b60deadbeeffeed", key: "did:key:z6MkTest#z6MkTest" },
        };
        // What the executor actually passes to commit() for the removal.
        const removedForm: LinkExpression = { ...added, proof: { signature: "", key: "" } };

        assert.equal(
            hashLinkContent(added, simpleHash),
            hashLinkContent(removedForm, simpleHash),
            "an add and its proof-stripped removal form must share the OR-Set key",
        );

        const add = commit({ additions: [added], removals: [] }, []);
        const rm = commit({ additions: [], removals: [removedForm] }, [add.hash]);
        const result = foldCommits(dagOf(add, rm), simpleHash);
        assert.equal(result.links.size, 0, "the tombstone must fold the signed add out");
    });

    it("timestamp remains part of the identity key (it round-trips; proof does not)", () => {
        // Sibling-consistent decision (nostr/ipfs key on s:p:t:author:timestamp):
        // timestamp DOES survive removeLink, so two links differing only in
        // timestamp are distinct OR-Set elements — only proof is excluded.
        const t1 = makeLink("expr://ts");
        const t2 = { ...makeLink("expr://ts"), timestamp: "2026-05-02T13:00:00.000Z" };
        assert.notEqual(hashLinkContent(t1, simpleHash), hashLinkContent(t2, simpleHash));
    });

    it("re-adding after a tombstone stays removed (observed-remove semantics)", () => {
        // Same logical link (identical hash) re-added after removal remains
        // tombstoned — the tombstone observed that exact hash.
        const link = makeLink("expr://re");
        const add = commit({ additions: [link], removals: [] }, []);
        const rm = commit({ additions: [], removals: [link] }, [add.hash]);
        const readd = commit({ additions: [link], removals: [] }, [rm.hash]);

        const links = foldToLinks(dagOf(add, rm, readd), simpleHash);
        assert.equal(links.length, 0);
    });
});

// ---------------------------------------------------------------------------
// 4. Order-independent merge
// ---------------------------------------------------------------------------

describe("merge is order-independent", () => {
    it("applying {d1,d2} in either order yields the same fold + revision", () => {
        const genesis = commit({ additions: [makeLink("expr://g")], removals: [] }, []);
        // Two concurrent children off the same genesis.
        const d1 = commit({ additions: [makeLink("expr://d1")], removals: [] }, [genesis.hash], "2026-05-02T12:01:00.000Z");
        const d2 = commit({ additions: [makeLink("expr://d2")], removals: [] }, [genesis.hash], "2026-05-02T12:02:00.000Z");

        const forward = dagOf(genesis, d1, d2);
        const reverse = dagOf(genesis, d2, d1);

        const linksF = foldToLinks(forward, simpleHash).map(l => l.data.target).sort();
        const linksR = foldToLinks(reverse, simpleHash).map(l => l.data.target).sort();
        assert.deepEqual(linksF, linksR);

        // Revision (head-set digest) is identical regardless of visitation order.
        const revF = revisionOfHeads(computeHeads(forward), simpleHash);
        const revR = revisionOfHeads(computeHeads(reverse), simpleHash);
        assert.equal(revF, revR);
    });

    it("concurrent add on one branch + remove on another converges to removed", () => {
        // A adds L (genesis). Concurrently B removes L. Merge → L absent on both.
        const link = makeLink("expr://conflict");
        const addByA = commit({ additions: [link], removals: [] }, []);
        const removeByB = commit({ additions: [], removals: [link] }, [addByA.hash], "2026-05-02T12:05:00.000Z");

        // Replica 1 sees add then remove; replica 2 sees remove then add (same set).
        const r1 = foldToLinks(dagOf(addByA, removeByB), simpleHash);
        const r2 = foldToLinks(dagOf(removeByB, addByA), simpleHash);
        assert.equal(r1.length, 0);
        assert.equal(r2.length, 0);
    });
});

// ---------------------------------------------------------------------------
// 5. diffBetweenFolds — incremental emission
// ---------------------------------------------------------------------------

describe("diffBetweenFolds", () => {
    it("reports additions and removals against a prior fold", () => {
        const l1 = makeLink("expr://keep");
        const l2 = makeLink("expr://new");
        const before = foldCommits(dagOf(commit({ additions: [l1], removals: [] }, [])), simpleHash);

        const c1 = commit({ additions: [l1], removals: [] }, []);
        const c2 = commit({ additions: [l2], removals: [] }, [c1.hash]);
        const after = foldCommits(dagOf(c1, c2), simpleHash);

        const diff = diffBetweenFolds(before, after);
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.target, "expr://new");
        assert.equal(diff.removals.length, 0);
    });

    it("a removed link appears in the removals with its original data", () => {
        const link = makeLink("expr://x");
        const add = commit({ additions: [link], removals: [] }, []);
        const before = foldCommits(dagOf(add), simpleHash);

        const rm = commit({ additions: [], removals: [link] }, [add.hash]);
        const after = foldCommits(dagOf(add, rm), simpleHash);

        const diff = diffBetweenFolds(before, after);
        assert.equal(diff.removals.length, 1);
        assert.equal(diff.removals[0].data.target, "expr://x");
        assert.equal(diff.removals[0].data.source, "channel://main");
    });
});

// ---------------------------------------------------------------------------
// 6. Turtle commit resource: ad4m:previous + lossless round-trip
// ---------------------------------------------------------------------------

describe("commitToTurtle / commitFromGraph", () => {
    const RES_URL = "https://pod.example.com/ad4m/neighbourhoods/test/diffs/diff-Qm123.ttl";

    it("serialises ad4m:previous pointers for each parent", () => {
        const genesis = commit({ additions: [makeLink("expr://g")], removals: [] }, []);
        const child = commit({ additions: [makeLink("expr://c")], removals: [] }, [genesis.hash]);
        const ttl = commitToTurtle(child.commit, simpleHash);
        assert.ok(ttl.includes("ad4m:previous"));
        assert.ok(ttl.includes(genesis.hash));
        assert.ok(ttl.includes("ad4m:DiffCommit"));
    });

    it("round-trips a genesis commit losslessly", () => {
        const c = commit({ additions: [makeLink("expr://1"), makeLink("expr://2")], removals: [] }, []);
        const ttl = commitToTurtle(c.commit, simpleHash);
        const parsed = commitFromGraph(parseTurtle(ttl, RES_URL), RES_URL);
        assert.ok(parsed);
        assert.equal(parsed!.additions.length, 2);
        assert.equal(parsed!.removals.length, 0);
        assert.deepEqual(parsed!.previous, []);
        // Rehashing the parsed commit reproduces the same content hash.
        assert.equal(commitHash(parsed!, simpleHash), c.hash);
    });

    it("round-trips a commit with parents + tombstones, preserving the original link hash", () => {
        const link = makeLink("expr://removed");
        const parent = commit({ additions: [link], removals: [] }, []);
        const c = commit({ additions: [makeLink("expr://added")], removals: [link] }, [parent.hash]);

        const ttl = commitToTurtle(c.commit, simpleHash);
        const parsed = commitFromGraph(parseTurtle(ttl, RES_URL), RES_URL);
        assert.ok(parsed);
        assert.deepEqual(parsed!.previous, [parent.hash]);
        assert.equal(parsed!.additions.length, 1);
        assert.equal(parsed!.removals.length, 1);
        // The tombstone carries the ORIGINAL link's content hash.
        assert.equal(parsed!.removals[0].linkHash, hashLinkContent(link, simpleHash));
        assert.equal(parsed!.removals[0].link.data.target, "expr://removed");
        // Content hash preserved through serialise → parse.
        assert.equal(commitHash(parsed!, simpleHash), c.hash);
    });

    it("returns null for a non-commit graph", () => {
        const ttl = `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> a ldp:BasicContainer .`;
        const parsed = commitFromGraph(parseTurtle(ttl, RES_URL), RES_URL);
        assert.equal(parsed, null);
    });
});
