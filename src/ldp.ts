/**
 * Linked Data Platform client — runtime-aware LDP operations.
 *
 * Provides GET/PUT/POST/PATCH/DELETE operations against Solid Pods
 * using the injected Transport adapter.
 *
 * No ad4m:host imports — uses injected adapters only.
 */

import { getTransport } from "./adapters.js";
import type { TransportResponse } from "./adapters.js";
// ---------------------------------------------------------------------------
// LDP Operations
// ---------------------------------------------------------------------------

/**
 * GET a resource from the Pod.
 *
 * @param url Resource URL
 * @param accept Content type to accept (default: text/turtle)
 * @param etag Optional ETag for conditional request (If-None-Match)
 * @param authToken Optional auth token
 * @returns TransportResponse (304 if unchanged)
 */
export async function ldpGet(
    url: string,
    accept: string = TURTLE_CONTENT_TYPE,
    etag?: string,
    authToken?: string,
): Promise<TransportResponse> {
    const headers = getHeaders(accept, etag, authToken);
    return getTransport().fetch(url, "GET", headers, "");
}

/**
 * HEAD a resource — check existence and get ETag.
 */
export async function ldpHead(
    url: string,
    authToken?: string,
): Promise<TransportResponse> {
    const headers = headHeaders(authToken);
    return getTransport().fetch(url, "HEAD", headers, "");
}

/**
 * PUT a resource — create or replace.
 */
export async function ldpPut(
    url: string,
    body: string,
    contentType: string = TURTLE_CONTENT_TYPE,
    authToken?: string,
    ifMatch?: string,
): Promise<TransportResponse> {
    const headers = putHeaders(contentType, authToken, ifMatch);
    return getTransport().fetch(url, "PUT", headers, body);
}

/**
 * POST a resource to a container.
 */
export async function ldpPost(
    containerUrl: string,
    body: string,
    contentType: string = TURTLE_CONTENT_TYPE,
    slug?: string,
    authToken?: string,
): Promise<TransportResponse> {
    const headers = postHeaders(contentType, slug, authToken);
    return getTransport().fetch(containerUrl, "POST", headers, body);
}

/**
 * PATCH a resource with N3 Patch.
 */
export async function ldpPatch(
    url: string,
    body: string,
    authToken?: string,
): Promise<TransportResponse> {
    const headers = patchHeaders(authToken);
    return getTransport().fetch(url, "PATCH", headers, body);
}

/**
 * DELETE a resource.
 */
export async function ldpDelete(
    url: string,
    authToken?: string,
): Promise<TransportResponse> {
    const headers = deleteHeaders(authToken);
    return getTransport().fetch(url, "DELETE", headers, "");
}

// ---------------------------------------------------------------------------
// Convenience Operations
// ---------------------------------------------------------------------------

/**
 * Fetch a Turtle resource and return the body if successful, null otherwise.
 */
export async function fetchTurtle(
    url: string,
    authToken?: string,
): Promise<string | null> {
    const response = await ldpGet(url, TURTLE_CONTENT_TYPE, undefined, authToken);
    if (response.status >= 200 && response.status < 300) {
        return response.body;
    }
    return null;
}

/**
 * Check if a resource exists.
 */
export async function resourceExists(
    url: string,
    authToken?: string,
): Promise<boolean> {
    const response = await ldpHead(url, authToken);
    return response.status >= 200 && response.status < 300;
}

/**
 * Get the ETag for a resource, if available.
 */
export async function getETag(
    url: string,
    authToken?: string,
): Promise<string | null> {
    const response = await ldpHead(url, authToken);
    if (response.status >= 200 && response.status < 300) {
        return response.headers["etag"] || response.headers["ETag"] || null;
    }
    return null;
}

/**
 * Conditionally GET a resource using ETag.
 * Returns null if the resource hasn't changed (304), or the body if it has.
 */
export async function conditionalGet(
    url: string,
    etag: string,
    authToken?: string,
): Promise<{ changed: boolean; body: string | null; newEtag: string | null }> {
    const response = await ldpGet(url, TURTLE_CONTENT_TYPE, etag, authToken);

    if (response.status === 304) {
        return { changed: false, body: null, newEtag: etag };
    }

    if (response.status >= 200 && response.status < 300) {
        const newEtag = response.headers["etag"] || response.headers["ETag"] || null;
        return { changed: true, body: response.body, newEtag };
    }

    return { changed: false, body: null, newEtag: null };
}

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
