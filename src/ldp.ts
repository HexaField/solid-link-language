/**
 * Linked Data Platform client — runtime-aware LDP operations.
 *
 * Provides GET/PUT/POST/PATCH/DELETE operations against Solid Pods
 * using the injected Transport adapter.
 *
 * No ad4m:host imports — uses injected adapters only.
 */

import { getTransport } from "./transport.js";
import type { TransportResponse } from "./transport.js";
import {
    getHeaders,
    headHeaders,
    putHeaders,
    postHeaders,
    patchHeaders,
    deleteHeaders,
    TURTLE_CONTENT_TYPE,
    N3_CONTENT_TYPE,
} from "./ldp.pure.js";

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
