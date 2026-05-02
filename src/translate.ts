/**
 * Link ↔ RDF resource translation — runtime-aware wrapper.
 *
 * Combines pure translation functions with runtime services
 * (hashing, transport) to provide full link-to-Turtle and
 * Turtle-to-link translation.
 *
 * No ad4m:host imports — uses injected adapters only.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { SolidSettings } from "./settings.js";
import { getRuntime } from "./runtime-interface.js";
import { linkToReifiedTriples, linkToRawTriple, graphToLinks, linkContentKey } from "./translate.pure.js";
import { triplesToTurtle, parseTurtle } from "./rdf.pure.js";
import type { RdfTriple } from "./rdf.pure.js";
import { DEFAULT_PREFIXES } from "./ontology.js";

// Re-export pure functions
export { linkContentKey, graphToLinks };

// ---------------------------------------------------------------------------
// Link → Turtle (Outbound)
// ---------------------------------------------------------------------------

/**
 * Convert a single LinkExpression to Turtle format.
 *
 * @param link The LinkExpression to convert
 * @param settings Language settings (controls rendering strategy)
 * @returns Turtle string for this link
 */
export function linkToTurtle(link: LinkExpression, settings: SolidSettings): string {
    const hashFn = getRuntime().hash;
    const linkHash = hashFn(linkContentKey(link));
    const linkId = `link-${linkHash}`;

    if (settings.rendering.strategy === "raw-triples") {
        const triple = linkToRawTriple(link);
        return triplesToTurtle([triple], DEFAULT_PREFIXES);
    }

    // Reified form (default)
    const triples = linkToReifiedTriples(link, linkId);
    return triplesToTurtle(triples, DEFAULT_PREFIXES);
}

/**
 * Convert a batch of LinkExpressions to a single Turtle document.
 *
 * @param links Array of LinkExpressions
 * @param settings Language settings
 * @returns Complete Turtle document with prefix declarations
 */
export function linkBatchToTurtle(links: LinkExpression[], settings: SolidSettings): string {
    const hashFn = getRuntime().hash;
    const allTriples: RdfTriple[] = [];

    for (const link of links) {
        const linkHash = hashFn(linkContentKey(link));
        const linkId = `link-${linkHash}`;

        if (settings.rendering.strategy === "raw-triples") {
            allTriples.push(linkToRawTriple(link));
        } else {
            allTriples.push(...linkToReifiedTriples(link, linkId));
        }
    }

    return triplesToTurtle(allTriples, DEFAULT_PREFIXES);
}

/**
 * Convert a PerspectiveDiff to Turtle for additions.
 */
export function diffToTurtle(diff: PerspectiveDiff, settings: SolidSettings): string {
    return linkBatchToTurtle(diff.additions, settings);
}

// ---------------------------------------------------------------------------
// Turtle → Links (Inbound)
// ---------------------------------------------------------------------------

/**
 * Parse a Turtle document and extract LinkExpressions.
 *
 * @param turtle Turtle document content
 * @param baseUrl Base URL for resolving relative references
 * @returns Array of LinkExpressions
 */
export function turtleToLinks(turtle: string, baseUrl: string = ""): LinkExpression[] {
    const graph = parseTurtle(turtle, baseUrl);
    return graphToLinks(graph, baseUrl);
}

// ---------------------------------------------------------------------------
// N3 Patch generation
// ---------------------------------------------------------------------------

/**
 * Build an N3 Patch body for inserting links into an existing resource.
 */
export function buildInsertPatch(links: LinkExpression[], settings: SolidSettings): string {
    const hashFn = getRuntime().hash;
    const triples: RdfTriple[] = [];

    for (const link of links) {
        const linkHash = hashFn(linkContentKey(link));
        const linkId = `link-${linkHash}`;

        if (settings.rendering.strategy === "raw-triples") {
            triples.push(linkToRawTriple(link));
        } else {
            triples.push(...linkToReifiedTriples(link, linkId));
        }
    }

    const body = triplesToTurtle(triples, DEFAULT_PREFIXES);

    return `@prefix solid: <http://www.w3.org/ns/solid/terms#> .\n\n` +
        `_:patch solid:inserts {\n${indent(body)}\n} .`;
}

/**
 * Build an N3 Patch body for deleting links from a resource.
 */
export function buildDeletePatch(links: LinkExpression[], settings: SolidSettings): string {
    const hashFn = getRuntime().hash;
    const triples: RdfTriple[] = [];

    for (const link of links) {
        const linkHash = hashFn(linkContentKey(link));
        const linkId = `link-${linkHash}`;

        if (settings.rendering.strategy === "raw-triples") {
            triples.push(linkToRawTriple(link));
        } else {
            triples.push(...linkToReifiedTriples(link, linkId));
        }
    }

    const body = triplesToTurtle(triples, DEFAULT_PREFIXES);

    return `@prefix solid: <http://www.w3.org/ns/solid/terms#> .\n\n` +
        `_:patch solid:deletes {\n${indent(body)}\n} .`;
}

function indent(text: string): string {
    return text.split("\n").map(line => `    ${line}`).join("\n");
}
