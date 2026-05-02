/**
 * Pure RDF Turtle serializer/parser for AD4M link triples.
 *
 * Minimal Turtle parser handling ONLY the subset needed for AD4M:
 * - Prefixed names (ad4m:LinkExpression, rdf:subject, etc.)
 * - URI references (<https://...>)
 * - Literal strings (plain + typed with ^^)
 * - Period-terminated statements
 * - Semicolon property lists
 * - @prefix declarations
 *
 * Pure functions — no ad4m:host imports. ~250 lines of code.
 */

import { DEFAULT_PREFIXES, expandPrefixedName, AD4M_NS, RDF_NS, XSD_NS } from "./ontology.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RdfTriple {
    subject: string;
    predicate: string;
    object: string;
    /** True if the object is a literal (string value) rather than a URI */
    objectIsLiteral: boolean;
    /** Datatype URI for typed literals (e.g. xsd:dateTime) */
    objectDatatype?: string;
}

export interface RdfGraph {
    prefixes: Record<string, string>;
    triples: RdfTriple[];
}

// ---------------------------------------------------------------------------
// Turtle Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a single RDF triple to Turtle fragment (no prefix declarations).
 */
export function tripleToTurtle(triple: RdfTriple): string {
    const subject = formatTerm(triple.subject);
    const predicate = triple.predicate === `${RDF_NS}type`
        ? "a"
        : formatTerm(triple.predicate);
    const object = triple.objectIsLiteral
        ? formatLiteral(triple.object, triple.objectDatatype)
        : formatTerm(triple.object);
    return `${subject} ${predicate} ${object}`;
}

/**
 * Group triples by subject and serialize with semicolon property lists.
 */
