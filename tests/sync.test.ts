/**
 * Sync tests — the emulated diff-DAG walk over LDP.
 *
 * These exercise the real convergence path: a mock pod serves a `diffs/`
 * container listing plus immutable diff-commit resources (with ad4m:previous
 * pointers). `syncFromPod` must discover heads, walk ancestry (re-requesting
 * missing parents), fold the DAG with OR-Set semantics, and emit an incremental
 * PerspectiveDiff. It must NEVER snapshot-diff a container of link resources.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter, Transport, TransportResponse, RuntimeAdapter } from "../src/adapters.js";
import { initStorage, initTransport, initRuntime } from "../src/adapters.js";

import { syncFromPod, fullSync, getHeads } from "../src/sync.js";
import * as store from "../src/store.js";
import {
    buildCommit,
    commitToTurtle,
    commitHash,
    type DiffCommit,
} from "../src/diffdag.js";
import { diffsContainerUrl, diffResourceUrl } from "../src/ldp.js";
import { LDP_NS } from "../src/ontology.js";
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter(k => !prefix || k.startsWith(prefix));
    }
}

class MockTransport implements Transport {
    private responses = new Map<string, TransportResponse>();
    public gets: string[] = [];

    addResponse(url: string, body: string, status = 200): void {
        this.responses.set(url, { status, headers: {}, body });
    }

    async fetch(url: string, method: string, _h: Record<string, string>, _b: string): Promise<TransportResponse> {
        if (method === "GET") this.gets.push(url);
        return this.responses.get(url) ?? { status: 404, headers: {}, body: "Not found" };
    }
}

/** Deterministic content-address-like hash sufficient for tests. */
function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) { h = ((h << 5) - h + data.charCodeAt(i)) | 0; }
    // widen a little so distinct inputs rarely collide in a test
    let h2 = 5381;
    for (let i = 0; i < data.length; i++) { h2 = ((h2 << 5) + h2 + data.charCodeAt(i)) | 0; }
    return `Qm${Math.abs(h).toString(16)}${Math.abs(h2).toString(16)}`;
}

class MockRuntime implements RuntimeAdapter {
    /**
     * Records every PerspectiveDiff pushed through the host emit channel. This
     * is the SEAM that proves inbound peer folds are actually surfaced to the
     * executor: the AD4M runtime discards sync()'s return value, so links become
     * queryable ONLY via emitPerspectiveDiff. A silent no-op here would let the
     * A=10/B=10 convergence freeze pass the suite unnoticed.
     */
    public emittedDiffs: PerspectiveDiff[] = [];
    hash(data: string): string { return simpleHash(data); }
    emitSignal(): void {}
    emitPerspectiveDiff(diff: PerspectiveDiff): void { this.emittedDiffs.push(diff); }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POD_URL = "https://pod.example.com";
const CONTAINER_PATH = "/ad4m/neighbourhoods/test";
const DIFFS_URL = diffsContainerUrl(POD_URL, CONTAINER_PATH);

function makeLink(overrides?: Partial<LinkExpression> & { data?: Partial<LinkExpression["data"]> }): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T12:00:00.000Z",
        data: {
            source: "channel://main",
            predicate: "flux://has_message",
            target: "expr://msg1",
            ...(overrides?.data ?? {}),
        },
        proof: { signature: "sig", key: "key" },
        ...(() => { const o = { ...overrides }; delete (o as any).data; return o; })(),
    };
}

function makeContainerListing(resourceUrls: string[]): string {
    if (resourceUrls.length === 0) {
        return `@prefix ldp: <${LDP_NS}> .\n<> a ldp:BasicContainer .`;
    }
    const contains = resourceUrls.map(r => `<${r}>`).join(", ");
    return `@prefix ldp: <${LDP_NS}> .\n<> a ldp:BasicContainer ;\n    ldp:contains ${contains} .`;
}

