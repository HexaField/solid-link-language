/**
 * Pure Link ↔ RDF reified triple translation.
 *
 * Converts between AD4M LinkExpressions and RDF reified triples
 * as specified in the Solid Link Language spec §2.2 and §11.
 *
 * Pure functions — no ad4m:host imports.
 */

import type { LinkExpression } from "./types.js";
import type { RdfTriple, RdfGraph } from "./rdf.pure.js";
import { ad4m, rdf, xsd } from "./ontology.js";

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
