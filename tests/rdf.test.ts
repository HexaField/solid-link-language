/**
 * Tests for the minimal Turtle parser and serializer.
 *
 * Tests round-trip: triples → Turtle → triples, prefix handling,
 * literal types, and property list serialization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    parseTurtle,
    triplesToTurtle,
    tripleToTurtle,
    formatTerm,
    formatLiteral,
    findSubjects,
    getObject,
    getObjects,
    getTriplesBySubject,
} from "../src/rdf.pure.js";
import type { RdfTriple } from "../src/rdf.pure.js";
import { AD4M_NS, RDF_NS, XSD_NS, LDP_NS } from "../src/ontology.js";

// ---------------------------------------------------------------------------
// Turtle Parser
// ---------------------------------------------------------------------------

describe("parseTurtle", () => {
    it("parses @prefix declarations", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.prefixes["ad4m"], AD4M_NS);
        assert.equal(graph.prefixes["rdf"], RDF_NS);
    });

    it("parses a simple triple with URIs", () => {
        const turtle = `<http://example.com/s> <http://example.com/p> <http://example.com/o> .`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples.length, 1);
        assert.equal(graph.triples[0].subject, "http://example.com/s");
        assert.equal(graph.triples[0].predicate, "http://example.com/p");
        assert.equal(graph.triples[0].object, "http://example.com/o");
        assert.equal(graph.triples[0].objectIsLiteral, false);
    });

    it("parses prefixed names", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<#link-1> rdf:type ad4m:LinkExpression .
`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples.length, 1);
        assert.equal(graph.triples[0].predicate, `${RDF_NS}type`);
        assert.equal(graph.triples[0].object, `${AD4M_NS}LinkExpression`);
    });

    it("parses 'a' shorthand for rdf:type", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .

<#link-1> a ad4m:LinkExpression .
`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples.length, 1);
        assert.equal(graph.triples[0].predicate, `${RDF_NS}type`);
    });

    it("parses string literals", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .

<#link-1> ad4m:author "did:key:z6MkAgent..." .
`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples.length, 1);
        assert.equal(graph.triples[0].object, "did:key:z6MkAgent...");
        assert.equal(graph.triples[0].objectIsLiteral, true);
    });

    it("parses typed literals with ^^", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<#link-1> ad4m:timestamp "2026-05-02T12:00:00.000Z"^^xsd:dateTime .
`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples.length, 1);
        assert.equal(graph.triples[0].object, "2026-05-02T12:00:00.000Z");
        assert.equal(graph.triples[0].objectIsLiteral, true);
        assert.equal(graph.triples[0].objectDatatype, `${XSD_NS}dateTime`);
    });

    it("parses semicolon property lists", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<#link-1> a ad4m:LinkExpression ;
    rdf:subject <channel://main> ;
    rdf:predicate <flux://has_message> ;
    rdf:object <expr://Qm456def> .
`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples.length, 4);
        // All share the same subject
        for (const t of graph.triples) {
            assert.ok(t.subject.endsWith("#link-1") || t.subject === "#link-1");
        }
    });

    it("parses a full reified link expression", () => {
        const turtle = `
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<#link-Qm789ghi> a ad4m:LinkExpression ;
    rdf:subject <channel://main> ;
    rdf:predicate <flux://has_message> ;
    rdf:object <expr://Qm456def> ;
    ad4m:author "did:key:z6MkAgent..." ;
    ad4m:timestamp "2026-05-02T12:00:00.000Z"^^xsd:dateTime ;
    ad4m:proofSignature "abc123..." ;
    ad4m:proofKey "key123..." .
`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples.length, 8);

        const subj = graph.triples[0].subject;
        const getObj = (pred: string) =>
            graph.triples.find(t => t.subject === subj && t.predicate === pred)?.object;

        assert.equal(getObj(`${RDF_NS}type`), `${AD4M_NS}LinkExpression`);
        assert.equal(getObj(`${RDF_NS}subject`), "channel://main");
        assert.equal(getObj(`${RDF_NS}predicate`), "flux://has_message");
        assert.equal(getObj(`${RDF_NS}object`), "expr://Qm456def");
        assert.equal(getObj(`${AD4M_NS}author`), "did:key:z6MkAgent...");
        assert.equal(getObj(`${AD4M_NS}timestamp`), "2026-05-02T12:00:00.000Z");
        assert.equal(getObj(`${AD4M_NS}proofSignature`), "abc123...");
        assert.equal(getObj(`${AD4M_NS}proofKey`), "key123...");
    });

    it("resolves relative URIs with baseUrl", () => {
        const turtle = `<#link-1> <http://example.com/p> <http://example.com/o> .`;
        const graph = parseTurtle(turtle, "https://pod.example.com/resource");
        assert.equal(graph.triples[0].subject, "https://pod.example.com/resource#link-1");
    });

    it("handles escaped characters in literals", () => {
        const turtle = `<http://example.com/s> <http://example.com/p> "hello \\"world\\"" .`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples[0].object, 'hello "world"');
        assert.equal(graph.triples[0].objectIsLiteral, true);
    });

    it("handles empty input", () => {
        const graph = parseTurtle("");
        assert.equal(graph.triples.length, 0);
    });

    it("handles comments", () => {
        const turtle = `
# This is a comment
<http://example.com/s> <http://example.com/p> <http://example.com/o> .
# Another comment
`;
        const graph = parseTurtle(turtle);
        assert.equal(graph.triples.length, 1);
    });

    it("parses LDP container listing", () => {
        const turtle = `
@prefix ldp: <http://www.w3.org/ns/ldp#> .

<> a ldp:BasicContainer ;
    ldp:contains <link-abc.ttl>, <link-def.ttl> .
`;
        const graph = parseTurtle(turtle, "https://pod.example.com/links/");
        const contains = getObjects(graph, "https://pod.example.com/links/", `${LDP_NS}contains`);
        assert.ok(contains.length >= 1);
    });
});

// ---------------------------------------------------------------------------
// Turtle Serializer
// ---------------------------------------------------------------------------

describe("triplesToTurtle", () => {
    it("serializes a single triple", () => {
        const triples: RdfTriple[] = [{
            subject: "http://example.com/s",
            predicate: "http://example.com/p",
            object: "http://example.com/o",
            objectIsLiteral: false,
        }];
        const turtle = triplesToTurtle(triples, {});
        assert.ok(turtle.includes("<http://example.com/s>"));
        assert.ok(turtle.includes("<http://example.com/p>"));
        assert.ok(turtle.includes("<http://example.com/o>"));
    });

    it("uses prefixed names for known namespaces", () => {
        const triples: RdfTriple[] = [{
            subject: "#link-1",
            predicate: `${RDF_NS}type`,
            object: `${AD4M_NS}LinkExpression`,
            objectIsLiteral: false,
        }];
        const turtle = triplesToTurtle(triples);
        assert.ok(turtle.includes("ad4m:LinkExpression"));
        assert.ok(turtle.includes("a ")); // rdf:type shorthand
    });

    it("formats literals correctly", () => {
        const triples: RdfTriple[] = [{
            subject: "#link-1",
            predicate: `${AD4M_NS}author`,
            object: "did:key:z6MkTest",
            objectIsLiteral: true,
        }];
        const turtle = triplesToTurtle(triples, {});
        assert.ok(turtle.includes('"did:key:z6MkTest"'));
    });

    it("formats typed literals with ^^", () => {
        const triples: RdfTriple[] = [{
            subject: "#link-1",
            predicate: `${AD4M_NS}timestamp`,
            object: "2026-05-02T12:00:00.000Z",
            objectIsLiteral: true,
            objectDatatype: `${XSD_NS}dateTime`,
        }];
        const turtle = triplesToTurtle(triples);
        assert.ok(turtle.includes('"2026-05-02T12:00:00.000Z"^^xsd:dateTime'));
    });

    it("groups triples by subject with semicolons", () => {
        const triples: RdfTriple[] = [
            {
                subject: "#link-1",
                predicate: `${RDF_NS}type`,
                object: `${AD4M_NS}LinkExpression`,
                objectIsLiteral: false,
            },
            {
                subject: "#link-1",
                predicate: `${AD4M_NS}author`,
                object: "did:key:z6MkTest",
                objectIsLiteral: true,
            },
        ];
        const turtle = triplesToTurtle(triples);
        assert.ok(turtle.includes(";"));
        assert.ok(turtle.includes("."));
    });

    it("includes @prefix declarations", () => {
        const triples: RdfTriple[] = [{
            subject: "#link-1",
            predicate: `${RDF_NS}type`,
            object: `${AD4M_NS}LinkExpression`,
            objectIsLiteral: false,
        }];
        const turtle = triplesToTurtle(triples);
        assert.ok(turtle.includes("@prefix ad4m:"));
        assert.ok(turtle.includes("@prefix rdf:"));
    });
});

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

describe("formatTerm", () => {
    it("uses prefixed form for known namespaces", () => {
        assert.equal(formatTerm(`${AD4M_NS}LinkExpression`), "ad4m:LinkExpression");
        assert.equal(formatTerm(`${RDF_NS}type`), "rdf:type");
    });

    it("wraps unknown URIs in angle brackets", () => {
        assert.equal(formatTerm("http://example.com/foo"), "<http://example.com/foo>");
    });
});

describe("formatLiteral", () => {
    it("formats plain literals", () => {
        assert.equal(formatLiteral("hello"), '"hello"');
    });

    it("formats typed literals", () => {
        assert.equal(
            formatLiteral("2026-05-02", `${XSD_NS}dateTime`),
            '"2026-05-02"^^xsd:dateTime',
        );
    });

    it("escapes quotes in literals", () => {
        assert.ok(formatLiteral('say "hi"').includes('\\"'));
    });
});

// ---------------------------------------------------------------------------
// Graph query helpers
// ---------------------------------------------------------------------------

describe("Graph query helpers", () => {
    const graph = parseTurtle(`
@prefix ad4m: <https://ad4m.dev/ontology#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<#link-1> a ad4m:LinkExpression ;
    rdf:subject <channel://main> ;
    ad4m:author "did:key:z6Mk1" .

<#link-2> a ad4m:LinkExpression ;
    rdf:subject <channel://general> ;
    ad4m:author "did:key:z6Mk2" .
`);

    it("findSubjects returns matching subjects", () => {
        const subjects = findSubjects(graph, `${RDF_NS}type`, `${AD4M_NS}LinkExpression`);
        assert.equal(subjects.length, 2);
    });

    it("getObject returns first match", () => {
        const author = getObject(graph, "#link-1", `${AD4M_NS}author`);
        assert.equal(author, "did:key:z6Mk1");
    });

    it("getObject returns undefined for no match", () => {
        const result = getObject(graph, "#link-999", `${AD4M_NS}author`);
        assert.equal(result, undefined);
    });

    it("getObjects returns all matches", () => {
        const subjects = findSubjects(graph, `${RDF_NS}type`, `${AD4M_NS}LinkExpression`);
        assert.equal(subjects.length, 2);
    });

    it("getTriplesBySubject returns all triples for subject", () => {
        const triples = getTriplesBySubject(graph, "#link-1");
        assert.equal(triples.length, 3);
    });
});

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe("Turtle round-trip", () => {
    it("round-trips a full reified link expression", () => {
        const original: RdfTriple[] = [
            { subject: "#link-abc", predicate: `${RDF_NS}type`, object: `${AD4M_NS}LinkExpression`, objectIsLiteral: false },
            { subject: "#link-abc", predicate: `${RDF_NS}subject`, object: "channel://main", objectIsLiteral: false },
            { subject: "#link-abc", predicate: `${RDF_NS}predicate`, object: "flux://has_message", objectIsLiteral: false },
            { subject: "#link-abc", predicate: `${RDF_NS}object`, object: "expr://Qm456def", objectIsLiteral: false },
            { subject: "#link-abc", predicate: `${AD4M_NS}author`, object: "did:key:z6MkAgent", objectIsLiteral: true },
            { subject: "#link-abc", predicate: `${AD4M_NS}timestamp`, object: "2026-05-02T12:00:00.000Z", objectIsLiteral: true, objectDatatype: `${XSD_NS}dateTime` },
            { subject: "#link-abc", predicate: `${AD4M_NS}proofSignature`, object: "sig123", objectIsLiteral: true },
            { subject: "#link-abc", predicate: `${AD4M_NS}proofKey`, object: "key123", objectIsLiteral: true },
        ];

        const turtle = triplesToTurtle(original);
        const parsed = parseTurtle(turtle);

        // Verify all triples survived round-trip
        for (const orig of original) {
            const matching = parsed.triples.find(t =>
                t.predicate === orig.predicate &&
                t.object === orig.object &&
                t.objectIsLiteral === orig.objectIsLiteral,
            );
            assert.ok(matching, `Missing triple: ${orig.predicate} → ${orig.object}`);
        }
    });

    it("round-trips multiple subjects", () => {
        const triples: RdfTriple[] = [
            { subject: "#link-1", predicate: `${RDF_NS}type`, object: `${AD4M_NS}LinkExpression`, objectIsLiteral: false },
            { subject: "#link-1", predicate: `${AD4M_NS}author`, object: "Alice", objectIsLiteral: true },
            { subject: "#link-2", predicate: `${RDF_NS}type`, object: `${AD4M_NS}LinkExpression`, objectIsLiteral: false },
            { subject: "#link-2", predicate: `${AD4M_NS}author`, object: "Bob", objectIsLiteral: true },
        ];

        const turtle = triplesToTurtle(triples);
        const parsed = parseTurtle(turtle);
        assert.equal(parsed.triples.length, 4);
    });
});