/** Build a commit, serialise it to Turtle, and register it on the mock pod. */
function publishCommit(
    transport: MockTransport,
    diff: PerspectiveDiff,
    parents: string[],
    opts?: { author?: string; timestamp?: string },
): { hash: string; commit: DiffCommit } {
    const commit = buildCommit(
        diff,
        parents,
        opts?.author ?? "did:key:z6MkTest",
        opts?.timestamp ?? "2026-05-02T12:00:00.000Z",
        simpleHash,
    );
    const hash = commitHash(commit, simpleHash);
    transport.addResponse(diffResourceUrl(DIFFS_URL, hash), commitToTurtle(commit, simpleHash));
    return { hash, commit };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let storage: MockStorage;
let transport: MockTransport;
let runtime: MockRuntime;

function setup(): void {
    storage = new MockStorage();
    transport = new MockTransport();
    runtime = new MockRuntime();
    initStorage(storage);
    initTransport(transport);
    initRuntime(runtime);
    store.initStore(simpleHash);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncFromPod: DAG discovery + fold", () => {
    beforeEach(setup);

    it("returns empty diff when the pod has no diffs container", async () => {
        transport.addResponse(DIFFS_URL, "Not found", 404);
        const diff = await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("fetches a single genesis commit and materialises its link", async () => {
        const link = makeLink({ data: { target: "expr://new" } });
        const { hash } = publishCommit(transport, { additions: [link], removals: [] }, []);
        transport.addResponse(DIFFS_URL, makeContainerListing([diffResourceUrl(DIFFS_URL, hash)]));

        const diff = await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.target, "expr://new");
        // Revision is the head commit hash — a pointer into the DAG.
        assert.equal(store.getRevision(), hash);
        assert.deepEqual(getHeads(), [hash]);
    });

    it("walks ad4m:previous ancestry, re-requesting missing parents", async () => {
        // Chain: c1 (genesis) <- c2 <- c3. Only c3 is listed in the container;
        // c1 and c2 must be re-requested by following parent pointers.
        const l1 = makeLink({ data: { target: "expr://1" } });
        const l2 = makeLink({ data: { target: "expr://2" } });
        const l3 = makeLink({ data: { target: "expr://3" } });

        const c1 = publishCommit(transport, { additions: [l1], removals: [] }, []);
        const c2 = publishCommit(transport, { additions: [l2], removals: [] }, [c1.hash]);
        const c3 = publishCommit(transport, { additions: [l3], removals: [] }, [c2.hash]);

        // Container advertises ONLY the head.
        transport.addResponse(DIFFS_URL, makeContainerListing([diffResourceUrl(DIFFS_URL, c3.hash)]));

        const diff = await syncFromPod(POD_URL, CONTAINER_PATH);
        const targets = diff.additions.map(l => l.data.target).sort();
        assert.deepEqual(targets, ["expr://1", "expr://2", "expr://3"]);

        // All three commits were fetched (ancestry walk).
        assert.ok(transport.gets.includes(diffResourceUrl(DIFFS_URL, c1.hash)));
        assert.ok(transport.gets.includes(diffResourceUrl(DIFFS_URL, c2.hash)));
        assert.ok(transport.gets.includes(diffResourceUrl(DIFFS_URL, c3.hash)));
        // Head is the tip of the chain.
        assert.deepEqual(getHeads(), [c3.hash]);
    });

    it("emits only the incremental diff on a second sync", async () => {
        const l1 = makeLink({ data: { target: "expr://1" } });
        const c1 = publishCommit(transport, { additions: [l1], removals: [] }, []);
        transport.addResponse(DIFFS_URL, makeContainerListing([diffResourceUrl(DIFFS_URL, c1.hash)]));

        const first = await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(first.additions.length, 1);

        // Add a second commit; re-list the container with both.
        const l2 = makeLink({ data: { target: "expr://2" } });
        const c2 = publishCommit(transport, { additions: [l2], removals: [] }, [c1.hash]);
        transport.addResponse(
            DIFFS_URL,
            makeContainerListing([diffResourceUrl(DIFFS_URL, c1.hash), diffResourceUrl(DIFFS_URL, c2.hash)]),
        );

        const second = await syncFromPod(POD_URL, CONTAINER_PATH);
        // Only the newly-appeared link is emitted.
        assert.equal(second.additions.length, 1);
        assert.equal(second.additions[0].data.target, "expr://2");
    });

    it("is idempotent: re-syncing the same DAG emits nothing new", async () => {
        const { hash } = publishCommit(transport, { additions: [makeLink()], removals: [] }, []);
        transport.addResponse(DIFFS_URL, makeContainerListing([diffResourceUrl(DIFFS_URL, hash)]));

        await syncFromPod(POD_URL, CONTAINER_PATH);
        const again = await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(again.additions.length, 0);
        assert.equal(again.removals.length, 0);
    });
});

describe("syncFromPod: emits inbound folds to the executor", () => {
    beforeEach(setup);

    // REGRESSION: the AD4M runtime DISCARDS sync()'s return value —
    // `Language::sync()` runs `perspectiveSyncSync()` purely for side effects
    // (rust-executor/src/languages/language.rs). Inbound peer links become
    // queryable on the perspective ONLY through the emitPerspectiveDiff host
    // channel. Without the emit inside syncFromPod, the pod's diff-DAG folds
    // correctly into the language's own store but `perspective.queryLinks`
    // never sees remote links — the observed live C1 freeze at A=10/B=10 that
    // this suite previously failed to catch because MockRuntime.emitPerspectiveDiff
    // was a silent no-op.
    it("pushes newly-folded peer links through emitPerspectiveDiff exactly once", async () => {
        const l1 = makeLink({ data: { target: "expr://peer-1" } });
        const l2 = makeLink({ data: { target: "expr://peer-2" } });
        const c1 = publishCommit(transport, { additions: [l1], removals: [] }, []);
        const c2 = publishCommit(transport, { additions: [l2], removals: [] }, [c1.hash]);
        transport.addResponse(
            DIFFS_URL,
            makeContainerListing([diffResourceUrl(DIFFS_URL, c1.hash), diffResourceUrl(DIFFS_URL, c2.hash)]),
        );

        const returned = await syncFromPod(POD_URL, CONTAINER_PATH);

        // The fold happened...
        assert.equal(returned.additions.length, 2);
        // ...AND it was pushed to the executor (not just returned into the void).
        assert.equal(runtime.emittedDiffs.length, 1, "expected exactly one emitPerspectiveDiff for a non-empty fold");
        const emitted = runtime.emittedDiffs[0];
        const emittedTargets = emitted.additions.map(l => l.data.target).sort();
        assert.deepEqual(emittedTargets, ["expr://peer-1", "expr://peer-2"]);
        assert.equal(emitted.removals.length, 0);
    });

    it("does NOT emit when the fold is empty (idempotent re-sync)", async () => {
        const { hash } = publishCommit(transport, { additions: [makeLink()], removals: [] }, []);
        transport.addResponse(DIFFS_URL, makeContainerListing([diffResourceUrl(DIFFS_URL, hash)]));

        await syncFromPod(POD_URL, CONTAINER_PATH);
        const emittedAfterFirst = runtime.emittedDiffs.length;
        assert.equal(emittedAfterFirst, 1);

        // Second sync sees no new commits — nothing must be pushed to the executor.
        await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(runtime.emittedDiffs.length, emittedAfterFirst, "empty fold must not emit");
    });

    it("emits a removal delta when a tombstone lands after a prior sync", async () => {
        const link = makeLink({ data: { target: "expr://gone" } });
        const add = publishCommit(transport, { additions: [link], removals: [] }, []);
        transport.addResponse(DIFFS_URL, makeContainerListing([diffResourceUrl(DIFFS_URL, add.hash)]));

        await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(runtime.emittedDiffs.length, 1);

        const rm = publishCommit(transport, { additions: [], removals: [link] }, [add.hash]);
        transport.addResponse(
            DIFFS_URL,
            makeContainerListing([diffResourceUrl(DIFFS_URL, add.hash), diffResourceUrl(DIFFS_URL, rm.hash)]),
        );

        await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(runtime.emittedDiffs.length, 2, "tombstone fold must emit a second diff");
        const removalDelta = runtime.emittedDiffs[1];
        assert.equal(removalDelta.removals.length, 1);
        assert.equal(removalDelta.removals[0].data.target, "expr://gone");
    });
});

describe("syncFromPod: removal convergence via tombstones", () => {
    beforeEach(setup);

    it("a tombstone commit removes the original add on fold", async () => {
        const link = makeLink({ data: { target: "expr://removeme" } });
        const add = publishCommit(transport, { additions: [link], removals: [] }, []);
        // Removal commit carries the ORIGINAL link (tombstone keyed by its hash).
        const rm = publishCommit(transport, { additions: [], removals: [link] }, [add.hash]);

        transport.addResponse(DIFFS_URL, makeContainerListing([diffResourceUrl(DIFFS_URL, rm.hash)]));

        const diff = await syncFromPod(POD_URL, CONTAINER_PATH);
        // Net effect on a fresh replica: the link is absent (add - tombstone).
        assert.equal(diff.additions.length, 0);
        assert.equal(store.allLinks().links.length, 0);
    });

    it("removal after a prior sync emits the link as a removal", async () => {
        const link = makeLink({ data: { target: "expr://x" } });
        const add = publishCommit(transport, { additions: [link], removals: [] }, []);
        transport.addResponse(DIFFS_URL, makeContainerListing([diffResourceUrl(DIFFS_URL, add.hash)]));

        const first = await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(first.additions.length, 1);

        const rm = publishCommit(transport, { additions: [], removals: [link] }, [add.hash]);
        transport.addResponse(
            DIFFS_URL,
            makeContainerListing([diffResourceUrl(DIFFS_URL, add.hash), diffResourceUrl(DIFFS_URL, rm.hash)]),
        );

        const second = await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(second.removals.length, 1);
        assert.equal(second.removals[0].data.target, "expr://x");
        assert.equal(store.allLinks().links.length, 0);
    });
});

describe("fullSync", () => {
    beforeEach(setup);

    it("walks the whole DAG the pod exposes", async () => {
        const l1 = makeLink({ data: { target: "expr://a" } });
        const l2 = makeLink({ data: { target: "expr://b" } });
        const c1 = publishCommit(transport, { additions: [l1], removals: [] }, []);
        const c2 = publishCommit(transport, { additions: [l2], removals: [] }, [c1.hash]);
        transport.addResponse(
            DIFFS_URL,
            makeContainerListing([diffResourceUrl(DIFFS_URL, c1.hash), diffResourceUrl(DIFFS_URL, c2.hash)]),
        );

        const diff = await fullSync(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 2);
    });

    it("handles an empty diffs container", async () => {
        transport.addResponse(DIFFS_URL, makeContainerListing([]));
        const diff = await fullSync(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 0);
        assert.equal(store.getRevision(), null);
    });
});
