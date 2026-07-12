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
    joinPodPath,
    linksContainerUrl,
    linkResourceUrl,
    diffsContainerUrl,
    diffResourceUrl,
    viewsContainerUrl,
    extractCommitHash,
    metaResourceUrl,
    membersResourceUrl,
    aclResourceUrl,
    extractLinkHash,
    extractContainedResources,
    TURTLE_CONTENT_TYPE,
    N3_CONTENT_TYPE,
} from "../src/ldp.js";

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

// Regression guard for the live C1 A=10/B=10 freeze. The wind-tunnel templates
// SOLID_POD_URL with NO trailing slash ("http://127.0.0.1:3005") and
// SOLID_CONTAINER_PATH with NO leading slash ("ad4m/c1-<uuid>/"). The old
// builders concatenated base+path with no separator, producing an invalid URL
// like "http://127.0.0.1:3005ad4m/c1-x/diffs/" — every httpFetch then threw, no
// commit resource was ever written, and each agent saw only its own 10 links.
// The pre-existing builder tests all used leading-slash "/ad4m/..." fixtures,
// which masked the bug. These assert the full slash matrix and, critically, that
// each result parses via `new URL()`.
describe("joinPodPath (slash-normalisation matrix)", () => {
    const expected = "http://127.0.0.1:3005/ad4m/c1-x/";

    it("wind-tunnel shape: no trailing slash on pod, no leading slash on path", () => {
        assert.equal(joinPodPath("http://127.0.0.1:3005", "ad4m/c1-x/"), expected);
    });

    it("no trailing slash on pod, no slashes on path at all", () => {
        assert.equal(joinPodPath("http://127.0.0.1:3005", "ad4m/c1-x"), expected);
    });

    it("trailing slash on pod, leading slash on path", () => {
        assert.equal(joinPodPath("http://127.0.0.1:3005/", "/ad4m/c1-x/"), expected);
    });

    it("both fully slashed", () => {
        assert.equal(joinPodPath("http://127.0.0.1:3005/", "/ad4m/c1-x"), expected);
    });

    it("collapses redundant multi-slashes on both sides", () => {
        assert.equal(joinPodPath("http://127.0.0.1:3005///", "///ad4m/c1-x///"), expected);
    });

    it("empty container path yields the bare pod root with one trailing slash", () => {
        assert.equal(joinPodPath("http://127.0.0.1:3005", ""), "http://127.0.0.1:3005/");
        assert.equal(joinPodPath("http://127.0.0.1:3005/", "/"), "http://127.0.0.1:3005/");
    });

    it("every joined path is a parseable absolute URL", () => {
        for (const [pod, path] of [
            ["http://127.0.0.1:3005", "ad4m/c1-x/"],
            ["http://127.0.0.1:3005/", "/ad4m/c1-x/"],
            ["https://pod.example.com", "ad4m/neighbourhoods/test"],
        ] as const) {
            const joined = joinPodPath(pod, path);
            assert.doesNotThrow(() => new URL(joined), `joinPodPath(${pod}, ${path}) => ${joined}`);
        }
    });
});

describe("container builders reject the no-separator concatenation bug", () => {
    // The exact inputs the wind-tunnel feeds the templated language.
    const pod = "http://127.0.0.1:3005";
    const container = "ad4m/c1-5e638525/";

    it("diffsContainerUrl produces a valid, correctly-separated URL", () => {
        const url = diffsContainerUrl(pod, container);
        assert.equal(url, "http://127.0.0.1:3005/ad4m/c1-5e638525/diffs/");
        assert.doesNotThrow(() => new URL(url));
    });

    it("linksContainerUrl produces a valid, correctly-separated URL", () => {
        const url = linksContainerUrl(pod, container);
        assert.equal(url, "http://127.0.0.1:3005/ad4m/c1-5e638525/links/");
        assert.doesNotThrow(() => new URL(url));
    });

    it("viewsContainerUrl produces a valid, correctly-separated URL", () => {
        const url = viewsContainerUrl(pod, container);
        assert.equal(url, "http://127.0.0.1:3005/ad4m/c1-5e638525/views/");
        assert.doesNotThrow(() => new URL(url));
    });

    it("metaResourceUrl produces a valid, correctly-separated URL", () => {
        const url = metaResourceUrl(pod, container);
        assert.equal(url, "http://127.0.0.1:3005/ad4m/c1-5e638525/meta.ttl");
        assert.doesNotThrow(() => new URL(url));
    });

    it("membersResourceUrl produces a valid, correctly-separated URL", () => {
        const url = membersResourceUrl(pod, container);
        assert.equal(url, "http://127.0.0.1:3005/ad4m/c1-5e638525/members/index.ttl");
        assert.doesNotThrow(() => new URL(url));
    });

    it("no builder ever emits the port glued to the path (the freeze signature)", () => {
        for (const url of [
            diffsContainerUrl(pod, container),
            linksContainerUrl(pod, container),
            viewsContainerUrl(pod, container),
            metaResourceUrl(pod, container),
            membersResourceUrl(pod, container),
        ]) {
            assert.ok(!url.includes("3005ad4m"), `saw the glued freeze signature in ${url}`);
        }
    });
});

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

describe("diffsContainerUrl", () => {
    it("builds the diff-DAG container URL", () => {
        const url = diffsContainerUrl("https://pod.example.com", "/ad4m/neighbourhoods/test");
        assert.equal(url, "https://pod.example.com/ad4m/neighbourhoods/test/diffs/");
    });

    it("handles trailing slashes", () => {
        const url = diffsContainerUrl("https://pod.example.com/", "/ad4m/test/");
        assert.equal(url, "https://pod.example.com/ad4m/test/diffs/");
    });
});

describe("diffResourceUrl", () => {
    it("names the resource by its content hash", () => {
        const url = diffResourceUrl("https://pod.example.com/diffs/", "Qm789ghi");
        assert.equal(url, "https://pod.example.com/diffs/diff-Qm789ghi.ttl");
    });

    it("is deterministic for a given hash (immutable resource)", () => {
        const a = diffResourceUrl("https://pod.example.com/diffs/", "QmABC");
        const b = diffResourceUrl("https://pod.example.com/diffs", "QmABC");
        assert.equal(a, b);
    });
});

describe("extractCommitHash", () => {
    it("extracts the commit hash from a diff-resource URL", () => {
        assert.equal(
            extractCommitHash("https://pod.example.com/diffs/diff-Qm789ghi.ttl"),
            "Qm789ghi",
        );
    });

    it("round-trips with diffResourceUrl", () => {
        const url = diffResourceUrl("https://pod.example.com/diffs/", "QmRoundTrip123");
        assert.equal(extractCommitHash(url), "QmRoundTrip123");
    });

    it("returns null for non-diff URLs", () => {
        assert.equal(extractCommitHash("https://pod.example.com/diffs/"), null);
        assert.equal(extractCommitHash("https://pod.example.com/links/link-Qm789ghi.ttl"), null);
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
