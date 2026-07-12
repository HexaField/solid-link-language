/**
 * AD4M ontology namespace definitions and prefix management.
 *
 * Provides the RDF namespace URIs and prefix map used throughout
 * the Solid Link Language for Turtle serialization/parsing.
 *
 * Pure module — no ad4m:host imports.
 */

// ---------------------------------------------------------------------------
// Namespace URIs
// ---------------------------------------------------------------------------

export const AD4M_NS = "https://ad4m.dev/ontology#";
export const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
export const XSD_NS = "http://www.w3.org/2001/XMLSchema#";
export const LDP_NS = "http://www.w3.org/ns/ldp#";
export const ACL_NS = "http://www.w3.org/ns/auth/acl#";
export const FOAF_NS = "http://xmlns.com/foaf/0.1/";
export const DCTERMS_NS = "http://purl.org/dc/terms/";
export const VCARD_NS = "http://www.w3.org/2006/vcard/ns#";
export const SOLID_NS = "http://www.w3.org/ns/solid/terms#";

// ---------------------------------------------------------------------------
// AD4M Ontology Terms
// ---------------------------------------------------------------------------

export const ad4m = {
    LinkExpression: `${AD4M_NS}LinkExpression`,
    author: `${AD4M_NS}author`,
    timestamp: `${AD4M_NS}timestamp`,
    proofSignature: `${AD4M_NS}proofSignature`,
    proofKey: `${AD4M_NS}proofKey`,
    Neighbourhood: `${AD4M_NS}Neighbourhood`,
    linkLanguageHash: `${AD4M_NS}linkLanguageHash`,
    sdnaPattern: `${AD4M_NS}sdnaPattern`,
    hasDID: `${AD4M_NS}hasDID`,

    // --- diff-DAG (convergence substrate) ---
    /** rdf:type of a diff-commit node in the emulated DAG. */
    DiffCommit: `${AD4M_NS}DiffCommit`,
    /** Parent pointer(s): a commit's `ad4m:previous` triples form the causal DAG. */
    previous: `${AD4M_NS}previous`,
    /** Links added by a commit (object = the reified addition node). */
    addition: `${AD4M_NS}addition`,
    /** First-class removals: object = a tombstone node carrying the original link hash. */
    removal: `${AD4M_NS}removal`,
    /** rdf:type of a tombstone node. */
    Tombstone: `${AD4M_NS}Tombstone`,
    /** The content hash of the link a tombstone removes (matches the original add). */
    removesLinkHash: `${AD4M_NS}removesLinkHash`,
    /** Convenience: the content hash of an addition's link (for OR-Set keying). */
    linkHash: `${AD4M_NS}linkHash`,
} as const;

export const rdf = {
    type: `${RDF_NS}type`,
    subject: `${RDF_NS}subject`,
    predicate: `${RDF_NS}predicate`,
    object: `${RDF_NS}object`,
} as const;

export const xsd = {
    dateTime: `${XSD_NS}dateTime`,
    string: `${XSD_NS}string`,
} as const;

export const ldp = {
    BasicContainer: `${LDP_NS}BasicContainer`,
    Container: `${LDP_NS}Container`,
    Resource: `${LDP_NS}Resource`,
    contains: `${LDP_NS}contains`,
} as const;

export const acl = {
    Authorization: `${ACL_NS}Authorization`,
    agent: `${ACL_NS}agent`,
    agentClass: `${ACL_NS}agentClass`,
    agentGroup: `${ACL_NS}agentGroup`,
    accessTo: `${ACL_NS}accessTo`,
    default_: `${ACL_NS}default`,
    mode: `${ACL_NS}mode`,
    Read: `${ACL_NS}Read`,
    Write: `${ACL_NS}Write`,
    Control: `${ACL_NS}Control`,
    Append: `${ACL_NS}Append`,
} as const;

export const foaf = {
    Agent: `${FOAF_NS}Agent`,
} as const;

export const vcard = {
    Group: `${VCARD_NS}Group`,
    hasMember: `${VCARD_NS}hasMember`,
} as const;

// ---------------------------------------------------------------------------
// Prefix Map (for Turtle serialization)
// ---------------------------------------------------------------------------

export const DEFAULT_PREFIXES: Record<string, string> = {
    "ad4m": AD4M_NS,
    "rdf": RDF_NS,
    "xsd": XSD_NS,
    "ldp": LDP_NS,
    "acl": ACL_NS,
    "foaf": FOAF_NS,
    "dcterms": DCTERMS_NS,
    "vcard": VCARD_NS,
    "solid": SOLID_NS,
};

/**
 * Compact a full URI to prefixed form if a matching prefix exists.
 * Returns the original URI if no prefix matches.
 */
export function compactUri(uri: string, prefixes: Record<string, string> = DEFAULT_PREFIXES): string {
    for (const [prefix, ns] of Object.entries(prefixes)) {
        if (uri.startsWith(ns)) {
            return `${prefix}:${uri.slice(ns.length)}`;
        }
    }
    return uri;
}

/**
 * Expand a prefixed name to a full URI.
 * Returns the original string if no prefix matches.
 */
export function expandPrefixedName(prefixed: string, prefixes: Record<string, string> = DEFAULT_PREFIXES): string {
    const colonIdx = prefixed.indexOf(":");
    if (colonIdx === -1) return prefixed;
    const prefix = prefixed.slice(0, colonIdx);
    const local = prefixed.slice(colonIdx + 1);
    const ns = prefixes[prefix];
    if (ns) return `${ns}${local}`;
    return prefixed;
}

/**
 * Generate the @prefix declarations block for Turtle output.
 */
export function prefixBlock(prefixes: Record<string, string> = DEFAULT_PREFIXES): string {
    return Object.entries(prefixes)
        .map(([prefix, uri]) => `@prefix ${prefix}: <${uri}> .`)
        .join("\n");
}
