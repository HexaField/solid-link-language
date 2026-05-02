/**
 * Pure LDP request builders — headers, content negotiation.
 *
 * No ad4m:host imports. Pure functions for building HTTP requests
 * for Solid LDP operations.
 */

// ---------------------------------------------------------------------------
// Content Types
// ---------------------------------------------------------------------------

export const TURTLE_CONTENT_TYPE = "text/turtle";
export const N3_CONTENT_TYPE = "text/n3";
export const JSONLD_CONTENT_TYPE = "application/ld+json";

// ---------------------------------------------------------------------------
// Header Builders
// ---------------------------------------------------------------------------

/**
 * Build headers for an LDP GET request.
 */
export function getHeaders(
    accept: string = TURTLE_CONTENT_TYPE,
    etag?: string,
    authToken?: string,
): Record<string, string> {
    const headers: Record<string, string> = {
        "Accept": accept,
    };
    if (etag) {
        headers["If-None-Match"] = etag;
    }
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }
    return headers;
}

/**
 * Build headers for an LDP HEAD request.
 */
export function headHeaders(authToken?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }
    return headers;
}

/**
 * Build headers for an LDP PUT request (create/replace resource).
 */
export function putHeaders(
    contentType: string = TURTLE_CONTENT_TYPE,
    authToken?: string,
    ifMatch?: string,
): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": contentType,
    };
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }
    if (ifMatch) {
        headers["If-Match"] = ifMatch;
    }
    return headers;
}

/**
 * Build headers for an LDP POST request (create resource in container).
 */
export function postHeaders(
    contentType: string = TURTLE_CONTENT_TYPE,
    slug?: string,
    authToken?: string,
): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": contentType,
    };
    if (slug) {
        headers["Slug"] = slug;
    }
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }
    return headers;
}

/**
 * Build headers for an LDP PATCH request (N3 Patch).
 */
export function patchHeaders(
    authToken?: string,
): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": N3_CONTENT_TYPE,
    };
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }
    return headers;
}

/**
 * Build headers for an LDP DELETE request.
 */
export function deleteHeaders(authToken?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }
    return headers;
}

// ---------------------------------------------------------------------------
// URL Builders
// ---------------------------------------------------------------------------

/**
 * Build the container URL for a neighbourhood's links.
 */
export function linksContainerUrl(podUrl: string, containerPath: string): string {
    const base = podUrl.replace(/\/$/, "");
    const path = containerPath.replace(/\/$/, "");
    return `${base}${path}/links/`;
}

/**
 * Build the URL for a specific link resource.
 */
export function linkResourceUrl(containerUrl: string, linkHash: string): string {
    return `${containerUrl.replace(/\/$/, "")}/link-${linkHash}.ttl`;
}

/**
 * Build the URL for the neighbourhood metadata resource.
 */
export function metaResourceUrl(podUrl: string, containerPath: string): string {
    const base = podUrl.replace(/\/$/, "");
    const path = containerPath.replace(/\/$/, "");
    return `${base}${path}/meta.ttl`;
}

/**
 * Build the URL for the members registry.
 */
export function membersResourceUrl(podUrl: string, containerPath: string): string {
    const base = podUrl.replace(/\/$/, "");
    const path = containerPath.replace(/\/$/, "");
    return `${base}${path}/members/index.ttl`;
}

/**
 * Build the URL for the ACL resource of a container.
 */
export function aclResourceUrl(containerUrl: string): string {
    return `${containerUrl.replace(/\/$/, "")}/.acl`;
}

/**
 * Extract link hash from a resource URL.
 * e.g. "https://pod.example.com/.../link-Qm789ghi.ttl" → "Qm789ghi"
 */
export function extractLinkHash(resourceUrl: string): string | null {
    const match = resourceUrl.match(/link-([^/.]+)\.ttl$/);
    return match ? match[1] : null;
}

/**
 * Extract resource URLs from an LDP container listing.
 * Parses ldp:contains predicates from parsed Turtle.
 */
export function extractContainedResources(containerUrl: string, containsValues: string[]): string[] {
    return containsValues.map(val => {
        if (val.startsWith("http://") || val.startsWith("https://")) {
            return val;
        }
        // Relative URL
        const base = containerUrl.replace(/\/$/, "");
        if (val.startsWith("/")) return `${new URL(containerUrl).origin}${val}`;
        return `${base}/${val}`;
    });
}
