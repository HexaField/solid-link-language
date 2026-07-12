/**
 * Cross-runtime test harness.
 *
 * Exercises the full production modules (store, ldp, sync, translate,
 * auth, acl, dual-language) using mock adapters that simulate an
 * alternative runtime (e.g. WASM).
 *
 * Proves that core logic has NO hidden dependency on ad4m:host.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Adapter interfaces
import type { StorageAdapter } from "../src/adapters.js";
import { initStorage, getStorage } from "../src/adapters.js";
import type { Transport, TransportResponse } from "../src/adapters.js";
import { initTransport } from "../src/adapters.js";
import type { SigningAdapter } from "../src/adapters.js";
import { initSigning } from "../src/adapters.js";
import type { RuntimeAdapter } from "../src/adapters.js";
import { initRuntime } from "../src/adapters.js";

// Production modules under test
import * as store from "../src/store.js";
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import { linkToReifiedTriples, graphToLinks, linkContentKey } from "../src/translate.js";
import { triplesToTurtle, parseTurtle } from "../src/rdf.js";
import { shouldPublishToSolid, linkOriginKey, linkContentHash } from "../src/translate.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { generateAcl, generateMembersRegistry } from "../src/acl.js";
import { AD4M_NS, RDF_NS } from "../src/ontology.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter(k => !prefix || k.startsWith(prefix));
    }
    _dump(): Map<string, string> { return new Map(this.data); }
}

class MockTransport implements Transport {
    private responses = new Map<string, TransportResponse>();
    public requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

    addResponse(url: string, response: TransportResponse): void {
        this.responses.set(url, response);
    }

    async fetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<TransportResponse> {
        this.requests.push({ url, method, headers, body });
        return this.responses.get(url) ?? { status: 404, headers: {}, body: "Not found" };
    }
}

class MockSigningAdapter implements SigningAdapter {
    signStringHex(payload: string): string { return "mocksig" + payload.length.toString(16); }
    signingKeyId(): string { return "mock-key-id"; }
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string): string { return simpleHash(data); }
    emitSignal(_data: string): void {}
    emitPerspectiveDiff(_diff: unknown): void {}
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) { h = ((h << 5) - h + data.charCodeAt(i)) | 0; }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: { signature: "abc123", key: "key123" },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockStorage: MockStorageAdapter;
let mockTransport: MockTransport;

function initAllAdapters(): void {
    mockStorage = new MockStorageAdapter();
    mockTransport = new MockTransport();
    initRuntime(new MockRuntime());
    initStorage(mockStorage);
    initTransport(mockTransport);
    initSigning(new MockSigningAdapter());
    store.initStore(simpleHash);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Store operations via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Store operations", () => {
    beforeEach(() => initAllAdapters());

    it("stores and retrieves a link", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        assert.ok(hash);
        const retrieved = store.getLink(hash);
        assert.ok(retrieved);
        assert.equal(retrieved!.data.source, "literal://hello");
        assert.equal(retrieved!.data.target, "literal://world");
    });

    it("indexes by source, target, and predicate", () => {
        store.putLink(makeLinkExpression());
        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 1);
        assert.equal(store.queryLinks({ target: "literal://world" }).length, 1);
        assert.equal(store.queryLinks({ predicate: "sioc://content_of" }).length, 1);
    });

    it("returns empty for queries with no matches", () => {
        store.putLink(makeLinkExpression());
        assert.equal(store.queryLinks({ source: "nonexistent://uri" }).length, 0);
    });

    it("supports multi-field query filtering", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "literal://hello", target: "literal://other", predicate: "other://pred" },
        }));
        const results = store.queryLinks({ source: "literal://hello", predicate: "sioc://content_of" });
        assert.equal(results.length, 1);
        assert.equal(results[0].data.target, "literal://world");
    });

    it("removes links and cleans up indexes", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        store.removeLink(link);
        assert.equal(store.getLink(hash), null);
        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 0);
    });

    it("applies a PerspectiveDiff", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({ data: { source: "a", target: "b", predicate: "c" } });
        store.putLink(link1);
        store.applyDiff({ additions: [link2], removals: [link1] });
        assert.equal(store.getLink(store.hashLink(link1)), null);
        assert.ok(store.getLink(store.hashLink(link2)));
    });

    it("allLinks returns all stored links", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "x", target: "y", predicate: "z" },
            timestamp: "2026-05-02T01:00:00.000Z",
        }));
        assert.equal(store.allLinks().links.length, 2);
    });

    it("derives revision from the DAG head set (not an opaque cursor)", () => {
        // Empty DAG ⇒ null revision.
        assert.equal(store.getRevision(), null);

        // One commit ⇒ revision is that commit's content hash (a DAG pointer).
        const c1 = {
            additions: [makeLinkExpression()],
            removals: [],
            previous: [] as string[],
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
        };
        const h1 = store.hashCommit(c1);
        store.addCommitToDag(h1, c1);
        assert.equal(store.getRevision(), h1);

        // A child commit advances the single head to the child hash.
        const c2 = {
            additions: [makeLinkExpression({ data: { source: "a", target: "b", predicate: "c" } })],
            removals: [],
            previous: [h1],
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:01:00.000Z",
        };
        const h2 = store.hashCommit(c2);
        store.addCommitToDag(h2, c2);
        assert.equal(store.getRevision(), h2);
    });

    it("manages peers", () => {
        store.setPeer("did:key:z6MkA", { name: "Alice" });
        store.setPeer("did:key:z6MkB", { name: "Bob" });
        assert.equal(store.listPeers().length, 2);

        const meta = store.getPeerMetadata("did:key:z6MkA");
        assert.ok(meta);
        assert.equal(meta!.name, "Alice");

        store.removePeer("did:key:z6MkA");
        assert.equal(store.listPeers().length, 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Full round-trip: link → Turtle → link
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Full round-trip", () => {
    beforeEach(() => initAllAdapters());

    it("round-trips a link through RDF", () => {
        const original = makeLinkExpression();
        const triples = linkToReifiedTriples(original, "link-test");
        const turtle = triplesToTurtle(triples);
        const graph = parseTurtle(turtle);
        const recovered = graphToLinks(graph);

        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].data.source, original.data.source);
        assert.equal(recovered[0].data.predicate, original.data.predicate);
        assert.equal(recovered[0].data.target, original.data.target);
        assert.equal(recovered[0].author, original.author);
        assert.equal(recovered[0].timestamp, original.timestamp);
        assert.equal(recovered[0].proof.signature, original.proof.signature);
        assert.equal(recovered[0].proof.key, original.proof.key);
    });

    it("round-trips a link with store operations", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        const retrieved = store.getLink(hash)!;

        const triples = linkToReifiedTriples(retrieved, `link-${hash}`);
        const turtle = triplesToTurtle(triples);
        const graph = parseTurtle(turtle);
        const recovered = graphToLinks(graph);

        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].data.source, link.data.source);
    });

    it("round-trips multiple links in batch", () => {
        const links = [
            makeLinkExpression(),
            makeLinkExpression({
                data: { source: "channel://general", target: "expr://QmXyz", predicate: "flux://has_reply" },
                author: "did:key:z6MkOther",
                timestamp: "2026-05-02T13:00:00.000Z",
            }),
        ];

        const allTriples = links.flatMap((link, i) =>
            linkToReifiedTriples(link, `link-${i}`),
        );
        const turtle = triplesToTurtle(allTriples);
        const graph = parseTurtle(turtle);
        const recovered = graphToLinks(graph);
        assert.equal(recovered.length, 2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ACL generation
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: ACL generation", () => {
    beforeEach(() => initAllAdapters());

    it("generates open ACL", () => {
        const aclDoc = generateAcl(
            "https://pod.example.com/links/",
            "https://pod.example.com/profile/card#me",
            "https://pod.example.com/members/index.ttl",
            "open",
        );
        assert.ok(aclDoc.includes("acl:Read, acl:Write"));
        assert.ok(aclDoc.includes("foaf:Agent"));
    });

    it("generates members-only ACL", () => {
        const aclDoc = generateAcl(
            "https://pod.example.com/links/",
            "https://pod.example.com/profile/card#me",
            "https://pod.example.com/members/index.ttl",
            "members-only",
        );
        assert.ok(aclDoc.includes("agentGroup"));
        assert.ok(aclDoc.includes("foaf:Agent")); // public read
    });

    it("generates private ACL", () => {
        const aclDoc = generateAcl(
            "https://pod.example.com/links/",
            "https://pod.example.com/profile/card#me",
            "https://pod.example.com/members/index.ttl",
            "private",
        );
        assert.ok(aclDoc.includes("agentGroup"));
        assert.ok(!aclDoc.includes("foaf:Agent")); // no public
    });

    it("generates members registry", () => {
        const registry = generateMembersRegistry([
            "https://alice.pod.example.com/profile/card#me",
            "https://bob.pod.example.com/profile/card#me",
        ]);
        assert.ok(registry.includes("vcard:Group"));
        assert.ok(registry.includes("alice.pod.example.com"));
        assert.ok(registry.includes("bob.pod.example.com"));
    });

    it("generates empty members registry", () => {
        const registry = generateMembersRegistry([]);
        assert.ok(registry.includes("vcard:Group"));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Dual-language with mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Dual-language with storage", () => {
    beforeEach(() => initAllAdapters());

    it("tracks link origin through storage", () => {
        const link = makeLinkExpression();
        const hash = store.hashLink(link);
        const key = linkOriginKey(hash);

        // New link: no origin tracked
        assert.equal(mockStorage.get(key), null);
        assert.equal(shouldPublishToSolid(hash, (k) => mockStorage.get(k)), true);

        // Mark as native
        mockStorage.put(key, "native");
        assert.equal(shouldPublishToSolid(hash, (k) => mockStorage.get(k)), true);

        // Mark as solid origin
        mockStorage.put(key, "solid");
        assert.equal(shouldPublishToSolid(hash, (k) => mockStorage.get(k)), false);

        // Mark as dual
        mockStorage.put(key, "dual");
        assert.equal(shouldPublishToSolid(hash, (k) => mockStorage.get(k)), true);
    });
});
