/**
 * Tests for Link ↔ RDF triple translation (pure functions).
 *
 * Covers linkToReifiedTriples, graphToLinks, linkToRawTriple,
 * and full round-trip: link → triples → Turtle → parse → link.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    linkToReifiedTriples,
    linkToRawTriple,
    graphToLinks,
    linkContentKey,
} from "../src/translate.js";
import { triplesToTurtle, parseTurtle } from "../src/rdf.js";
import type { LinkExpression } from "../src/types.js";
import { AD4M_NS, RDF_NS, XSD_NS, DEFAULT_PREFIXES } from "../src/ontology.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLink(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T12:00:00.000Z",
        data: {
            source: "channel://main",
            target: "expr://Qm456def",
            predicate: "flux://has_message",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// linkToReifiedTriples
// ---------------------------------------------------------------------------

describe("linkToReifiedTriples", () => {
    it("produces correct number of triples with full proof", () => {
        const link = makeLink();
        const triples = linkToReifiedTriples(link, "link-Qm789");
        // type + subject + predicate + object + author + timestamp + signature + key = 8
        assert.equal(triples.length, 8);
    });

    it("includes rdf:type ad4m:LinkExpression", () => {
        const link = makeLink();
        const triples = linkToReifiedTriples(link, "link-1");
        const typeTriple = triples.find(t => t.predicate === `${RDF_NS}type`);
        assert.ok(typeTriple);
        assert.equal(typeTriple!.object, `${AD4M_NS}LinkExpression`);
    });

    it("includes rdf:subject, rdf:predicate, rdf:object", () => {
        const link = makeLink();
        const triples = linkToReifiedTriples(link, "link-1");

        const subj = triples.find(t => t.predicate === `${RDF_NS}subject`);
        assert.ok(subj);
        assert.equal(subj!.object, "channel://main");

        const pred = triples.find(t => t.predicate === `${RDF_NS}predicate`);
        assert.ok(pred);
        assert.equal(pred!.object, "flux://has_message");

        const obj = triples.find(t => t.predicate === `${RDF_NS}object`);
        assert.ok(obj);
        assert.equal(obj!.object, "expr://Qm456def");
    });

    it("includes author as literal", () => {
        const link = makeLink();
        const triples = linkToReifiedTriples(link, "link-1");
        const author = triples.find(t => t.predicate === `${AD4M_NS}author`);
        assert.ok(author);
        assert.equal(author!.object, "did:key:z6MkTest");
        assert.equal(author!.objectIsLiteral, true);
    });

    it("includes typed timestamp", () => {
        const link = makeLink();
        const triples = linkToReifiedTriples(link, "link-1");
        const ts = triples.find(t => t.predicate === `${AD4M_NS}timestamp`);
        assert.ok(ts);
        assert.equal(ts!.objectDatatype, `${XSD_NS}dateTime`);
    });

    it("includes proof signature and key", () => {
        const link = makeLink();
        const triples = linkToReifiedTriples(link, "link-1");
        const sig = triples.find(t => t.predicate === `${AD4M_NS}proofSignature`);
        assert.ok(sig);
        assert.equal(sig!.object, "abc123");
        const key = triples.find(t => t.predicate === `${AD4M_NS}proofKey`);
        assert.ok(key);
        assert.equal(key!.object, "key123");
    });

    it("omits proof fields when empty", () => {
        const link = makeLink({
            proof: { signature: "", key: "" },
        });
        const triples = linkToReifiedTriples(link, "link-1");
        const sig = triples.find(t => t.predicate === `${AD4M_NS}proofSignature`);
        assert.equal(sig, undefined);
        const key = triples.find(t => t.predicate === `${AD4M_NS}proofKey`);
        assert.equal(key, undefined);
    });

    it("uses the provided linkId as subject fragment", () => {
        const triples = linkToReifiedTriples(makeLink(), "link-abc123");
        assert.equal(triples[0].subject, "#link-abc123");
    });
});

// ---------------------------------------------------------------------------
// linkToRawTriple
// ---------------------------------------------------------------------------

describe("linkToRawTriple", () => {
    it("produces a single non-reified triple", () => {
        const link = makeLink();
        const triple = linkToRawTriple(link);
        assert.equal(triple.subject, "channel://main");
        assert.equal(triple.predicate, "flux://has_message");
        assert.equal(triple.object, "expr://Qm456def");
        assert.equal(triple.objectIsLiteral, false);
    });
});

// ---------------------------------------------------------------------------
// graphToLinks
// ---------------------------------------------------------------------------

describe("graphToLinks", () => {
    it("extracts links from a parsed graph", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<#link-1> a ad4m:LinkExpression ;
    rdf:subject <channel://main> ;
    rdf:predicate <flux://has_message> ;
    rdf:object <expr://Qm456def> ;
    ad4m:author "did:key:z6MkAgent" ;
    ad4m:timestamp "2026-05-02T12:00:00.000Z"^^xsd:dateTime ;
    ad4m:proofSignature "sig123" ;
    ad4m:proofKey "key123" .
`;
        const graph = parseTurtle(turtle);
        const links = graphToLinks(graph);
        assert.equal(links.length, 1);
        assert.equal(links[0].data.source, "channel://main");
        assert.equal(links[0].data.predicate, "flux://has_message");
        assert.equal(links[0].data.target, "expr://Qm456def");
        assert.equal(links[0].author, "did:key:z6MkAgent");
        assert.equal(links[0].timestamp, "2026-05-02T12:00:00.000Z");
        assert.equal(links[0].proof.signature, "sig123");
        assert.equal(links[0].proof.key, "key123");
    });

    it("extracts multiple links from a graph", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<#link-1> a ad4m:LinkExpression ;
    rdf:subject <a://1> ;
    rdf:predicate <p://1> ;
    rdf:object <o://1> .

<#link-2> a ad4m:LinkExpression ;
    rdf:subject <a://2> ;
    rdf:predicate <p://2> ;
    rdf:object <o://2> .
`;
        const graph = parseTurtle(turtle);
        const links = graphToLinks(graph);
        assert.equal(links.length, 2);
    });

    it("provides defaults for missing author/timestamp", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<#link-1> a ad4m:LinkExpression ;
    rdf:subject <a://1> ;
    rdf:predicate <p://1> ;
    rdf:object <o://1> .
`;
        const graph = parseTurtle(turtle);
        const links = graphToLinks(graph, "https://pod.example.com");
        assert.equal(links.length, 1);
        assert.equal(links[0].author, "solid:https://pod.example.com");
        assert.ok(links[0].timestamp); // should have a default timestamp
    });

    it("skips non-LinkExpression subjects", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ldp: <http://www.w3.org/ns/ldp#> .

<> a ldp:BasicContainer .

<#link-1> a ad4m:LinkExpression ;
    rdf:subject <a://1> ;
    rdf:predicate <p://1> ;
    rdf:object <o://1> .
`;
        const graph = parseTurtle(turtle);
        const links = graphToLinks(graph);
        assert.equal(links.length, 1);
    });
});

// ---------------------------------------------------------------------------
// linkContentKey
// ---------------------------------------------------------------------------

describe("linkContentKey", () => {
    it("produces deterministic key", () => {
        const link = makeLink();
        assert.equal(linkContentKey(link), linkContentKey(link));
    });

    it("different links produce different keys", () => {
        const link1 = makeLink();
        const link2 = makeLink({ data: { source: "other://1", target: "other://2", predicate: "other://3" } });
        assert.notEqual(linkContentKey(link1), linkContentKey(link2));
    });
});

// ---------------------------------------------------------------------------
// Full round-trip: link → triples → Turtle → parse → link
// ---------------------------------------------------------------------------

describe("Full round-trip: link → Turtle → link", () => {
    it("lossless round-trip for a standard link", () => {
        const original = makeLink();
        const triples = linkToReifiedTriples(original, "link-test");
        const turtle = triplesToTurtle(triples);
        const graph = parseTurtle(turtle);
        const recovered = graphToLinks(graph);

        assert.equal(recovered.length, 1);
        const link = recovered[0];
        assert.equal(link.data.source, original.data.source);
        assert.equal(link.data.predicate, original.data.predicate);
        assert.equal(link.data.target, original.data.target);
        assert.equal(link.author, original.author);
        assert.equal(link.timestamp, original.timestamp);
        assert.equal(link.proof.signature, original.proof.signature);
        assert.equal(link.proof.key, original.proof.key);
    });

    it("lossless round-trip for link with special characters in URIs", () => {
        const original = makeLink({
            data: {
                source: "literal://hello%20world",
                target: "expr://Qm+special/chars",
                predicate: "custom://pred#test",
            },
        });
        const triples = linkToReifiedTriples(original, "link-special");
        const turtle = triplesToTurtle(triples);
        const graph = parseTurtle(turtle);
        const recovered = graphToLinks(graph);

        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].data.source, original.data.source);
        assert.equal(recovered[0].data.target, original.data.target);
        assert.equal(recovered[0].data.predicate, original.data.predicate);
    });

    it("round-trips multiple links in a batch", () => {
        const links = [
            makeLink(),
            makeLink({
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
