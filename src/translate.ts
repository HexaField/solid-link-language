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
import { getRuntime } from "./adapters.js";
import { triplesToTurtle, parseTurtle } from "./rdf.js";
import type { RdfTriple, RdfGraph } from "./rdf.js";
import { DEFAULT_PREFIXES, ad4m, rdf, xsd } from "./ontology.js";

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


// ---------------------------------------------------------------------------
// Link → RDF Triples (Outbound)
// ---------------------------------------------------------------------------

/**
 * Convert a LinkExpression to reified RDF triples.
 *
 * Produces a set of triples that represent the link as a reified
 * RDF statement with full AD4M provenance metadata.
 *
 * @param link The LinkExpression to convert
 * @param linkId The local identifier for this link (e.g. "link-Qm789ghi")
 * @returns Array of RDF triples representing the reified link
 */
export function linkToReifiedTriples(link: LinkExpression, linkId: string): RdfTriple[] {
    const subject = `#${linkId}`;
    const triples: RdfTriple[] = [];

    // rdf:type ad4m:LinkExpression
    triples.push({
        subject,
        predicate: rdf.type,
        object: ad4m.LinkExpression,
        objectIsLiteral: false,
    });

    // rdf:subject — the link's source
    triples.push({
        subject,
        predicate: rdf.subject,
        object: link.data.source || "",
        objectIsLiteral: false,
    });

    // rdf:predicate — the link's predicate
    triples.push({
        subject,
        predicate: rdf.predicate,
        object: link.data.predicate || "",
        objectIsLiteral: false,
    });

    // rdf:object — the link's target
    triples.push({
        subject,
        predicate: rdf.object,
        object: link.data.target || "",
        objectIsLiteral: false,
    });

    // ad4m:author
    triples.push({
        subject,
        predicate: ad4m.author,
        object: link.author,
        objectIsLiteral: true,
    });

    // ad4m:timestamp
    triples.push({
        subject,
        predicate: ad4m.timestamp,
        object: link.timestamp,
        objectIsLiteral: true,
        objectDatatype: xsd.dateTime,
    });

    // ad4m:proofSignature
    if (link.proof?.signature) {
        triples.push({
            subject,
            predicate: ad4m.proofSignature,
            object: link.proof.signature,
            objectIsLiteral: true,
        });
    }

    // ad4m:proofKey
    if (link.proof?.key) {
        triples.push({
            subject,
            predicate: ad4m.proofKey,
            object: link.proof.key,
            objectIsLiteral: true,
        });
    }

    return triples;
}

/**
 * Convert a LinkExpression to a raw (non-reified) RDF triple.
 * Just the source → predicate → target, no provenance.
 */
export function linkToRawTriple(link: LinkExpression): RdfTriple {
    return {
        subject: link.data.source || "",
        predicate: link.data.predicate || "",
        object: link.data.target || "",
        objectIsLiteral: false,
    };
}

// ---------------------------------------------------------------------------
// RDF → Link (Inbound)
// ---------------------------------------------------------------------------

/**
 * Extract LinkExpressions from an RDF graph by finding all
 * ad4m:LinkExpression typed resources.
 *
 * @param graph Parsed RDF graph
 * @param baseUrl Base URL for resolving relative references
 * @returns Array of LinkExpressions extracted from the graph
 */
export function graphToLinks(graph: RdfGraph, baseUrl: string = ""): LinkExpression[] {
    const links: LinkExpression[] = [];

    // Find all subjects typed as ad4m:LinkExpression
    const linkSubjects = graph.triples
        .filter(t => t.predicate === rdf.type && t.object === ad4m.LinkExpression)
        .map(t => t.subject);

    for (const subj of linkSubjects) {
        const subjectTriples = graph.triples.filter(t => t.subject === subj);
        const getVal = (pred: string): string | undefined =>
            subjectTriples.find(t => t.predicate === pred)?.object;

        const source = getVal(rdf.subject);
        const predicate = getVal(rdf.predicate);
        const target = getVal(rdf.object);
        const author = getVal(ad4m.author);
        const timestamp = getVal(ad4m.timestamp);
        const proofSignature = getVal(ad4m.proofSignature);
        const proofKey = getVal(ad4m.proofKey);

        if (source !== undefined && predicate !== undefined && target !== undefined) {
            links.push({
                author: author ?? `solid:${baseUrl}`,
                timestamp: timestamp ?? new Date().toISOString(),
                data: {
                    source,
                    predicate,
                    target,
                },
                proof: {
                    signature: proofSignature ?? "",
                    key: proofKey ?? "",
                },
            });
        }
    }

    return links;
}

/**
 * Compute a deterministic content key for a link (for dedup/hashing).
 */
export function linkContentKey(link: LinkExpression): string {
    return `${link.data.source || ""}:${link.data.predicate || ""}:${link.data.target || ""}:${link.author}:${link.timestamp}`;
}

// ---------------------------------------------------------------------------
// SDNA / Subject Class pattern detection (was sdna.ts)
// ---------------------------------------------------------------------------

export interface DetectedPattern {
    type: "chat-message" | "reply" | "content" | "mention" | "reaction" | "unknown";
    contentUri?: string;
    parentUri?: string;
    channelUri?: string;
    mentionedAgent?: string;
}

const _CHAT_PREDICATES = new Set([
    "flux://has_message",
    "sioc://content_of",
]);

const _REPLY_PREDICATES = new Set([
    "flux://has_reply",
    "sioc://reply_of",
]);

const _REACTION_PREDICATES = new Set([
    "flux://has_reaction",
    "emoji://reaction",
]);

const _CONTENT_PREDICATE = "sioc://content_of";

export function detectPattern(
    link: LinkExpression,
    chatPredicates?: string[],
): DetectedPattern {
    const predicate = link.data.predicate || "";
    const source = link.data.source || "";
    const target = link.data.target || "";

    const chatPreds = chatPredicates
        ? new Set(chatPredicates)
        : _CHAT_PREDICATES;

    if (predicate && chatPreds.has(predicate)) {
        return { type: "chat-message", contentUri: target, channelUri: source };
    }
    if (_REPLY_PREDICATES.has(predicate)) {
        return { type: "reply", contentUri: target, parentUri: source };
    }
    if (predicate && predicate.toLowerCase().includes("mention")) {
        return { type: "mention", mentionedAgent: target };
    }
    if (_REACTION_PREDICATES.has(predicate)) {
        return { type: "reaction", contentUri: target };
    }
    if (predicate === _CONTENT_PREDICATE) {
        return { type: "content", contentUri: target };
    }
    return { type: "unknown" };
}

// ---------------------------------------------------------------------------
// Dual-language deduplication (was dual-language.ts)
// ---------------------------------------------------------------------------

export type LinkOrigin = "solid" | "native" | "dual";

function _canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    return existingHashes.has(hashFn(_canonicalLinkData(link)));
}

export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(_canonicalLinkData(link));
}

export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

export function shouldPublishToSolid(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "solid";
}

export function isExcludedPredicate(
    predicate: string,
    excludePredicates: string[],
): boolean {
    return excludePredicates.includes(predicate);
}
