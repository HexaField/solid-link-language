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
 * Join a pod base URL and a container path into a normalised container URL —
 * exactly one `/` between them, exactly one trailing `/`, robust to either side
 * carrying or omitting slashes.
 *
 * This MUST be the single join point for every pod URL. The templated values are
 * not guaranteed to be slash-aligned: a pod URL can arrive as
 * `http://host:3005` (no trailing slash) and a container path as `ad4m/<nh>/`
 * (no leading slash). Naive concatenation then yields `http://host:3005ad4m/...`
 * — an invalid URL that makes EVERY `httpFetch` throw `Invalid URL`, so no
 * commit resource is ever written and no sync ever reads one. That is invisible
 * to unit tests whose fixture container path happens to start with `/`, but it
 * froze live C1 at A=10/B=10 (each agent seeing only its own locally-emitted
 * links). Normalise here so slash alignment can never regress.
 */
export function joinPodPath(podUrl: string, containerPath: string): string {
    const base = podUrl.replace(/\/+$/, "");
    const path = containerPath.replace(/^\/+/, "").replace(/\/+$/, "");
    return path ? `${base}/${path}/` : `${base}/`;
}

/**
 * Build the container URL for a neighbourhood's links.
 */
export function linksContainerUrl(podUrl: string, containerPath: string): string {
    return `${joinPodPath(podUrl, containerPath)}links/`;
}

/**
 * Build the URL for a specific link resource.
 */
export function linkResourceUrl(containerUrl: string, linkHash: string): string {
    return `${containerUrl.replace(/\/$/, "")}/link-${linkHash}.ttl`;
}

/**
 * Build the container URL for a neighbourhood's diff-commit DAG.
 *
 * The diff-DAG (convergence substrate) lives alongside `links/` in its own
 * container. Each immutable diff-commit is a resource `diffs/<hash>.ttl`.
 */
export function diffsContainerUrl(podUrl: string, containerPath: string): string {
    return `${joinPodPath(podUrl, containerPath)}diffs/`;
}

/**
 * Build the URL for a diff-commit resource, named by its content hash.
 * Immutable: a given hash always maps to the same body.
 */
export function diffResourceUrl(diffsContainer: string, commitHash: string): string {
    return `${diffsContainer.replace(/\/$/, "")}/diff-${commitHash}.ttl`;
}

/**
 * Build the container URL for the human-facing Channel-B projection resources.
 *
 * These are the clean, app-legible RDF resources a Solid-native client (SolidOS,
 * a generic LDP/RDF browser) reads — one per SHACL-projected subject instance.
 * They live alongside `diffs/` (the Channel-A convergence DAG) in their own
 * `views/` container so the projection never collides with the authoritative
 * commit resources. This is the ONLY Channel-B pod state; it is derived from
 * Role A and never read back as link truth (except for genuinely native-authored
 * resources — see the language's native-ingest path).
 */
export function viewsContainerUrl(podUrl: string, containerPath: string): string {
    return `${joinPodPath(podUrl, containerPath)}views/`;
}

/**
 * Build the URL for a projection view resource, named by a slug derived from the
 * instance's subject URI (its content hash). A given instance always maps to the
 * same resource, so re-projecting overwrites in place rather than duplicating.
 */
export function viewResourceUrl(viewsContainer: string, slug: string): string {
    return `${viewsContainer.replace(/\/$/, "")}/view-${slug}.ttl`;
}

/**
 * Extract the view slug from a projection-resource URL.
 * e.g. ".../views/view-Qm789.ttl" → "Qm789"
 */
export function extractViewSlug(resourceUrl: string): string | null {
    const match = resourceUrl.match(/view-([^/.]+)\.ttl$/);
    return match ? match[1] : null;
}

/**
 * Extract the commit hash from a diff-resource URL.
 * e.g. ".../diffs/diff-Qm789.ttl" → "Qm789"
 */
export function extractCommitHash(resourceUrl: string): string | null {
    const match = resourceUrl.match(/diff-([^/.]+)\.ttl$/);
    return match ? match[1] : null;
}

/**
 * Build the URL for the neighbourhood metadata resource.
 */
export function metaResourceUrl(podUrl: string, containerPath: string): string {
    return `${joinPodPath(podUrl, containerPath)}meta.ttl`;
}

/**
 * Build the URL for the members registry.
 */
export function membersResourceUrl(podUrl: string, containerPath: string): string {
    return `${joinPodPath(podUrl, containerPath)}members/index.ttl`;
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
