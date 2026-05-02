/**
 * Pod sync — polling resource container for changes.
 *
 * Implements the sync flow from Spec §6:
 * - Poll links container with ETag-based change detection
 * - Fetch new/modified resources
 * - Parse RDF → translate to links
 * - Store ETag in KV
 *
 * No ad4m:host imports — uses injected adapters only.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import type { SolidSettings } from "./settings.js";
import { getStorage } from "./storage-interface.js";
import { ldpGet, fetchTurtle, conditionalGet } from "./ldp.js";
import { parseTurtle, getObjects } from "./rdf.pure.js";
import { graphToLinks } from "./translate.pure.js";
import { ldp } from "./ontology.js";
import { linksContainerUrl, extractLinkHash, extractContainedResources } from "./ldp.pure.js";
import * as store from "./store.js";

// ---------------------------------------------------------------------------
// KV Keys
// ---------------------------------------------------------------------------

const SYNC_ETAG_KEY = "solid:sync:etag";
const RESOURCE_ETAG_PREFIX = "solid:etag:";
const KNOWN_RESOURCES_KEY = "solid:sync:known-resources";

function resourceEtagKey(url: string): string {
    return `${RESOURCE_ETAG_PREFIX}${url}`;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Perform a full sync cycle: poll the links container, detect changes,
 * fetch new/modified resources, translate to links, apply to store.
 *
 * @param podUrl Pod base URL
 * @param containerPath Container path on the Pod
 * @param authToken Optional auth token
 * @returns PerspectiveDiff of changes found
 */
export async function syncFromPod(
    podUrl: string,
    containerPath: string,
    authToken?: string,
): Promise<PerspectiveDiff> {
    const containerUrl = linksContainerUrl(podUrl, containerPath);
    const storage = getStorage();

    // Check container for changes using ETag
    const currentEtag = storage.get(SYNC_ETAG_KEY);
    const containerResponse = currentEtag
        ? await conditionalGet(containerUrl, currentEtag, authToken)
        : await ldpGet(containerUrl, "text/turtle", undefined, authToken)
            .then(r => ({
                changed: r.status >= 200 && r.status < 300,
                body: r.status >= 200 && r.status < 300 ? r.body : null,
                newEtag: r.headers["etag"] || r.headers["ETag"] || null,
            }));

    if (!containerResponse.changed || !containerResponse.body) {
        return { additions: [], removals: [] };
    }

    // Update container ETag
    if (containerResponse.newEtag) {
        storage.put(SYNC_ETAG_KEY, containerResponse.newEtag);
    }

    // Parse container listing
    const containerGraph = parseTurtle(containerResponse.body, containerUrl);
    const containedUris = getObjects(containerGraph, containerUrl, ldp.contains);
    const resourceUrls = extractContainedResources(containerUrl, containedUris);

    // Determine known vs new resources
    const knownRaw = storage.get(KNOWN_RESOURCES_KEY);
    const knownResources = new Set<string>(knownRaw ? JSON.parse(knownRaw) : []);

    const newResources = resourceUrls.filter(url => !knownResources.has(url));
    const removedResources = [...knownResources].filter(url => !resourceUrls.includes(url));

    // Fetch new resources and extract links
    const additions: LinkExpression[] = [];
    for (const resourceUrl of newResources) {
        const turtle = await fetchTurtle(resourceUrl, authToken);
        if (turtle) {
            const links = graphToLinks(parseTurtle(turtle, resourceUrl), resourceUrl);
            additions.push(...links);
            for (const link of links) {
                store.putLink(link);
            }
        }
    }

    // Handle removed resources — find links that were in those resources
    const removals: LinkExpression[] = [];
    for (const resourceUrl of removedResources) {
        const linkHash = extractLinkHash(resourceUrl);
        if (linkHash) {
            const existingLink = store.getLink(linkHash);
            if (existingLink) {
                removals.push(existingLink);
                store.removeLink(existingLink);
            }
        }
    }

    // Update known resources
    storage.put(KNOWN_RESOURCES_KEY, JSON.stringify(resourceUrls));

    return { additions, removals };
}

/**
 * Full initial sync — fetch all resources from the container.
 */
export async function fullSync(
    podUrl: string,
    containerPath: string,
    authToken?: string,
): Promise<PerspectiveDiff> {
    const containerUrl = linksContainerUrl(podUrl, containerPath);
    const storage = getStorage();

    // Fetch container listing
    const response = await ldpGet(containerUrl, "text/turtle", undefined, authToken);
    if (response.status < 200 || response.status >= 300) {
        return { additions: [], removals: [] };
    }

    // Store ETag
    const etag = response.headers["etag"] || response.headers["ETag"];
    if (etag) {
        storage.put(SYNC_ETAG_KEY, etag);
    }

    // Parse container
    const containerGraph = parseTurtle(response.body, containerUrl);
    const containedUris = getObjects(containerGraph, containerUrl, ldp.contains);
    const resourceUrls = extractContainedResources(containerUrl, containedUris);

    // Fetch all resources
    const additions: LinkExpression[] = [];
    for (const resourceUrl of resourceUrls) {
        const turtle = await fetchTurtle(resourceUrl, authToken);
        if (turtle) {
            const links = graphToLinks(parseTurtle(turtle, resourceUrl), resourceUrl);
            additions.push(...links);
            for (const link of links) {
                store.putLink(link);
            }
        }
    }

    // Store known resources
    storage.put(KNOWN_RESOURCES_KEY, JSON.stringify(resourceUrls));

    return { additions, removals: [] };
}

/**
 * Get the current sync ETag (for external monitoring).
 */
export function getSyncEtag(): string | null {
    return getStorage().get(SYNC_ETAG_KEY);
}
