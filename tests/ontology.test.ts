/**
 * Tests for AD4M ontology namespace and prefix utilities.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    AD4M_NS,
    RDF_NS,
    XSD_NS,
    LDP_NS,
    ACL_NS,
    FOAF_NS,
    DCTERMS_NS,
    VCARD_NS,
    SOLID_NS,
    ad4m,
    rdf,
    xsd,
    ldp,
    acl,
    foaf,
    vcard,
    DEFAULT_PREFIXES,
    compactUri,
    expandPrefixedName,
    prefixBlock,
} from "../src/ontology.js";

// ---------------------------------------------------------------------------
// Namespace URIs
// ---------------------------------------------------------------------------

describe("Namespace URIs", () => {
    it("AD4M namespace ends with #", () => {
        assert.ok(AD4M_NS.endsWith("#"));
        assert.equal(AD4M_NS, "https://ad4m.dev/ontology#");
    });

    it("RDF namespace is correct", () => {
        assert.equal(RDF_NS, "http://www.w3.org/1999/02/22-rdf-syntax-ns#");
    });

    it("XSD namespace is correct", () => {
        assert.equal(XSD_NS, "http://www.w3.org/2001/XMLSchema#");
    });

    it("LDP namespace is correct", () => {
        assert.equal(LDP_NS, "http://www.w3.org/ns/ldp#");
    });

    it("ACL namespace is correct", () => {
        assert.equal(ACL_NS, "http://www.w3.org/ns/auth/acl#");
    });
});

// ---------------------------------------------------------------------------
// Ontology terms
// ---------------------------------------------------------------------------

describe("Ontology terms", () => {
    it("ad4m terms are properly namespaced", () => {
        assert.equal(ad4m.LinkExpression, `${AD4M_NS}LinkExpression`);
        assert.equal(ad4m.author, `${AD4M_NS}author`);
        assert.equal(ad4m.timestamp, `${AD4M_NS}timestamp`);
        assert.equal(ad4m.proofSignature, `${AD4M_NS}proofSignature`);
        assert.equal(ad4m.proofKey, `${AD4M_NS}proofKey`);
        assert.equal(ad4m.Neighbourhood, `${AD4M_NS}Neighbourhood`);
    });

    it("rdf terms are properly namespaced", () => {
        assert.equal(rdf.type, `${RDF_NS}type`);
        assert.equal(rdf.subject, `${RDF_NS}subject`);
        assert.equal(rdf.predicate, `${RDF_NS}predicate`);
        assert.equal(rdf.object, `${RDF_NS}object`);
    });

    it("xsd terms are properly namespaced", () => {
        assert.equal(xsd.dateTime, `${XSD_NS}dateTime`);
        assert.equal(xsd.string, `${XSD_NS}string`);
    });

    it("ldp terms are properly namespaced", () => {
        assert.equal(ldp.BasicContainer, `${LDP_NS}BasicContainer`);
        assert.equal(ldp.contains, `${LDP_NS}contains`);
    });

    it("acl terms are properly namespaced", () => {
        assert.equal(acl.Authorization, `${ACL_NS}Authorization`);
        assert.equal(acl.Read, `${ACL_NS}Read`);
        assert.equal(acl.Write, `${ACL_NS}Write`);
        assert.equal(acl.Control, `${ACL_NS}Control`);
    });

    it("foaf terms are properly namespaced", () => {
        assert.equal(foaf.Agent, `${FOAF_NS}Agent`);
    });

    it("vcard terms are properly namespaced", () => {
        assert.equal(vcard.Group, `${VCARD_NS}Group`);
        assert.equal(vcard.hasMember, `${VCARD_NS}hasMember`);
    });
});

// ---------------------------------------------------------------------------
// Prefix map
// ---------------------------------------------------------------------------

describe("DEFAULT_PREFIXES", () => {
    it("contains all expected prefixes", () => {
        assert.ok("ad4m" in DEFAULT_PREFIXES);
        assert.ok("rdf" in DEFAULT_PREFIXES);
        assert.ok("xsd" in DEFAULT_PREFIXES);
        assert.ok("ldp" in DEFAULT_PREFIXES);
        assert.ok("acl" in DEFAULT_PREFIXES);
        assert.ok("foaf" in DEFAULT_PREFIXES);
        assert.ok("dcterms" in DEFAULT_PREFIXES);
        assert.ok("vcard" in DEFAULT_PREFIXES);
        assert.ok("solid" in DEFAULT_PREFIXES);
    });

    it("maps to correct namespace URIs", () => {
        assert.equal(DEFAULT_PREFIXES["ad4m"], AD4M_NS);
        assert.equal(DEFAULT_PREFIXES["rdf"], RDF_NS);
        assert.equal(DEFAULT_PREFIXES["xsd"], XSD_NS);
    });
});

// ---------------------------------------------------------------------------
// compactUri
// ---------------------------------------------------------------------------

describe("compactUri", () => {
    it("compacts known namespaced URIs", () => {
        assert.equal(compactUri(`${AD4M_NS}LinkExpression`), "ad4m:LinkExpression");
        assert.equal(compactUri(`${RDF_NS}type`), "rdf:type");
        assert.equal(compactUri(`${XSD_NS}dateTime`), "xsd:dateTime");
    });

    it("returns original URI for unknown namespaces", () => {
        assert.equal(compactUri("http://unknown.example.com/foo"), "http://unknown.example.com/foo");
    });

    it("works with custom prefix map", () => {
        const customPrefixes = { "ex": "http://example.com/" };
        assert.equal(compactUri("http://example.com/thing", customPrefixes), "ex:thing");
    });
});

// ---------------------------------------------------------------------------
// expandPrefixedName
// ---------------------------------------------------------------------------

describe("expandPrefixedName", () => {
    it("expands known prefixed names", () => {
        assert.equal(expandPrefixedName("ad4m:LinkExpression"), `${AD4M_NS}LinkExpression`);
        assert.equal(expandPrefixedName("rdf:type"), `${RDF_NS}type`);
    });

    it("returns original string for unknown prefix", () => {
        assert.equal(expandPrefixedName("unknown:foo"), "unknown:foo");
    });

    it("returns original string for no colon", () => {
        assert.equal(expandPrefixedName("noprefix"), "noprefix");
    });

    it("works with custom prefix map", () => {
        const customPrefixes = { "ex": "http://example.com/" };
        assert.equal(expandPrefixedName("ex:thing", customPrefixes), "http://example.com/thing");
    });
});

// ---------------------------------------------------------------------------
// prefixBlock
// ---------------------------------------------------------------------------

describe("prefixBlock", () => {
    it("generates valid @prefix declarations", () => {
        const block = prefixBlock();
        assert.ok(block.includes("@prefix ad4m: <https://ad4m.dev/ontology#> ."));
        assert.ok(block.includes("@prefix rdf:"));
        assert.ok(block.includes("@prefix xsd:"));
    });

    it("handles custom prefixes", () => {
        const block = prefixBlock({ "ex": "http://example.com/" });
        assert.equal(block, "@prefix ex: <http://example.com/> .");
    });

    it("handles empty prefix map", () => {
        const block = prefixBlock({});
        assert.equal(block, "");
    });
});
