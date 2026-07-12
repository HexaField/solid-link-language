/**
 * Channel-B bridge orchestration — the protocol-agnostic glue every link
 * language copies verbatim: `toAuthoredLink`, `projectInstances` (AD4M graph →
 * native payloads), `ingestNative` (native payload → authoritative links), and
 * a default message profile. Exercised over the reference Solid RDF adapter.
 *
 * For Solid the native payload is an RDF resource and a field's `nativeField` is
 * the RDF predicate the value carries — the near-identity projection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    toAuthoredLink,
    projectInstances,
    ingestNative,
    encodeLiteral,
    type AuthoredLink,
    type NativeAdapter,
    type ProjectionProfile,
} from "../src/projection/index.js";
import {
    makeSolidAdapter,
    solidResourceBase,
    DC_CREATOR,
    type RdfResource,
} from "../src/solid-projection.js";
import type { RdfTriple } from "../src/rdf.js";

// SIOC vocabulary — the Solid-native shape a Flux message projects into.
const SIOC_POST = "http://rdfs.org/sioc/ns#Post";
const SIOC_CONTENT = "http://rdfs.org/sioc/ns#content";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// The Solid adapter, keyed by the native (class) type a profile asks for.
const adapterFor = (nativeType: string): NativeAdapter<RdfResource> => makeSolidAdapter(nativeType);

/**
 * The default Solid message profile (mirrors `defaultSolidMessageProfile` in
 * index.ts): `base --flux://entry_type--> flux://has_message` (flag) +
 * `base --flux://body--> literal:string:<text>` (content), content projecting
 * onto the RDF predicate `sioc://content`.
 */
function solidMessageProfile(
    nativeType: string = SIOC_POST,
    contentPredicate: string = SIOC_CONTENT,
): ProjectionProfile {
    return {
        nodeShapeUri: "flux://MessageShape",
        targetClass: "flux://Message",
        nativeType,
        flags: [{ path: "flux://entry_type", value: "flux://has_message" }],
        fields: [
            {
                nativeField: contentPredicate,
                path: "flux://body",
                datatype: "http://www.w3.org/2001/XMLSchema#string",
            },
        ],
    };
}

const fluxProfile = solidMessageProfile();

function fluxMessage(base: string, text: string, author = "did:key:alice"): AuthoredLink[] {
    return [
        {
            author,
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: base, predicate: "flux://entry_type", target: "flux://has_message" },
        },
        {
            author,
            timestamp: "2026-07-12T10:00:01.000Z",
            data: { source: base, predicate: "flux://body", target: encodeLiteral(text) },
        },
    ];
}

function tripleOf(res: RdfResource, predicate: string): RdfTriple | undefined {
    return res.triples.find((t) => t.subject === res.subject && t.predicate === predicate);
}

// ---------------------------------------------------------------------------
// toAuthoredLink
// ---------------------------------------------------------------------------

describe("toAuthoredLink", () => {
    it("maps a full LinkExpression to an AuthoredLink", () => {
        const authored = toAuthoredLink({
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: "a://s", predicate: "a://p", target: "a://t" },
        });
        assert.deepEqual(authored, {
            author: "did:key:alice",
            timestamp: "2026-07-12T10:00:00.000Z",
            data: { source: "a://s", predicate: "a://p", target: "a://t" },
        });
    });

    it("defaults missing triple parts to empty strings and preserves absent envelope", () => {
        const authored = toAuthoredLink({ data: {} });
        assert.equal(authored.author, undefined);
        assert.equal(authored.timestamp, undefined);
        assert.deepEqual(authored.data, { source: "", predicate: "", target: "" });
    });
});

// ---------------------------------------------------------------------------
// projectInstances — AD4M graph → native RDF resources
// ---------------------------------------------------------------------------

describe("projectInstances", () => {
    it("folds a matched instance into a native RDF resource with envelope metadata", () => {
        const projected = projectInstances<RdfResource>(fluxMessage("flux://msg1", "Hello world"), [fluxProfile], adapterFor);
        assert.equal(projected.length, 1);
        const [p] = projected;
        assert.equal(p.base, "flux://msg1");
        assert.equal(p.author, "did:key:alice");
        assert.equal(p.timestamp, "2026-07-12T10:00:00.000Z"); // earliest constituent link
        assert.equal(p.native.subject, "flux://msg1");

        // The content rides a direct sioc:content triple; the class is rdf:type.
        assert.equal(tripleOf(p.native, RDF_TYPE)!.object, SIOC_POST);
        assert.equal(tripleOf(p.native, SIOC_CONTENT)!.object, "Hello world");
        // Provenance is carried; no ad4m: reification leaks in.
        assert.equal(tripleOf(p.native, DC_CREATOR)!.object, "did:key:alice");
        assert.equal(p.native.triples.some((t) => t.predicate.startsWith("https://ad4m.dev/ontology#")), false);
    });

    it("projects multiple distinct instances", () => {
        const additions = [...fluxMessage("flux://msg1", "one"), ...fluxMessage("flux://msg2", "two")];
        const projected = projectInstances<RdfResource>(additions, [fluxProfile], adapterFor);
        assert.deepEqual(
            projected.map((p) => tripleOf(p.native, SIOC_CONTENT)!.object).sort(),
            ["one", "two"],
        );
    });

    it("projects each base at most once across overlapping profiles (first profile wins)", () => {
        const primary = solidMessageProfile(SIOC_POST);
        const shadow: ProjectionProfile = { ...solidMessageProfile("ex://Note") };
        const projected = projectInstances<RdfResource>(fluxMessage("flux://msg1", "hi"), [primary, shadow], adapterFor);
        assert.equal(projected.length, 1);
        assert.equal(tripleOf(projected[0].native, RDF_TYPE)!.object, SIOC_POST); // first profile's native type
    });

    it("emits nothing for additions whose flags never match", () => {
        const orphan: AuthoredLink[] = [
            {
                author: "did:key:bob",
                timestamp: "2026-07-12T11:00:00.000Z",
                data: { source: "flux://other", predicate: "flux://body", target: encodeLiteral("orphan") },
            },
        ];
        assert.deepEqual(projectInstances<RdfResource>(orphan, [fluxProfile], adapterFor), []);
    });
});