export function triplesToTurtle(
    triples: RdfTriple[],
    prefixes: Record<string, string> = DEFAULT_PREFIXES,
): string {
    const lines: string[] = [];

    // Prefix declarations
    for (const [prefix, uri] of Object.entries(prefixes)) {
        lines.push(`@prefix ${prefix}: <${uri}> .`);
    }
    if (Object.keys(prefixes).length > 0) {
        lines.push("");
    }

    // Group by subject
    const grouped = new Map<string, RdfTriple[]>();
    for (const triple of triples) {
        const existing = grouped.get(triple.subject);
        if (existing) {
            existing.push(triple);
        } else {
            grouped.set(triple.subject, [triple]);
        }
    }

    // Serialize each subject group
    for (const [_subject, subjectTriples] of grouped) {
        for (let i = 0; i < subjectTriples.length; i++) {
            const triple = subjectTriples[i];
            const predicate = triple.predicate === `${RDF_NS}type`
                ? "a"
                : formatTerm(triple.predicate);
            const object = triple.objectIsLiteral
                ? formatLiteral(triple.object, triple.objectDatatype)
                : formatTerm(triple.object);

            if (i === 0) {
                const terminator = subjectTriples.length === 1 ? " ." : " ;";
                lines.push(`${formatTerm(triple.subject)} ${predicate} ${object}${terminator}`);
            } else {
                const terminator = i === subjectTriples.length - 1 ? " ." : " ;";
                lines.push(`    ${predicate} ${object}${terminator}`);
            }
        }
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

/**
 * Format a URI/term for Turtle output.
 * Uses prefixed form if it starts with a known namespace, otherwise <uri>.
 */
export function formatTerm(uri: string): string {
    for (const [prefix, ns] of Object.entries(DEFAULT_PREFIXES)) {
        if (uri.startsWith(ns)) {
            return `${prefix}:${uri.slice(ns.length)}`;
        }
    }
    return `<${uri}>`;
}

/**
 * Format a literal value for Turtle output.
 */
export function formatLiteral(value: string, datatype?: string): string {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    if (datatype && datatype !== `${XSD_NS}string`) {
        return `"${escaped}"^^${formatTerm(datatype)}`;
    }
    return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Turtle Parser
// ---------------------------------------------------------------------------

interface ParseState {
    input: string;
    pos: number;
    prefixes: Record<string, string>;
    triples: RdfTriple[];
}

/**
 * Parse a Turtle document into an RdfGraph.
 *
 * Handles the subset of Turtle used by the AD4M ontology:
 * - @prefix declarations
 * - URI references in angle brackets
 * - Prefixed names
 * - String literals (with optional ^^type)
 * - 'a' shorthand for rdf:type
 * - Semicolon property lists
 * - Period-terminated statements
 */
export function parseTurtle(input: string, baseUrl: string = ""): RdfGraph {
    const state: ParseState = {
        input,
        pos: 0,
        prefixes: { ...DEFAULT_PREFIXES },
        triples: [],
    };

    while (state.pos < state.input.length) {
        skipWhitespaceAndComments(state);
        if (state.pos >= state.input.length) break;

        if (state.input.startsWith("@prefix", state.pos)) {
            parsePrefix(state);
        } else if (state.input[state.pos] === "#" || state.input[state.pos] === "\n") {
            state.pos++;
        } else {
            parseTripleBlock(state, baseUrl);
        }
    }

    return { prefixes: state.prefixes, triples: state.triples };
}

function skipWhitespaceAndComments(state: ParseState): void {
    while (state.pos < state.input.length) {
        const ch = state.input[state.pos];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            state.pos++;
        } else if (ch === "#") {
            // Line comment
            while (state.pos < state.input.length && state.input[state.pos] !== "\n") {
                state.pos++;
            }
        } else {
            break;
        }
    }
}

function parsePrefix(state: ParseState): void {
    // @prefix prefix: <uri> .
    state.pos += 7; // skip "@prefix"
    skipWhitespaceAndComments(state);
    const prefix = readUntil(state, ":").trim();
    state.pos++; // skip ':'
    skipWhitespaceAndComments(state);
    const uri = readUri(state);
    skipWhitespaceAndComments(state);
    if (state.input[state.pos] === ".") state.pos++;
    state.prefixes[prefix] = uri;
}

function parseTripleBlock(state: ParseState, baseUrl: string): void {
    skipWhitespaceAndComments(state);
    if (state.pos >= state.input.length) return;

    const startPos = state.pos;
    const subject = readTerm(state, baseUrl);
    if (subject === null) {
        // Could not parse a subject — skip this character to avoid infinite loop
        if (state.pos === startPos) state.pos++;
        return;
    }

    // Property list (predicate-object pairs separated by ';')
    while (state.pos < state.input.length) {
        skipWhitespaceAndComments(state);
        if (state.pos >= state.input.length) break;

        const ch = state.input[state.pos];
        if (ch === ".") {
            state.pos++;
            break;
        }
        if (ch === ";") {
            state.pos++;
            skipWhitespaceAndComments(state);
            // Check for trailing semicolon before period
            if (state.pos < state.input.length && state.input[state.pos] === ".") {
                state.pos++;
                break;
            }
            continue;
        }

        const predicate = readTerm(state, baseUrl);
        if (predicate === null) {
            // Recovery: skip to next period
            skipToNextPeriod(state);
            break;
        }

        skipWhitespaceAndComments(state);
        const objectResult = readObject(state, baseUrl);
        if (!objectResult) {
            // Recovery: skip to next period
            skipToNextPeriod(state);
            break;
        }

        state.triples.push({
            subject,
            predicate,
            object: objectResult.value,
            objectIsLiteral: objectResult.isLiteral,
            objectDatatype: objectResult.datatype,
        });

        // Handle object lists (comma-separated)
        while (state.pos < state.input.length) {
            skipWhitespaceAndComments(state);
            if (state.pos >= state.input.length) break;
            if (state.input[state.pos] !== ",") break;
            state.pos++; // skip comma
            skipWhitespaceAndComments(state);
            const nextObj = readObject(state, baseUrl);
            if (!nextObj) break;
            state.triples.push({
                subject,
                predicate,
                object: nextObj.value,
                objectIsLiteral: nextObj.isLiteral,
                objectDatatype: nextObj.datatype,
            });
        }
    }
}

/**
 * Recovery helper: skip forward to the next period (statement terminator).
 */
function skipToNextPeriod(state: ParseState): void {
    while (state.pos < state.input.length && state.input[state.pos] !== ".") {
        state.pos++;
    }
    if (state.pos < state.input.length) state.pos++; // skip the period
}

interface ObjectValue {
    value: string;
    isLiteral: boolean;
    datatype?: string;
}

function readObject(state: ParseState, baseUrl: string): ObjectValue | null {
    skipWhitespaceAndComments(state);
    if (state.pos >= state.input.length) return null;

    if (state.input[state.pos] === '"') {
        return readLiteral(state);
    }

    const term = readTerm(state, baseUrl);
    if (!term) return null;
    return { value: term, isLiteral: false };
}

function readLiteral(state: ParseState): ObjectValue {
    state.pos++; // skip opening "
    let value = "";
    while (state.pos < state.input.length && state.input[state.pos] !== '"') {
        if (state.input[state.pos] === "\\" && state.pos + 1 < state.input.length) {
            state.pos++;
            const escaped = state.input[state.pos];
            if (escaped === "n") value += "\n";
            else if (escaped === "t") value += "\t";
            else if (escaped === "\\") value += "\\";
            else if (escaped === '"') value += '"';
            else value += escaped;
        } else {
            value += state.input[state.pos];
        }
        state.pos++;
    }
    if (state.pos < state.input.length) state.pos++; // skip closing "

    // Check for datatype
    let datatype: string | undefined;
    if (state.pos + 1 < state.input.length && state.input[state.pos] === "^" && state.input[state.pos + 1] === "^") {
        state.pos += 2;
        datatype = readTerm(state, "") ?? undefined;
    }

    return { value, isLiteral: true, datatype };
}

function readTerm(state: ParseState, baseUrl: string): string | null {
    skipWhitespaceAndComments(state);
    if (state.pos >= state.input.length) return null;

    const ch = state.input[state.pos];

    // 'a' shorthand for rdf:type
    if (ch === "a" && (state.pos + 1 >= state.input.length || /[\s;.,]/.test(state.input[state.pos + 1]))) {
        state.pos++;
        return `${RDF_NS}type`;
    }

    // URI reference
    if (ch === "<") {
        const uri = readUri(state);
        if (uri === "") {
            // <> means the base URL
            return baseUrl;
        }
        if (uri.startsWith("#") || uri.startsWith("./") || uri.startsWith("../")) {
            return baseUrl + uri;
        }
        return uri;
    }

    // Prefixed name
    const start = state.pos;
    while (state.pos < state.input.length && !/[\s;.,\])]/.test(state.input[state.pos])) {
        state.pos++;
    }
    const token = state.input.slice(start, state.pos);
    if (!token) return null;

    return expandPrefixedName(token, state.prefixes);
}

