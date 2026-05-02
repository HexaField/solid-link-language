/**
 * Dual-language deduplication — pure module.
 *
 * When the Solid Link Language operates alongside a primary link language
 * (e.g. Holochain), we need to:
 * - Deduplicate links that arrive via both Solid and native sync
 * - Track which links originated from Solid vs native
 * - Filter outbound Solid writes for links that arrived via Solid
 *   (to avoid echo/re-federation loops)
 *
 * Spec §12.
 *
 * Pure functions — no ad4m:host imports.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkOrigin = "solid" | "native" | "dual";

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/**
 * Check if a link already exists in the store (dedup before applying).
 */
export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    const contentHash = hashFn(canonicalLinkData(link));
    return existingHashes.has(contentHash);
}

/**
 * Compute the content hash of a link for dedup tracking.
 */
export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalLinkData(link));
}

// ---------------------------------------------------------------------------
// Origin tracking
// ---------------------------------------------------------------------------

/**
 * Build the storage key for tracking a link's origin.
 */
export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

// ---------------------------------------------------------------------------
// Federation filtering
// ---------------------------------------------------------------------------

/**
 * Determine if an outbound link should be written to Solid.
 *
 * Links that originated from Solid should NOT be re-written to avoid
 * echo loops. Only "native" or "dual" origin links (or links with
 * no tracked origin, i.e. new local commits) should be written.
 */
export function shouldPublishToSolid(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "solid";
}

/**
 * Check if a predicate is in the exclusion list.
 */
export function isExcludedPredicate(
    predicate: string,
    excludePredicates: string[],
): boolean {
    return excludePredicates.includes(predicate);
}
