/**
 * # Solid Link Language for AD4M
 *
 * Bridge language that gives a Perspective genuine perspective-sync
 * convergence on top of Solid Pods (Linked Data Platform).
 *
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Solid/LDP has no native causal history, so this language emulates a
 * content-addressed diff-DAG in the pod: each commit is an immutable
 * resource named by its content hash, carrying ad4m:previous pointers to
 * its parent commit(s). Folding that DAG (an OR-Set keyed by link content
 * hash, with removals as tombstones) is the source of truth; the RDF link
 * view is a derived projection. Sync walks the ad4m:previous chain rather
 * than snapshot-diffing the container, and currentRevision is derived from
 * the DAG head set (never the container ETag).
 *
 * Spec: solid-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { SolidSettings } from "./src/settings.js";
import * as store from "./src/store.js";
import { buildCommit, commitToTurtle } from "./src/diffdag.js";
import { syncFromPod, fullSync } from "./src/sync.js";
import { ldpPut, ldpHead, ldpGet, resourceExists, fetchTurtle } from "./src/ldp.js";
import { diffsContainerUrl, diffResourceUrl, joinPodPath } from "./src/ldp.js";
import {
    viewsContainerUrl,
    viewResourceUrl,
    extractViewSlug,
    extractContainedResources,
} from "./src/ldp.js";
import { getAuthToken } from "./src/auth.js";
import { triplesToTurtle, parseTurtle, getObjects } from "./src/rdf.js";
import { DEFAULT_PREFIXES, ldp as ldpTerms } from "./src/ontology.js";

// Channel-B (Role B) projection — SHACL-driven native RDF ⇄ graph transform.
import { makeSolidAdapter, type RdfResource } from "./src/solid-projection.js";
import {
    parseProfiles,
    projectInstances,
    ingestNative,
    toAuthoredLink,
    type ProjectionProfile,
} from "./src/projection/index.js";

// Adapter imports
import { initTransport, getTransport, initStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §9)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const SOLID_POD_URL = "<to-be-filled>";

//!@ad4m-template-variable
const SOLID_CONTAINER_PATH = "<to-be-filled>";

//!@ad4m-template-variable
const SOLID_IDP_URL = "<to-be-filled>";

//!@ad4m-template-variable
const SOLID_WEBID = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: SolidSettings;

/** The pod container holding the immutable diff-commit DAG resources. */
function diffsContainer(): string {
    return diffsContainerUrl(SOLID_POD_URL, SOLID_CONTAINER_PATH);
}

/** The pod container holding the human-facing Channel-B projection resources. */
function viewsContainer(): string {
    return viewsContainerUrl(SOLID_POD_URL, SOLID_CONTAINER_PATH);
}

function authToken(): string | null {
    return getAuthToken(settings);
}

// ---------------------------------------------------------------------------
// Channel-B (Role B) projection wiring
//
// Solid is the NEAR-IDENTITY case: an AD4M subject-class instance already IS
// RDF, and Solid stores RDF. So Channel B does not translate into a foreign
// content schema (contrast Matrix/Nostr/Bluesky, whose native content is a chat
// or post record) — it re-expresses SHACL-annotated instances as clean,
// app-legible RDF resources under `views/`, so a Solid-native client (SolidOS, a
// generic LDP/RDF browser) renders each instance directly (`<base> sioc:content
// "text"`) rather than wading through Channel A's `ad4m:`-reified diff-commit
// envelope. The convergence DAG stays authoritative on Channel A; these view
// resources are derived and never read back as link truth — except for
// genuinely native-authored resources (an RDF resource a human dropped into
// `views/` with no backing commit), which are ingested into Channel A as new
// links exactly like a local commit.
// ---------------------------------------------------------------------------

/**
 * The single reference Channel-B adapter (RDF resource ⇄ Projection). A Solid
 * profile's `nativeType` is the class URI it projects, so the adapter is
 * instantiated per native type on demand.
 */
const adapterFor = (nativeType: string): ReturnType<typeof makeSolidAdapter> =>
    makeSolidAdapter(nativeType);

/** Cached projection profiles; invalidated whenever SHACL shape links change. */
let cachedProfiles: ProjectionProfile[] | null = null;

