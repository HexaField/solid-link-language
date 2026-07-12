/**
 * Channel-B SHACL projection: literal codec, node-expression evaluator,
 * profile parsing from SHACL links, project/ingest round-trip, and the
 * reference Solid RDF adapter.
 *
 * Solid is the near-identity case: a subject-class instance already IS RDF, so
 * the adapter re-expresses it as a clean human-facing RDF resource
 * (`<base> <predicate> value`) rather than translating into a foreign schema.
 * A projection field's `nativeField` is therefore the RDF predicate URI itself.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    encodeLiteral,
    decodeLiteral,
    encodeTyped,
    isLiteral,
} from "../src/projection/literal.js";
import { evalExpression, isNodeExpression, type NodeExpression } from "../src/projection/expression.js";
import { parseProfiles, profileByNativeType } from "../src/projection/profile.js";
import { collectInstances, project, ingest } from "../src/projection/project.js";
import type { AuthoredLink, Link } from "../src/projection/types.js";
import {
    makeSolidAdapter,
    solidResourceBase,
    DC_CREATOR,
    DC_CREATED,
    SOLID_RESOURCE_TYPE,
    type RdfResource,
} from "../src/solid-projection.js";
import type { RdfTriple } from "../src/rdf.js";

// ---------------------------------------------------------------------------
// A realistic SHACL shape: flux://Message → a SIOC Post RDF resource
//
// The native type is a CLASS URI; the content field's native name is the RDF
// PREDICATE the value carries on the subject (Solid's near-identity).
// ---------------------------------------------------------------------------

const SIOC_POST = "http://rdfs.org/sioc/ns#Post";
const SIOC_CONTENT = "http://rdfs.org/sioc/ns#content";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const SHAPE_LINKS: Link[] = [
    { source: "flux://MessageShape", predicate: "rdf://type", target: "sh://NodeShape" },
    { source: "flux://MessageShape", predicate: "sh://targetClass", target: "flux://Message" },
    { source: "flux://MessageShape", predicate: "projection://nativeType", target: `literal:string:${SIOC_POST}` },
    { source: "flux://MessageShape", predicate: "projection://authorField", target: `literal:string:${DC_CREATOR}` },
    { source: "flux://MessageShape", predicate: "projection://timestampField", target: `literal:string:${DC_CREATED}` },
    { source: "flux://MessageShape", predicate: "sh://property", target: "flux://Message.type" },
    { source: "flux://MessageShape", predicate: "sh://property", target: "flux://Message.body" },
    // flag property (the @Flag type marker)
    { source: "flux://Message.type", predicate: "sh://path", target: "ad4m://type" },
    { source: "flux://Message.type", predicate: "sh://hasValue", target: "flux://message" },
    // content property → native RDF predicate sioc:content
    { source: "flux://Message.body", predicate: "sh://path", target: "sioc://content" },
    { source: "flux://Message.body", predicate: "sh://datatype", target: "xsd:string" },
    { source: "flux://Message.body", predicate: "projection://field", target: `literal:string:${SIOC_CONTENT}` },
];

function messageInstance(base: string, body: string): AuthoredLink[] {
    return [
        {
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: base, predicate: "ad4m://type", target: "flux://message" },
        },
        {
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:01.000Z",
            data: { source: base, predicate: "sioc://content", target: encodeLiteral(body) },
        },
    ];
}

// ---------------------------------------------------------------------------
// Literal codec — byte-exact with @coasys/ad4m Literal
// ---------------------------------------------------------------------------

describe("literal codec", () => {
    it("round-trips strings with RFC3986 encoding", () => {
        assert.equal(encodeLiteral("Hello world"), "literal:string:Hello%20world");
        assert.equal(decodeLiteral("literal:string:Hello%20world"), "Hello world");
    });

    it("escapes RFC3986 sub-delims !'()*", () => {
        const encoded = encodeLiteral("a!b'c(d)e*");
        assert.equal(encoded, "literal:string:a%21b%27c%28d%29e%2A");
        assert.equal(decodeLiteral(encoded), "a!b'c(d)e*");
    });

    it("round-trips numbers and booleans", () => {
        assert.equal(encodeLiteral(42), "literal:number:42");
        assert.equal(decodeLiteral("literal:number:42"), 42);
        assert.equal(encodeLiteral(true), "literal:boolean:true");
        assert.equal(decodeLiteral("literal:boolean:true"), true);
        assert.equal(decodeLiteral("literal:boolean:false"), false);
    });

    it("round-trips JSON objects", () => {
        const enc = encodeLiteral({ a: 1, b: [2, 3] });
        assert.ok(enc.startsWith("literal:json:"));
        assert.deepEqual(decodeLiteral(enc), { a: 1, b: [2, 3] });
    });

    it("tolerates the deprecated literal:// form on decode", () => {
        assert.equal(decodeLiteral("literal://string:hi%20there"), "hi there");
    });

    it("passes through non-literal URI references unchanged", () => {
        assert.equal(decodeLiteral("did:key:z6Mk"), "did:key:z6Mk");
        assert.equal(decodeLiteral("flux://message"), "flux://message");
        assert.equal(isLiteral("flux://message"), false);
        assert.equal(isLiteral("literal:string:x"), true);
    });

    it("encodeTyped coerces by xsd datatype", () => {
        assert.equal(encodeTyped("42", "xsd:integer"), "literal:number:42");
        assert.equal(encodeTyped("3.14", "http://www.w3.org/2001/XMLSchema#decimal"), "literal:number:3.14");
        assert.equal(encodeTyped("true", "xsd:boolean"), "literal:boolean:true");
        assert.equal(encodeTyped("hello", "xsd:string"), "literal:string:hello");
        assert.equal(encodeTyped("hello"), "literal:string:hello");
    });
});

// ---------------------------------------------------------------------------
// Node-expression evaluator
// ---------------------------------------------------------------------------

describe("node expression evaluator", () => {
    const lookup = (p: string) => ({ "a://x": "X", "a://y": "" } as Record<string, string>)[p];

    it("focus / literal / path", () => {
        assert.equal(evalExpression({ type: "focus" }, "F", lookup), "F");
        assert.equal(evalExpression({ type: "literal", value: "c" }, undefined, lookup), "c");
        assert.equal(evalExpression({ type: "path", predicate: "a://x" }, undefined, lookup), "X");
    });

    it("exists is true only for present non-empty values", () => {
        assert.equal(evalExpression({ type: "exists", expr: { type: "path", predicate: "a://x" } }, undefined, lookup), true);
        assert.equal(evalExpression({ type: "exists", expr: { type: "path", predicate: "a://y" } }, undefined, lookup), false);
        assert.equal(evalExpression({ type: "exists", expr: { type: "path", predicate: "a://none" } }, undefined, lookup), false);
    });

    it("if / then / else", () => {
        const expr: NodeExpression = {
            type: "if",
            cond: { type: "exists", expr: { type: "path", predicate: "a://x" } },
            then: { type: "literal", value: "YES" },
            else: { type: "literal", value: "NO" },
        };
        assert.equal(evalExpression(expr, undefined, lookup), "YES");
        const exprNo: NodeExpression = { ...expr, cond: { type: "exists", expr: { type: "path", predicate: "a://none" } } };
        assert.equal(evalExpression(exprNo, undefined, lookup), "NO");
    });

    it("concat skips nullish args; coalesce picks first present", () => {
        const cat: NodeExpression = {
            type: "concat",
            args: [
                { type: "literal", value: "data:" },
                { type: "path", predicate: "a://x" },
                { type: "path", predicate: "a://none" },
            ],
        };
        assert.equal(evalExpression(cat, undefined, lookup), "data:X");
        const co: NodeExpression = {
            type: "coalesce",
            args: [
                { type: "path", predicate: "a://none" },
                { type: "path", predicate: "a://y" },
                { type: "literal", value: "fallback" },
            ],
        };
        assert.equal(evalExpression(co, undefined, lookup), "fallback");
    });

    it("isNodeExpression guards malformed input", () => {
        assert.equal(isNodeExpression({ type: "focus" }), true);
        assert.equal(isNodeExpression({ type: "bogus" }), false);
        assert.equal(isNodeExpression("nope"), false);
    });
});

// ---------------------------------------------------------------------------
// Profile parsing
// ---------------------------------------------------------------------------

describe("parseProfiles", () => {
    it("extracts a projectable profile with fields and flags", () => {
        const profiles = parseProfiles(SHAPE_LINKS);
        assert.equal(profiles.length, 1);
        const p = profiles[0];
        assert.equal(p.nodeShapeUri, "flux://MessageShape");
        assert.equal(p.targetClass, "flux://Message");
        assert.equal(p.nativeType, SIOC_POST);
        assert.equal(p.authorField, DC_CREATOR);
        assert.equal(p.timestampField, DC_CREATED);
        assert.equal(p.fields.length, 1);
        assert.deepEqual(p.fields[0], {
            nativeField: SIOC_CONTENT,
            path: "sioc://content",
            datatype: "xsd:string",
            expression: undefined,
        });
        assert.equal(p.flags.length, 1);
        assert.deepEqual(p.flags[0], { path: "ad4m://type", value: "flux://message" });
    });

    it("ignores shapes without projection://nativeType", () => {
        const nonProjectable: Link[] = [
            { source: "x://Shape", predicate: "rdf://type", target: "sh://NodeShape" },
            { source: "x://Shape", predicate: "sh://targetClass", target: "x://Class" },
        ];
        assert.equal(parseProfiles(nonProjectable).length, 0);
    });

    it("parses a projection://expression annotation", () => {
        const withExpr: Link[] = [
            ...SHAPE_LINKS,
            {
                source: "flux://Message.body",
                predicate: "projection://expression",
                target: encodeLiteral({ type: "focus" }),
            },
        ];
        const p = parseProfiles(withExpr)[0];
        assert.deepEqual(p.fields[0].expression, { type: "focus" });
    });

    it("indexes profiles by native type", () => {
        const map = profileByNativeType(parseProfiles(SHAPE_LINKS));
        assert.ok(map.has(SIOC_POST));
    });
});

// ---------------------------------------------------------------------------
// collectInstances + project
// ---------------------------------------------------------------------------

describe("collectInstances + project", () => {
    const profile = parseProfiles(SHAPE_LINKS)[0];

    it("collects only instances whose flags match", () => {
        const links: AuthoredLink[] = [
            ...messageInstance("flux://msg1", "Hello world"),
            // a base without the type flag — not an instance
            {
                author: "did:key:bob",
                timestamp: "2026-07-12T11:00:00.000Z",
                data: { source: "flux://other", predicate: "sioc://content", target: encodeLiteral("orphan") },
            },
        ];
        const instances = collectInstances(links, profile);
        assert.equal(instances.length, 1);
        assert.equal(instances[0].base, "flux://msg1");
        assert.equal(instances[0].author, "did:key:alice");
        assert.equal(instances[0].timestamp, "2026-07-12T10:00:00.000Z"); // earliest
    });

    it("projects an instance to generic native content without flags", () => {
        const instance = collectInstances(messageInstance("flux://msg1", "Hello world"), profile)[0];
        const projection = project(instance, profile);
        assert.equal(projection.nativeType, SIOC_POST);
        assert.equal(projection.base, "flux://msg1");
        assert.equal(projection.author, "did:key:alice");
        assert.deepEqual(projection.fields, { [SIOC_CONTENT]: "Hello world" });
        // flag path must NOT leak into content
        assert.equal("ad4m://type" in projection.fields, false);
    });

    it("applies an outbound expression when present", () => {
        const exprLinks: Link[] = [
            ...SHAPE_LINKS,
            {
                source: "flux://Message.body",
                predicate: "projection://expression",
                target: encodeLiteral({
                    type: "concat",
                    args: [
                        { type: "literal", value: "[msg] " },
                        { type: "focus" },
                    ],
                }),
            },
        ];
        const p = parseProfiles(exprLinks)[0];
        const instance = collectInstances(messageInstance("flux://msg2", "hi"), p)[0];
        assert.equal(project(instance, p).fields[SIOC_CONTENT], "[msg] hi");
    });
});

// ---------------------------------------------------------------------------
// ingest + full round-trip
// ---------------------------------------------------------------------------

describe("ingest", () => {
    const profile = parseProfiles(SHAPE_LINKS)[0];

    it("emits flag links and encoded content-field links", () => {
        const links = ingest(
            { nativeType: SIOC_POST, base: "https://pod.example/views/view-x", fields: { [SIOC_CONTENT]: "hi from solidos" } },
            profile,
        );
        assert.deepEqual(links, [
            { source: "https://pod.example/views/view-x", predicate: "ad4m://type", target: "flux://message" },
            { source: "https://pod.example/views/view-x", predicate: "sioc://content", target: "literal:string:hi%20from%20solidos" },
        ]);
    });

    it("round-trips links → project → ingest reproducing content + flag links", () => {
        const instance = collectInstances(messageInstance("flux://msg1", "Hello world"), profile)[0];
        const projection = project(instance, profile);
        const rebuilt = ingest(projection, profile, instance.base);
        // original content link + flag link, order-independent
        const originalTriples = new Set([
            "flux://msg1|ad4m://type|flux://message",
            `flux://msg1|sioc://content|${encodeLiteral("Hello world")}`,
        ]);
        const rebuiltTriples = new Set(rebuilt.map((l) => `${l.source}|${l.predicate}|${l.target}`));
        assert.deepEqual(rebuiltTriples, originalTriples);
    });
});

// ---------------------------------------------------------------------------
// Solid RDF adapter — the reference NativeAdapter
// ---------------------------------------------------------------------------

describe("solid adapter", () => {
    const adapter = makeSolidAdapter(SIOC_POST);
    const profile = parseProfiles(SHAPE_LINKS)[0];

    function tripleOf(res: RdfResource, predicate: string): RdfTriple | undefined {
        return res.triples.find((t) => t.subject === res.subject && t.predicate === predicate);
    }

    it("toNative emits a clean RDF resource with NO ad4m reification", () => {
        const instance = collectInstances(messageInstance("flux://msg1", "Hello world"), profile)[0];
        const res = adapter.toNative(project(instance, profile));
        assert.equal(res.subject, "flux://msg1");

        // rdf:type carries the class; content is a direct predicate/object.
        const typeT = tripleOf(res, RDF_TYPE);
        assert.ok(typeT);
        assert.equal(typeT!.object, SIOC_POST);
        assert.equal(typeT!.objectIsLiteral, false);

        const contentT = tripleOf(res, SIOC_CONTENT);
        assert.ok(contentT);
        assert.equal(contentT!.object, "Hello world");
        assert.equal(contentT!.objectIsLiteral, true);

        // dcterms:creator provenance is present as a URI object.
        const creatorT = tripleOf(res, DC_CREATOR);
        assert.ok(creatorT);
        assert.equal(creatorT!.object, "did:key:alice");

        // No ad4m: reification predicates leak into the human-facing resource.
        assert.equal(
            res.triples.some((t) => t.predicate.startsWith("https://ad4m.dev/ontology#linkHash")),
            false,
        );
        assert.equal(
            res.triples.some((t) => t.predicate === "https://ad4m.dev/ontology#addition"),
            false,
        );
    });

    it("writes numeric and boolean fields as typed literals; URI values as URI objects", () => {
        const res = adapter.toNative({
            nativeType: SIOC_POST,
            base: "flux://m",
            fields: {
                [SIOC_CONTENT]: "hi",
                "ex://count": 3,
                "ex://flagged": true,
                "ex://about": "https://example.org/thing",
            },
        });
        assert.equal(tripleOf(res, "ex://count")!.objectDatatype, "http://www.w3.org/2001/XMLSchema#integer");
        assert.equal(tripleOf(res, "ex://flagged")!.objectDatatype, "http://www.w3.org/2001/XMLSchema#boolean");
        const about = tripleOf(res, "ex://about")!;
        assert.equal(about.objectIsLiteral, false); // a URI reference, not a literal
        assert.equal(about.object, "https://example.org/thing");
    });

    it("throws if the projection lacks a base URI", () => {
        assert.throws(() => adapter.toNative({ nativeType: SIOC_POST, base: "", fields: { [SIOC_CONTENT]: "x" } }));
    });

    it("fromNative parses a native RDF resource into a projection", () => {
        const subject = "https://pod.example/views/view-e1";
        const resource: RdfResource = {
            subject,
            triples: [
                { subject, predicate: RDF_TYPE, object: SIOC_POST, objectIsLiteral: false },
                { subject, predicate: SIOC_CONTENT, object: "hi from solidos", objectIsLiteral: true },
                { subject, predicate: DC_CREATOR, object: "did:key:bob", objectIsLiteral: false },
                { subject, predicate: DC_CREATED, object: "2026-07-12T12:00:00.000Z", objectIsLiteral: true, objectDatatype: "http://www.w3.org/2001/XMLSchema#dateTime" },
            ],
        };
        const p = adapter.fromNative(resource);
        assert.ok(p);
        assert.equal(p!.base, solidResourceBase(subject));
        assert.equal(p!.author, "did:key:bob");
        assert.equal(p!.timestamp, "2026-07-12T12:00:00.000Z");
        assert.deepEqual(p!.fields, { [SIOC_CONTENT]: "hi from solidos" });
    });

    it("fromNative rejects resources of a different class and content-less resources", () => {
        const subject = "https://pod.example/views/view-x";
        // wrong class
        assert.equal(
            adapter.fromNative({
                subject,
                triples: [{ subject, predicate: RDF_TYPE, object: "ex://Other", objectIsLiteral: false }],
            }),
            null,
        );
        // right class but no projected fields
        assert.equal(
            adapter.fromNative({
                subject,
                triples: [
                    { subject, predicate: RDF_TYPE, object: SIOC_POST, objectIsLiteral: false },
                    { subject, predicate: DC_CREATOR, object: "did:key:x", objectIsLiteral: false },
                ],
            }),
            null,
        );
        // no subject
        assert.equal(adapter.fromNative({ subject: "", triples: [] }), null);
    });

    it("full native→AD4M ingest yields a typed instance", () => {
        const subject = "https://pod.example/views/view-e2";
        const resource: RdfResource = {
            subject,
            triples: [
                { subject, predicate: RDF_TYPE, object: SIOC_POST, objectIsLiteral: false },
                { subject, predicate: SIOC_CONTENT, object: "native hello", objectIsLiteral: true },
            ],
        };
        const projection = adapter.fromNative(resource)!;
        const links = ingest(projection, profile);
        assert.deepEqual(links, [
            { source: subject, predicate: "ad4m://type", target: "flux://message" },
            { source: subject, predicate: "sioc://content", target: "literal:string:native%20hello" },
        ]);
    });

    it("defaults to a generic subject class when none is supplied", () => {
        const generic = makeSolidAdapter();
        const res = generic.toNative({ nativeType: SOLID_RESOURCE_TYPE, base: "flux://g", fields: { "ex://p": "v" } });
        assert.equal(tripleOf(res, RDF_TYPE)!.object, SOLID_RESOURCE_TYPE);
    });
});