// ---------------------------------------------------------------------------
// ingestNative — native RDF resource → authoritative links
// ---------------------------------------------------------------------------

describe("ingestNative", () => {
    const subject = "https://pod.example/views/view-e1";
    const nativeResource: RdfResource = {
        subject,
        triples: [
            { subject, predicate: RDF_TYPE, object: SIOC_POST, objectIsLiteral: false },
            { subject, predicate: SIOC_CONTENT, object: "native hello", objectIsLiteral: true },
            { subject, predicate: DC_CREATOR, object: "did:key:bob", objectIsLiteral: false },
            { subject, predicate: "http://purl.org/dc/terms/created", object: "2026-07-12T12:00:00.000Z", objectIsLiteral: true, objectDatatype: "http://www.w3.org/2001/XMLSchema#dateTime" },
        ],
    };

    it("reverses a native RDF resource into the links that constitute the instance", () => {
        const ingested = ingestNative<RdfResource>(nativeResource, [fluxProfile], adapterFor);
        assert.ok(ingested);
        assert.equal(ingested!.base, solidResourceBase(subject));
        assert.equal(ingested!.author, "did:key:bob");
        assert.equal(ingested!.timestamp, "2026-07-12T12:00:00.000Z");
        const triples = new Set(ingested!.links.map((l) => `${l.source}|${l.predicate}|${l.target}`));
        assert.deepEqual(triples, new Set([
            `${subject}|flux://entry_type|flux://has_message`,
            `${subject}|flux://body|${encodeLiteral("native hello")}`,
        ]));
    });

    it("returns null when no adapter recognises the payload (wrong class)", () => {
        const wrongClass: RdfResource = {
            subject,
            triples: [{ subject, predicate: RDF_TYPE, object: "ex://Other", objectIsLiteral: false }],
        };
        assert.equal(ingestNative<RdfResource>(wrongClass, [fluxProfile], adapterFor), null);
    });

    it("returns null when the payload carries no subject to anchor a base on", () => {
        const anonymous: RdfResource = {
            subject: "",
            triples: [{ subject: "", predicate: SIOC_CONTENT, object: "x", objectIsLiteral: true }],
        };
        assert.equal(ingestNative<RdfResource>(anonymous, [fluxProfile], adapterFor), null);
    });

    it("parents the ingested instance under a container when requested (default predicate)", () => {
        const ingested = ingestNative<RdfResource>(nativeResource, [fluxProfile], adapterFor, { container: "flux://channel/general" });
        assert.ok(ingested);
        const containerLink = ingested!.links.find((l) => l.predicate === "ad4m://has_child");
        assert.deepEqual(containerLink, {
            source: "flux://channel/general",
            predicate: "ad4m://has_child",
            target: solidResourceBase(subject),
        });
    });

    it("honours a custom container predicate", () => {
        const ingested = ingestNative<RdfResource>(nativeResource, [fluxProfile], adapterFor, {
            container: "flux://channel/general",
            containerPredicate: "flux://has_message",
        });
        assert.ok(ingested!.links.some(
            (l) => l.predicate === "flux://has_message" && l.source === "flux://channel/general",
        ));
    });
});

// ---------------------------------------------------------------------------
// solidMessageProfile (the index.ts default, mirrored here)
// ---------------------------------------------------------------------------

describe("solidMessageProfile", () => {
    it("returns the documented Flux → SIOC message shape", () => {
        const p = solidMessageProfile();
        assert.equal(p.nodeShapeUri, "flux://MessageShape");
        assert.equal(p.targetClass, "flux://Message");
        assert.equal(p.nativeType, SIOC_POST);
        assert.deepEqual(p.flags, [{ path: "flux://entry_type", value: "flux://has_message" }]);
        assert.equal(p.fields.length, 1);
        assert.equal(p.fields[0].nativeField, SIOC_CONTENT);
        assert.equal(p.fields[0].path, "flux://body");
        assert.equal(p.fields[0].datatype, "http://www.w3.org/2001/XMLSchema#string");
    });

    it("honours a custom content predicate", () => {
        const p = solidMessageProfile(SIOC_POST, "http://schema.org/text");
        assert.equal(p.fields[0].nativeField, "http://schema.org/text");
    });
});
