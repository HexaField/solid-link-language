/**
 * Solid Channel-B adapter — the RDF `NativeAdapter`.
 *
 * Maps the generic `Projection` produced by the SHACL transformer to/from a
 * native **RDF resource** (a subject URI plus the triples about it) that a
 * Solid-native app — SolidOS, a generic LDP/RDF browser, any Linked-Data
 * client — reads directly. This is the only Solid-schema-aware half: the SHACL
 * profile decides which graph predicate each field carries; this adapter knows
 * how to lay those out as a clean, app-legible RDF resource.
 *
 * **Solid is the near-identity case.** Unlike a chat/post protocol whose native
 * content is a foreign schema (`m.room.message`, a Nostr event, a Bluesky
 * record), Solid stores RDF and an AD4M subject-class instance already IS RDF.
 * So `toNative` does not translate into a foreign shape — it re-expresses the
 * instance as a direct, human-facing RDF resource: `<base> <predicate> value`
 * for each projected field, in place of Channel A's `ad4m:`-reified
 * diff-commit envelope. A projection field's `nativeField` is therefore the RDF
 * **predicate URI** itself (e.g. `http://rdfs.org/sioc/ns#content`), which the
 * SHACL profile supplies verbatim.
 *
 * Crucially, `toNative` emits ONLY the instance's own triples — no `ad4m`
 * reification, no link hashes, no diff-commit machinery. The convergence DAG
 * rides Channel A (the `diff-<hash>.ttl` resources, see diffdag.ts); this
 * resource is the derived, human-facing view of one subject instance.
 */

import type { RdfTriple } from "./rdf.js";
import { DCTERMS_NS } from "./ontology.js";
import type { NativeAdapter, Projection } from "./projection/index.js";

// ---------------------------------------------------------------------------
// Native shape
// ---------------------------------------------------------------------------

/**
 * A Solid-native RDF resource: the instance's subject URI plus the triples
 * that describe it. This is the payload the language serialises (via the repo's
 * `triplesToTurtle`) and PUTs as a human-facing resource, and the payload a
 * Solid-native resource is parsed into (via `parseTurtle`) for ingest.
 */
export interface RdfResource {
    /** The subject URI the triples are about (the resource's own URI). */
    subject: string;
    /** The triples describing the subject (predicate/object pairs). */
    triples: RdfTriple[];
}

/** dcterms predicates Solid apps read for provenance on a resource. */
export const DC_CREATOR = `${DCTERMS_NS}creator`;
export const DC_CREATED = `${DCTERMS_NS}created`;

/** xsd:dateTime datatype URI, for stamping the created-time literal. */
const XSD_DATETIME = "http://www.w3.org/2001/XMLSchema#dateTime";

// ---------------------------------------------------------------------------
// Value <-> RDF term
// ---------------------------------------------------------------------------

/**
 * True if a projected field value should be written as a URI object rather than
 * a string literal. A field whose SHACL value is itself a URI reference (an
 * `foo://…` / `http(s)://…` term) links to another resource; everything else is
 * a literal. Numbers/booleans are always literals.
 */
function valueIsUri(value: string | number | boolean): value is string {
    if (typeof value !== "string") return false;
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("did:");
}

