/**
 * RDF serialization/parsing — runtime-aware wrapper.
 *
 * Re-exports pure functions and adds convenience methods that
 * use the runtime adapter for hashing.
 *
 * No ad4m:host imports — uses injected adapters only.
 */

import { getRuntime } from "./runtime-interface.js";
import {
    parseTurtle,
    triplesToTurtle,
    findSubjects,
    getObject,
    getObjects,
    getTriplesBySubject,
} from "./rdf.pure.js";
import type { RdfGraph, RdfTriple } from "./rdf.pure.js";

// Re-export pure functions
export {
    parseTurtle,
    triplesToTurtle,
    findSubjects,
    getObject,
    getObjects,
    getTriplesBySubject,
};
export type { RdfGraph, RdfTriple };

/**
 * Hash a Turtle document for content addressing.
 */
export function hashTurtle(turtle: string): string {
    return getRuntime().hash(turtle);
}

/**
 * Parse Turtle and return typed graph with content hash.
 */
export function parseTurtleWithHash(turtle: string, baseUrl: string = ""): { graph: RdfGraph; hash: string } {
    const graph = parseTurtle(turtle, baseUrl);
    const contentHash = hashTurtle(turtle);
    return { graph, hash: contentHash };
}
