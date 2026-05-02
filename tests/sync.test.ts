/**
 * Tests for container polling and ETag-based sync.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { initTransport } from "../src/transport.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";

import { syncFromPod, fullSync, getSyncEtag } from "../src/sync.js";
import * as store from "../src/store.js";
import { AD4M_NS, RDF_NS, XSD_NS, LDP_NS } from "../src/ontology.js";

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
    public requests: Array<{ url: string; method: string }> = [];

    addResponse(url: string, response: TransportResponse): void {
        this.responses.set(url, response);
    }

    async fetch(url: string, method: string, _headers: Record<string, string>, _body: string): Promise<TransportResponse> {
        this.requests.push({ url, method });
        const resp = this.responses.get(url);
        if (!resp) return { status: 404, headers: {}, body: "Not found" };
        return resp;
    }
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) { h = ((h << 5) - h + data.charCodeAt(i)) | 0; }
    return `Qm${Math.abs(h).toString(16)}`;
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string): string { return simpleHash(data); }
    emitSignal(_data: string): void {}
    emitPerspectiveDiff(_diff: unknown): void {}
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POD_URL = "https://pod.example.com";
const CONTAINER_PATH = "/ad4m/neighbourhoods/test";
const CONTAINER_URL = `${POD_URL}${CONTAINER_PATH}/links/`;

function makeLinkTurtle(source: string, predicate: string, target: string): string {
    return [
        `@prefix ad4m: <${AD4M_NS}> .`,
        `@prefix rdf: <${RDF_NS}> .`,
        `@prefix xsd: <${XSD_NS}> .`,
        ``,
        `<#link-1> a ad4m:LinkExpression ;`,
        `    rdf:subject <${source}> ;`,
        `    rdf:predicate <${predicate}> ;`,
        `    rdf:object <${target}> ;`,
        `    ad4m:author "did:key:z6MkTest" ;`,
        `    ad4m:timestamp "2026-05-02T12:00:00.000Z"^^xsd:dateTime ;`,
        `    ad4m:proofSignature "sig" ;`,
        `    ad4m:proofKey "key" .`,
    ].join("\n");
}

function makeContainerListing(resources: string[]): string {
    if (resources.length === 0) {
        return `@prefix ldp: <${LDP_NS}> .\n<> a ldp:BasicContainer .`;
    }
    const contains = resources.map(r => `<${r}>`).join(", ");
    return `@prefix ldp: <${LDP_NS}> .\n<> a ldp:BasicContainer ;\n    ldp:contains ${contains} .`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockStorage: MockStorage;
let mockTransport: MockTransport;

function setup(): void {
    mockStorage = new MockStorage();
    mockTransport = new MockTransport();
    initStorage(mockStorage);
    initTransport(mockTransport);
    initRuntime(new MockRuntime());
    store.initStore(simpleHash);
}

describe("fullSync", () => {
    beforeEach(() => { setup(); });

    it("fetches all resources from container", async () => {
        const r1 = `${CONTAINER_URL}link-abc.ttl`;
        const r2 = `${CONTAINER_URL}link-def.ttl`;

        mockTransport.addResponse(CONTAINER_URL, {
            status: 200,
            headers: { "ETag": '"etag-1"' },
            body: makeContainerListing([r1, r2]),
        });
        mockTransport.addResponse(r1, {
            status: 200, headers: {},
            body: makeLinkTurtle("channel://main", "flux://has_message", "expr://msg1"),
        });
        mockTransport.addResponse(r2, {
            status: 200, headers: {},
            body: makeLinkTurtle("channel://general", "flux://has_reply", "expr://msg2"),
        });

        const diff = await fullSync(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 0);
    });

    it("stores container ETag", async () => {
        mockTransport.addResponse(CONTAINER_URL, {
            status: 200,
            headers: { "ETag": '"container-etag"' },
            body: makeContainerListing([]),
        });

        await fullSync(POD_URL, CONTAINER_PATH);
        assert.equal(getSyncEtag(), '"container-etag"');
    });

    it("handles empty container", async () => {
        mockTransport.addResponse(CONTAINER_URL, {
            status: 200, headers: {},
            body: makeContainerListing([]),
        });

        const diff = await fullSync(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 0);
    });

    it("handles container fetch failure", async () => {
        mockTransport.addResponse(CONTAINER_URL, {
            status: 500, headers: {}, body: "Server Error",
        });

        const diff = await fullSync(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 0);
    });
});

describe("syncFromPod", () => {
    beforeEach(() => { setup(); });

    it("detects new resources", async () => {
        const r1 = `${CONTAINER_URL}link-new.ttl`;

        mockTransport.addResponse(CONTAINER_URL, {
            status: 200,
            headers: { "ETag": '"etag-2"' },
            body: makeContainerListing([r1]),
        });
        mockTransport.addResponse(r1, {
            status: 200, headers: {},
            body: makeLinkTurtle("channel://main", "flux://has_message", "expr://new"),
        });

        const diff = await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.target, "expr://new");
    });

    it("returns empty diff when container unchanged (304)", async () => {
        mockStorage.put("solid:sync:etag", '"etag-unchanged"');

        mockTransport.addResponse(CONTAINER_URL, {
            status: 304, headers: {}, body: "",
        });

        const diff = await syncFromPod(POD_URL, CONTAINER_PATH);
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });
});

describe("getSyncEtag", () => {
    beforeEach(() => { setup(); });

    it("returns null when no etag stored", () => {
        assert.equal(getSyncEtag(), null);
    });

    it("returns stored etag", () => {
        mockStorage.put("solid:sync:etag", '"p1"');
        assert.equal(getSyncEtag(), '"p1"');
    });
});