/** The Turtle datatype URI to stamp a projected literal with, by JS type. */
function datatypeFor(value: string | number | boolean): string | undefined {
    if (typeof value === "number") {
        return Number.isInteger(value)
            ? "http://www.w3.org/2001/XMLSchema#integer"
            : "http://www.w3.org/2001/XMLSchema#decimal";
    }
    if (typeof value === "boolean") return "http://www.w3.org/2001/XMLSchema#boolean";
    return undefined; // plain string literal
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Base URI for an ingested native resource = its own subject URI. */
export function solidResourceBase(subject: string): string {
    return subject;
}

/**
 * Build the Solid RDF adapter.
 *
 * @param nativeType The projection profile's `nativeType`. For Solid this is a
 *   class URI (e.g. `sioc://Post`) that the profile also targets; it is carried
 *   on the resource as an `rdf:type` triple so a Solid-native client can tell
 *   what kind of thing the resource is. Defaults to a generic subject marker.
 */
export function makeSolidAdapter(
    nativeType: string = SOLID_RESOURCE_TYPE,
): NativeAdapter<RdfResource> {
    return {
        toNative(projection: Projection): RdfResource {
            const subject = projection.base;
            if (!subject) {
                throw new Error(
                    "Solid projection requires a base URI — the subject instance " +
                        "must have an identity to anchor its RDF resource on.",
                );
            }

            const triples: RdfTriple[] = [];

            // rdf:type — so a Solid-native client can recognise the resource's
            // class. Emitted from the profile's native type (a class URI).
            triples.push({
                subject,
                predicate: RDF_TYPE,
                object: nativeType,
                objectIsLiteral: false,
            });

            // One triple per projected field. The field name IS the RDF
            // predicate URI (Solid's near-identity): a Message's content field
            // becomes `<base> sioc:content "text"` directly — no reification.
            for (const [predicate, value] of Object.entries(projection.fields)) {
                if (value === undefined || value === null) continue;
                if (valueIsUri(value)) {
                    triples.push({ subject, predicate, object: value, objectIsLiteral: false });
                } else {
                    triples.push({
                        subject,
                        predicate,
                        object: String(value),
                        objectIsLiteral: true,
                        objectDatatype: datatypeFor(value),
                    });
                }
            }

            // Provenance the app can render: dcterms:creator / dcterms:created.
            if (projection.author) {
                triples.push({
                    subject,
                    predicate: DC_CREATOR,
                    object: projection.author,
                    objectIsLiteral: false,
                });
            }
            if (projection.timestamp) {
                triples.push({
                    subject,
                    predicate: DC_CREATED,
                    object: projection.timestamp,
                    objectIsLiteral: true,
                    objectDatatype: XSD_DATETIME,
                });
            }

            return { subject, triples };
        },

        fromNative(resource: RdfResource): Projection | null {
            const subject = resource.subject;
            if (!subject) return null;

            const own = resource.triples.filter((t) => t.subject === subject);
            if (own.length === 0) return null;

            // The resource must be of the profile's class to be projectable.
            const isType = own.some(
                (t) => t.predicate === RDF_TYPE && t.object === nativeType,
            );
            if (!isType) return null;

            const fields: Record<string, string | number | boolean> = {};
            let author: string | undefined;
            let timestamp: string | undefined;

            for (const t of own) {
                if (t.predicate === RDF_TYPE) continue; // the type flag, not a field
                if (t.predicate === DC_CREATOR) {
                    author = t.object;
                    continue;
                }
                if (t.predicate === DC_CREATED) {
                    timestamp = t.object;
                    continue;
                }
                // Every other predicate on the subject is a projected field,
                // keyed by the predicate URI itself.
                fields[t.predicate] = decodeTerm(t);
            }

            // A resource carrying only its type + provenance projects nothing.
            if (Object.keys(fields).length === 0) return null;

            return {
                nativeType,
                base: solidResourceBase(subject),
                author,
                timestamp,
                fields,
            };
        },
    };
}

/** Decode an RDF object term to the scalar the projection layer expects. */
function decodeTerm(triple: RdfTriple): string | number | boolean {
    if (!triple.objectIsLiteral) return triple.object;
    const dt = (triple.objectDatatype ?? "").toLowerCase();
    if (dt.includes("integer") || dt.includes("decimal") || dt.includes("double") ||
        dt.includes("float") || dt.includes("long") || dt.includes("int")) {
        const n = Number(triple.object);
        if (!Number.isNaN(n)) return n;
    }
    if (dt.includes("boolean")) {
        if (triple.object === "true") return true;
        if (triple.object === "false") return false;
    }
    return triple.object;
}

/** rdf:type predicate URI (matches the repo's ontology `rdf.type`). */
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/**
 * Default native type for a projected Solid resource when a profile does not
 * name a class of its own. A generic subject marker in the AD4M namespace so
 * the resource is still self-describing.
 */
export const SOLID_RESOURCE_TYPE = "https://ad4m.dev/ontology#Subject";