/**
 * The projection profiles active for this perspective. Parsed from any
 * `projection://`-annotated SHACL shapes present in the link store, falling back
 * to the built-in Flux-message profile so a stock Flux community projects even
 * before its SDNA carries explicit annotations.
 *
 * For Solid the profile's `nativeType` is a CLASS URI and each field's
 * `nativeField` is the RDF PREDICATE URI the value carries (the near-identity):
 * the default profile below emits `<base> sioc:content "text"` for a Flux
 * message body.
 */
function projectionProfiles(): ProjectionProfile[] {
    if (cachedProfiles) return cachedProfiles;
    const shapeLinks = store.allLinks().links.map((l) => ({
        source: l.data.source ?? "",
        predicate: l.data.predicate ?? "",
        target: l.data.target ?? "",
    }));
    const parsed = parseProfiles(shapeLinks);
    // Guarantee a message profile so Flux always projects a human-facing RDF
    // resource even without SDNA `projection://` annotations.
    cachedProfiles = parsed.some((p) => p.nativeType === SOLID_MESSAGE_CLASS)
        ? parsed
        : [...parsed, defaultSolidMessageProfile()];
    return cachedProfiles;
}

/** True if a diff adds/removes any SHACL shape or projection annotation link. */
function diffTouchesShapes(diff: PerspectiveDiff): boolean {
    const isShapePred = (p?: string) =>
        !!p && (p.startsWith("sh://") || p.startsWith("projection://") || p === "rdf://type");
    return diff.additions.some((l) => isShapePred(l.data.predicate)) ||
        diff.removals.some((l) => isShapePred(l.data.predicate));
}

function invalidateProfilesIfShapes(diff: PerspectiveDiff): void {
    if (diffTouchesShapes(diff)) cachedProfiles = null;
}

/**
 * The default Solid projection profile for a Flux chat message.
 *
 * Flux emits a message as `msg --flux://entry_type--> flux://has_message` (the
 * type flag) and `msg --flux://body--> literal:string:<text>` (the content).
 * The body projects onto the RDF predicate `sioc://content` on the message's
 * subject URI — so the human-facing resource reads `<msg> sioc:content "text"`,
 * the shape a Solid-native SIOC client expects.
 */
function defaultSolidMessageProfile(): ProjectionProfile {
    return {
        nodeShapeUri: "flux://MessageShape",
        targetClass: "flux://Message",
        nativeType: SOLID_MESSAGE_CLASS,
        flags: [{ path: "flux://entry_type", value: "flux://has_message" }],
        fields: [
            {
                nativeField: SIOC_CONTENT,
                path: "flux://body",
                datatype: "http://www.w3.org/2001/XMLSchema#string",
            },
        ],
    };
}

/** SIOC Post class URI — the native type of a projected Flux message resource. */
const SOLID_MESSAGE_CLASS = "http://rdfs.org/sioc/ns#Post";
/** SIOC content predicate — carries the message body on the resource subject. */
const SIOC_CONTENT = "http://rdfs.org/sioc/ns#content";

/**
 * Render the SHACL-projected additions of a diff as human-facing RDF resources
 * and PUT each into the pod's `views/` container. One resource per matched
 * subject instance, named by a slug derived from its subject URI so re-projecting
 * overwrites in place. Never reads its output back — the DAG stays authoritative.
 */
async function projectDiffToViews(diff: PerspectiveDiff): Promise<void> {
    const authored = diff.additions.map(toAuthoredLink);
    const projected = projectInstances<RdfResource>(authored, projectionProfiles(), adapterFor);
    if (projected.length === 0) return;

    const token = authToken();
    await ensureViewsContainerExists();
    const hashFn = store.getHashFn();

    for (const p of projected) {
        const turtle = triplesToTurtle(p.native.triples, DEFAULT_PREFIXES);
        const slug = hashFn(p.native.subject);
        const resourceUrl = viewResourceUrl(viewsContainer(), slug);
        await ldpPut(resourceUrl, turtle, "text/turtle", token || undefined);
    }
}

let viewsContainerInitialized = false;