function readUri(state: ParseState): string {
    state.pos++; // skip '<'
    let uri = "";
    while (state.pos < state.input.length && state.input[state.pos] !== ">") {
        uri += state.input[state.pos];
        state.pos++;
    }
    if (state.pos < state.input.length) state.pos++; // skip '>'
    return uri;
}

function readUntil(state: ParseState, char: string): string {
    let result = "";
    while (state.pos < state.input.length && state.input[state.pos] !== char) {
        result += state.input[state.pos];
        state.pos++;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Graph Query Helpers
// ---------------------------------------------------------------------------

/**
 * Find all subjects that have a specific predicate-object pair.
 */
export function findSubjects(graph: RdfGraph, predicate: string, object: string): string[] {
    return graph.triples
        .filter(t => t.predicate === predicate && t.object === object)
        .map(t => t.subject);
}

/**
 * Get the object value for a given subject-predicate pair.
 * Returns the first match or undefined.
 */
export function getObject(graph: RdfGraph, subject: string, predicate: string): string | undefined {
    const triple = graph.triples.find(t => t.subject === subject && t.predicate === predicate);
    return triple?.object;
}

/**
 * Get all object values for a given subject-predicate pair.
 */
export function getObjects(graph: RdfGraph, subject: string, predicate: string): string[] {
    return graph.triples
        .filter(t => t.subject === subject && t.predicate === predicate)
        .map(t => t.object);
}

/**
 * Get all triples for a given subject.
 */
export function getTriplesBySubject(graph: RdfGraph, subject: string): RdfTriple[] {
    return graph.triples.filter(t => t.subject === subject);
}
