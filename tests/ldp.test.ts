/**
 * Tests for LDP pure request builders.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    getHeaders,
    headHeaders,
    putHeaders,
    postHeaders,
    patchHeaders,
    deleteHeaders,
    linksContainerUrl,
    linkResourceUrl,
    metaResourceUrl,
    membersResourceUrl,
    aclResourceUrl,
    extractLinkHash,
    extractContainedResources,
    TURTLE_CONTENT_TYPE,
    N3_CONTENT_TYPE,
} from "../src/ldp.pure.js";

// ---------------------------------------------------------------------------
// Header builders
// ---------------------------------------------------------------------------

describe("getHeaders", () => {
    it("sets Accept header", () => {
        const h = getHeaders();
        assert.equal(h["Accept"], TURTLE_CONTENT_TYPE);
    });

    it("accepts custom content type", () => {
        const h = getHeaders("application/ld+json");
        assert.equal(h["Accept"], "application/ld+json");
    });

    it("includes If-None-Match when etag provided", () => {
        const h = getHeaders(TURTLE_CONTENT_TYPE, '"abc123"');
        assert.equal(h["If-None-Match"], '"abc123"');
    });

    it("excludes If-None-Match when no etag", () => {
        const h = getHeaders();
        assert.equal(h["If-None-Match"], undefined);
    });

    it("includes Authorization when token provided", () => {
        const h = getHeaders(TURTLE_CONTENT_TYPE, undefined, "mytoken");
        assert.equal(h["Authorization"], "Bearer mytoken");
    });
});

describe("headHeaders", () => {
    it("returns empty when no token", () => {
        const h = headHeaders();
        assert.deepEqual(h, {});
    });

    it("includes auth token", () => {
        const h = headHeaders("tok");
        assert.equal(h["Authorization"], "Bearer tok");
    });
});

describe("putHeaders", () => {
    it("sets Content-Type to text/turtle by default", () => {
        const h = putHeaders();
        assert.equal(h["Content-Type"], TURTLE_CONTENT_TYPE);
    });

    it("includes If-Match when etag provided", () => {
        const h = putHeaders(TURTLE_CONTENT_TYPE, undefined, '"etag"');
        assert.equal(h["If-Match"], '"etag"');
    });

    it("includes auth token", () => {
        const h = putHeaders(TURTLE_CONTENT_TYPE, "tok");
        assert.equal(h["Authorization"], "Bearer tok");
    });
});

describe("postHeaders", () => {
    it("includes Slug when provided", () => {
        const h = postHeaders(TURTLE_CONTENT_TYPE, "my-resource");
        assert.equal(h["Slug"], "my-resource");
    });

    it("excludes Slug when not provided", () => {
        const h = postHeaders();
        assert.equal(h["Slug"], undefined);
    });
});

describe("patchHeaders", () => {
    it("sets Content-Type to text/n3", () => {
        const h = patchHeaders();
        assert.equal(h["Content-Type"], N3_CONTENT_TYPE);
    });
});

describe("deleteHeaders", () => {
    it("returns empty when no token", () => {
        const h = deleteHeaders();
        assert.deepEqual(h, {});
    });

    it("includes auth token", () => {
        const h = deleteHeaders("tok");
        assert.equal(h["Authorization"], "Bearer tok");
    });
});

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

describe("linksContainerUrl", () => {
    it("builds correct URL", () => {
        const url = linksContainerUrl("https://pod.example.com", "/ad4m/neighbourhoods/test");
        assert.equal(url, "https://pod.example.com/ad4m/neighbourhoods/test/links/");
    });

    it("handles trailing slashes", () => {
        const url = linksContainerUrl("https://pod.example.com/", "/ad4m/test/");
        assert.equal(url, "https://pod.example.com/ad4m/test/links/");
    });
});

describe("linkResourceUrl", () => {
    it("builds correct URL", () => {
        const url = linkResourceUrl("https://pod.example.com/links/", "Qm789ghi");
        assert.equal(url, "https://pod.example.com/links/link-Qm789ghi.ttl");
    });
});

describe("metaResourceUrl", () => {
    it("builds correct URL", () => {
        const url = metaResourceUrl("https://pod.example.com", "/ad4m/test");
        assert.equal(url, "https://pod.example.com/ad4m/test/meta.ttl");
    });
});

describe("membersResourceUrl", () => {
    it("builds correct URL", () => {
        const url = membersResourceUrl("https://pod.example.com", "/ad4m/test");
        assert.equal(url, "https://pod.example.com/ad4m/test/members/index.ttl");
    });
});

describe("aclResourceUrl", () => {
    it("builds correct URL", () => {
        const url = aclResourceUrl("https://pod.example.com/links/");
        assert.equal(url, "https://pod.example.com/links/.acl");
    });
});

describe("extractLinkHash", () => {
    it("extracts hash from link URL", () => {
        assert.equal(
            extractLinkHash("https://pod.example.com/links/link-Qm789ghi.ttl"),
            "Qm789ghi",
        );
    });

    it("returns null for non-link URLs", () => {
        assert.equal(extractLinkHash("https://pod.example.com/meta.ttl"), null);
    });

    it("handles complex hashes", () => {
        assert.equal(
            extractLinkHash("https://pod.example.com/links/link-abc123def456.ttl"),
            "abc123def456",
        );
    });
});

describe("extractContainedResources", () => {
    it("handles absolute URLs", () => {
        const urls = extractContainedResources(
            "https://pod.example.com/links/",
            ["https://pod.example.com/links/link-abc.ttl"],
        );
        assert.deepEqual(urls, ["https://pod.example.com/links/link-abc.ttl"]);
    });

    it("resolves relative URLs", () => {
        const urls = extractContainedResources(
            "https://pod.example.com/links/",
            ["link-abc.ttl", "link-def.ttl"],
        );
        assert.equal(urls.length, 2);
        assert.ok(urls[0].includes("link-abc.ttl"));
        assert.ok(urls[1].includes("link-def.ttl"));
    });
});