/** Ensure the `views/` projection container exists (mirrors diffs/ creation). */
async function ensureViewsContainerExists(): Promise<void> {
    if (viewsContainerInitialized) return;
    const cUrl = viewsContainer();
    const token = authToken();

    const exists = await resourceExists(cUrl, token || undefined);
    if (exists) {
        viewsContainerInitialized = true;
        return;
    }

    const headers: Record<string, string> = {
        "Content-Type": "text/turtle",
        "Link": '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const body = `@prefix dcterms: <http://purl.org/dc/terms/> .\n\n<> dcterms:title "AD4M Projection Views" .\n`;
    const resp = await getTransport().fetch(cUrl, "PUT", headers, body);
    if (resp.status >= 200 && resp.status < 300) {
        viewsContainerInitialized = true;
    } else {
        console.error(`[solid-link-language] failed to create views container: ${resp.status}`);
    }
}

/**
 * Publish a locally-produced diff on Role A: append an immutable diff-commit to
 * the DAG, refresh the derived caches, PUT the commit resource, and emit the diff
 * to the executor. Used for genuinely native-authored RDF resources ingested
 * through Channel B, which must become authoritative links exactly like a local
 * commit.
 */
async function publishDiffRoleA(diff: PerspectiveDiff): Promise<void> {
    const hashFn = store.getHashFn();
    const parents = store.getHeads();
    const commit = buildCommit(diff, parents, myDid, new Date().toISOString(), hashFn);
    const commitHash = store.hashCommit(commit);

    store.addCommitToDag(commitHash, commit);
    store.rebuildLinksFromDag();
    invalidateProfilesIfShapes(diff);

    emitPerspectiveDiff(diff);
    if (settings.syncMode === "subscribe-only") return;

    const token = authToken();
    await ensureContainerExists();
    const turtle = commitToTurtle(commit, hashFn);
    const resourceUrl = diffResourceUrl(diffsContainer(), commitHash);
    await ldpPut(resourceUrl, turtle, "text/turtle", token || undefined);
}

/**
 * Role-B inbound — ingest genuinely native-authored RDF resources (ones a human
 * or non-AD4M Solid app dropped into `views/` with no backing commit) into
 * Channel A as new links.
 *
 * A resource authored via our own projection is skipped: its subject already
 * arrived authoritatively on Channel A (folded before this runs), so its
 * constituent links are already present — re-ingesting would be a no-op but we
 * skip it by that check anyway. Idempotent by subject: a resource whose links are
 * already in the store never double-ingests.
 */
async function ingestNativeViews(): Promise<void> {
    if (settings.syncMode === "publish-only") return;

    const token = authToken();
    const cUrl = viewsContainer();
    const listing = await fetchTurtle(cUrl, token || undefined);
    if (!listing) return;

    const containerGraph = parseTurtle(listing, cUrl);
    const contained = getObjects(containerGraph, cUrl, ldpTerms.contains);
    const urls = extractContainedResources(cUrl, contained);

    const additions: LinkExpression[] = [];
    const profiles = projectionProfiles();

    for (const url of urls) {
        if (extractViewSlug(url) === null) continue;
        const body = await fetchTurtle(url, token || undefined);
        if (!body) continue;

        const graph = parseTurtle(body, url);
        // The resource's subject is the resolved base of the document (`<>`).
        const subject = resolveResourceSubject(graph, url);
        if (!subject) continue;

        const resource: RdfResource = { subject, triples: graph.triples };
        const ingested = ingestNative<RdfResource>(resource, profiles, adapterFor, {});
        if (!ingested) continue;

        const author = ingested.author ?? `solid:${subject}`;
        const timestamp = ingested.timestamp ?? new Date().toISOString();

        // Skip resources whose constituent links are already present (our own
        // projection, or an already-ingested native resource).
        const alreadyPresent = ingested.links.every((link) => {
            const existing = store.queryLinks({
                source: link.source,
                predicate: link.predicate,
                target: link.target,
            });
            return existing.length > 0;
        });
        if (alreadyPresent) continue;

        for (const link of ingested.links) {
            additions.push({
                author,
                timestamp,
                data: { source: link.source, target: link.target, predicate: link.predicate },
                proof: { signature: "", key: "" },
            });
        }
    }

    if (additions.length > 0) {
        await publishDiffRoleA({ additions, removals: [] });
    }
}

/**
 * Resolve the subject URI a projection view resource is primarily about. The
 * Turtle parser resolves the document's `<>` to `baseUrl`; a view resource
 * describes exactly one subject (its own URI), so prefer the base URL if it is a
 * subject in the graph, else the first typed subject.
 */
function resolveResourceSubject(
    graph: ReturnType<typeof parseTurtle>,
    baseUrl: string,
): string | null {
    if (graph.triples.some((t) => t.subject === baseUrl)) return baseUrl;
    const typed = graph.triples.find(
        (t) => t.predicate === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    );
    return typed ? typed.subject : null;
}

// ---------------------------------------------------------------------------
// Container initialization
// ---------------------------------------------------------------------------

let containerInitialized = false;

/**
 * Ensure the LDP container exists, creating it if necessary.
 * CSS creates containers when you PUT with the right Link header for LDP BasicContainer.
 */
async function ensureContainerExists(): Promise<void> {
    if (containerInitialized) return;

    const cUrl = diffsContainer();
    const token = authToken();

    // Check if the diffs/ container already exists.
    const exists = await resourceExists(cUrl, token || undefined);
    if (exists) {
        containerInitialized = true;
        return;
    }

    const containerHeaders = (): Record<string, string> => {
        const h: Record<string, string> = {
            "Content-Type": "text/turtle",
            "Link": '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        };
        if (token) h["Authorization"] = `Bearer ${token}`;
        return h;
    };

    // Create the parent container first. joinPodPath normalises slashes so a
    // pod URL with no trailing slash and a container path with no leading slash
    // cannot concatenate into an invalid URL (see joinPodPath in src/ldp.ts).
    const parentUrl = joinPodPath(SOLID_POD_URL, SOLID_CONTAINER_PATH);
    const parentExists = await resourceExists(parentUrl, token || undefined);
    if (!parentExists) {
        console.log(`[solid-link-language] creating parent container: ${parentUrl}`);
        const parentBody = `@prefix dcterms: <http://purl.org/dc/terms/> .\n\n<> dcterms:title "AD4M Container" .\n`;
        const parentResp = await ldpPut(parentUrl, parentBody, "text/turtle", token || undefined);
        console.log(`[solid-link-language] parent container PUT: ${parentResp.status}`);
    }

    // Create the diffs/ container (holds the immutable diff-commit DAG).
    console.log(`[solid-link-language] creating diffs container: ${cUrl}`);
    const diffsBody = `@prefix dcterms: <http://purl.org/dc/terms/> .\n\n<> dcterms:title "AD4M Diff-DAG" .\n`;
    const diffsResp = await getTransport().fetch(cUrl, "PUT", containerHeaders(), diffsBody);
    console.log(`[solid-link-language] diffs container PUT: ${diffsResp.status}`);

    if (diffsResp.status >= 200 && diffsResp.status < 300) {
        containerInitialized = true;
    } else {
        console.error(`[solid-link-language] failed to create container: ${diffsResp.status} ${diffsResp.body}`);
    }
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/solid-link-language",
    version: "0.1.0",

    isPublic: true,

    async init() {
        // Initialize adapters before anything else
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());

        console.log(`[solid-link-language] init: did=${myDid}`);
        console.log(`[solid-link-language] pod: ${SOLID_POD_URL}`);
        console.log(`[solid-link-language] container: ${SOLID_CONTAINER_PATH}`);
        console.log(`[solid-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[solid-link-language] membership: ${settings.membership}`);
        console.log(`[solid-link-language] rendering: ${settings.rendering.strategy}`);

        // Ensure container exists on init
        if (SOLID_POD_URL !== "<to-be-filled>" && SOLID_CONTAINER_PATH !== "<to-be-filled>") {
            try {
                await ensureContainerExists();
            } catch (err) {
                console.error(`[solid-link-language] failed to ensure container: ${err}`);
            }
        }
    },

    async teardown() {
        myDid = "";
        console.log("[solid-link-language] teardown");
    },

    interactions() {
        return [];
    },

    // -----------------------------------------------------------------------
    // perspective-commit — append an immutable diff-commit to the DAG
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            const hashFn = store.getHashFn();

            // 1. Build a diff-commit whose parents are the current DAG heads.
            //    Removals become tombstones carrying the ORIGINAL link hash, so
            //    they converge against the original add on every replica.
            const parents = store.getHeads();
            const commit = buildCommit(
                diff,
                parents,
                myDid,
                new Date().toISOString(),
                hashFn,
            );
            const commitHash = store.hashCommit(commit);

            // 2. Ingest into the local DAG (source of truth) and rebuild the
            //    derived link cache by folding. currentRevision now follows the
            //    new head automatically.
            store.addCommitToDag(commitHash, commit);
            store.rebuildLinksFromDag();

            // Keep the projection profile cache in step if this diff touched any
            // SHACL shape / projection annotation.
            invalidateProfilesIfShapes(diff);

            // 3. Emit for local subscribers regardless of sync direction.
            emitPerspectiveDiff(diff);
            if (settings.syncMode === "subscribe-only") {
                return commitHash;
            }

            const token = authToken();
            await ensureContainerExists();

            // ------------------------------------------------------------------
            // ROLE A — publish the immutable diff-commit resource to the pod. It
            // is named by its content hash and carries ad4m:previous pointers,
            // forming the content-hash DAG in the pod. We never PUT/DELETE
            // per-link resources — the DAG is append-only, so history and
            // concurrent removals survive. This is the authoritative substrate.
            // ------------------------------------------------------------------
            const turtle = commitToTurtle(commit, hashFn);
            const resourceUrl = diffResourceUrl(diffsContainer(), commitHash);
            await ldpPut(resourceUrl, turtle, "text/turtle", token || undefined);

            // ------------------------------------------------------------------
            // ROLE B — near-identity native projection (derived, never truth).
            // Re-express SHACL-projected subject instances as clean, human-facing
            // RDF resources under views/, so a Solid-native client renders them
            // directly. Because Solid stores RDF, this is a near-identity view of
            // the same instance — NOT a translation into a foreign schema — and
            // it carries NO ad4m: reification (that rides Channel A above). It is
            // reconstructed from Role A and never parsed back as link truth.
            // ------------------------------------------------------------------
            await projectDiffToViews(diff);

            return commitHash;
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            if (settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }

            // ------------------------------------------------------------------
            // ROLE A — walk the authoritative diff-DAG and fold it. This is the
            // source of truth: syncFromPod discovers the commit resources, pulls
            // any missing ancestors, re-folds with OR-Set semantics, and returns
            // the incremental PerspectiveDiff.
            // ------------------------------------------------------------------
            const diff = await syncFromPod(
                SOLID_POD_URL,
                SOLID_CONTAINER_PATH,
                authToken() || undefined,
            );

            // Keep the projection cache fresh if the folded diff changed shapes.
            invalidateProfilesIfShapes(diff);

            // ------------------------------------------------------------------
            // ROLE B — ingest genuinely native-authored RDF resources. A human
            // (or a non-AD4M Solid app) may drop a resource into views/ with no
            // backing commit; we parse those and enter them into Channel A as new
            // authoritative links. Resources produced by our own projection are
            // already present on Channel A, so they are skipped as no-ops. This
            // reverse path is meaningful for Solid precisely because native RDF is
            // first-class here — a native writer's edits are real graph data.
            // ------------------------------------------------------------------
            await ingestNativeViews();

            return diff;
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision(): Promise<string | null> {
            // Content hash of the DAG head(s). Null when the DAG is empty.
            return store.getRevision();
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports (required by the AD4M runtime dispatcher)
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    interactions,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal-based handler
// ---------------------------------------------------------------------------

export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return;
    }

    // Handle notifications from Solid Notifications Protocol
    const notification = signal as { type?: string; object?: string };
    if (notification.type === "Update" || notification.type === "Create") {
        // A resource was created or updated — walk the DAG and fold. syncFromPod
        // pushes any newly-folded links to the executor via emitPerspectiveDiff
        // (the same host channel the periodic sync() relies on), so no separate
        // linkCallback notification is needed — issuing one too would double-apply
        // the same inbound delta.
        await syncFromPod(
            SOLID_POD_URL,
            SOLID_CONTAINER_PATH,
            authToken() || undefined,
        );
    }
}
