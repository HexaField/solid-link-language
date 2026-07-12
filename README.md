# Solid Link Language for AD4M

An AD4M link language that gives a Perspective genuine **`perspective-sync`
convergence** on top of a Solid pod. Solid/LDP is a plain document store with no
native causal history, so this language **emulates a content-addressed diff-DAG**
in the pod: every commit is an immutable resource named by its content hash,
carrying an `ad4m:previous` pointer to its parent commit(s). Folding that DAG is
the source of truth; the RDF link view is a derived projection.

## Two roles

1. **Convergence substrate (source of truth).** A content-addressed diff-DAG.
   Each commit is an immutable resource `diffs/diff-<hash>.ttl` whose body is a
   set of link additions, a set of removals (tombstones), and `ad4m:previous`
   triples pointing at the parent commit hash(es). Because commits are named by
   their content and never mutated or deleted, history and concurrent removals
   survive, and the same hash always denotes the same body.

2. **Derived link cache (projection).** A local key-value cache of the folded
   link set, kept only for fast query/render. It is fully reconstructible from
   the DAG and is never authoritative.

These map onto the two-channel architecture shared with the other AD4M link
languages (Matrix, Nostr, Bluesky): **Channel A** is the authoritative
convergence substrate above (the diff-DAG in `diffs/`); **Channel B** is a
SHACL-driven projection of subject-class instances into the protocol's
human-facing native content, written under `views/`. See
[Role B — native projection](#role-b--native-projection-shacl-driven) below —
for Solid this is a *near-identity* projection, which is the whole point.

## How convergence works

- **`commit(diff)`** builds a diff-commit whose `ad4m:previous` are the current
  DAG heads, hashes it, ingests it into the local DAG, re-folds to refresh the
  derived cache, and PUTs the immutable `diff-<hash>.ttl` resource to the pod.
  Removals are recorded as **tombstones carrying the original link's content
  hash** — never as HTTP `DELETE`.
- **`sync()`** discovers the commit resources in the pod's `diffs/` container,
  then **walks the `ad4m:previous` chain**: it fetches each head, follows parent
  pointers, and pulls any missing ancestors until the local DAG is complete. It
  re-folds and returns the diff between the pre-sync and post-sync link sets. It
  does **not** snapshot-diff the container listing or rely on container ETags.
- **Merge is an OR-Set** keyed by link content hash: the folded link set is the
  union of all added links minus those whose hash appears in a tombstone. This
  makes merges commutative — concurrent branches fold to the same link set, and
  a concurrent add+remove of the same link converges to removed — regardless of
  fetch order.
- **`currentRevision()`** is derived from the DAG head set, not the container
  ETag: `null` when the DAG is empty, the single head's commit hash when there
  is one head, and a deterministic digest of the sorted head hashes when there
  are several. It is stable for a given DAG state and across restarts.

## Role B — native projection (SHACL-driven)

Channel A above federates the *whole* perspective as reified `ad4m:` diff-commit
resources. That is perfect for convergence but opaque to a Solid-native client:
SolidOS or a generic LDP/RDF browser pointed at `diffs/diff-<hash>.ttl` sees
`ad4m:DiffCommit` / `ad4m:addition` / `ad4m:linkHash` machinery, not a legible
"a message that says hello". **Role B (Channel B)** closes that gap: it renders
each SHACL-annotated subject-class instance as a clean, human-facing RDF resource
under `views/`, so a Solid-native app renders it directly.

### Solid is the near-identity case (this is deliberate, not a shortcut)

The other link languages translate a subject instance into a *foreign* content
schema — Matrix into an `m.room.message`, Nostr into a kind-1 event, Bluesky into
an `app.bsky.feed.post` record — because their native surface is a chat/post
schema, not RDF. **Solid stores RDF, and an AD4M subject-class instance already
IS RDF.** So Channel B here is a *near-identity* projection: it does not invent a
non-RDF content schema; it re-expresses the same instance as direct
subject-predicate-object triples that a Solid-native vocabulary consumer expects.

Concretely, a Flux message that Channel A stores (reified) as

```turtle
<#add-Qm…> a ad4m:LinkExpression ;
    rdf:subject <flux://msg1> ; rdf:predicate <sioc://content> ;
    rdf:object "literal:string:Hello%20world" ; ad4m:author "did:key:alice" .
```

is projected by Channel B into the human-facing resource `views/view-<slug>.ttl`:

```turtle
<flux://msg1> a sioc:Post ;
    sioc:content "Hello world" ;
    dcterms:creator <did:key:alice> ;
    dcterms:created "2026-07-12T10:00:00.000Z"^^xsd:dateTime .
```

The literal is decoded, the AD4M reification is gone, and the class + provenance
are stated in vocabulary (`sioc:`, `dcterms:`) a Solid app reads. Which graph
predicate carries each field is decided by the SHACL projection profile: a
`projection://nativeType` annotation on a NodeShape makes the class projectable,
and each projected property's `projection://field` names the **RDF predicate**
the value rides (for Solid, `nativeField` *is* a predicate URI). Stock Flux
projects with no SDNA annotations via a built-in default profile
(`flux://body → sioc:content`, native type `sioc:Post`).

### Wiring

- **Outbound (`commit`).** After the authoritative diff-commit is published on
  Channel A, `commit` folds the diff's additions through the SHACL profiles and
  PUTs one `views/view-<slug>.ttl` per matched instance (slug = content hash of
  the subject URI, so re-projecting overwrites in place). No `ad4m:` bytes enter
  these resources; the projection is derived from Role A and never read back as
  link truth.
- **Inbound (`sync`).** Because native RDF is first-class on Solid, the reverse
  path is *meaningful* here (unlike a plain-text protocol, where it only matters
  for human-typed chat): a human or a non-AD4M Solid app may drop a genuinely
  native RDF resource into `views/` with no backing commit. `sync` parses those,
  maps them back to links via the same SHACL profile, and enters them into
  Channel A as new authoritative links (a real commit). Resources produced by our
  own projection are already present on Channel A and are skipped, so the loop is
  idempotent and never double-ingests.

### What Channel B actually adds for Solid

Honest accounting, since Solid's substrate is already RDF:

- **It is not redundant, but it is narrow.** Channel A already persists the full
  graph as native RDF — but as *reified diff-commits*, which are convergence
  plumbing, not app-legible resources. Channel B's contribution is exactly the
  transform from that reified, hash-addressed envelope to a **flat,
  vocabulary-native, human-facing resource** keyed on the instance's own subject
  URI. That view is what makes the data usable by SolidOS and generic LDP tooling.
- **The projection core is shared verbatim.** `src/projection/` is copied
  unmodified from the reference (Matrix) language; only `src/solid-projection.ts`
  (the `NativeAdapter<RdfResource>`) is Solid-specific, and it is a thin
  RDF-resource ⇄ `Projection` mapping. This keeps Solid consistent with the other
  languages' Channel-B contract at essentially zero divergence.
- **No lossy foreign schema.** Because the mapping is near-identity, the outbound
  projection loses nothing structural (only the `ad4m:` provenance reification,
  which by design lives on Channel A) and the inbound ingest reconstructs the
  instance's links exactly.

## Template Variables

| Variable | Description |
|----------|-------------|
| `SOLID_POD_URL` | Solid pod base URL |
| `SOLID_CONTAINER_PATH` | Container path within the pod |
| `SOLID_IDP_URL` | Identity Provider URL |
| `SOLID_WEBID` | WebID for authentication |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata |

## Building

```bash
NODE_ENV=development pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

```bash
node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

The suite unit-tests the full convergence path against in-memory fixtures — no
live pod required:

- `tests/diffdag.test.ts` — the acceptance criteria: commit-hash determinism and
  order-independence; revision derivation (empty / single head / multi-head
  digest) and head computation; the DAG being authoritative (folding the
  `ad4m:previous` chain from genesis reproduces the link set, tombstones remove,
  re-adds stay removed); order-independent merge; Turtle round-trip preserving
  the original link hash in a tombstone.
- `tests/sync.test.ts` — the DAG-walk sync against a mock pod: ancestry walk
  re-requesting missing parents, incremental diffs, idempotent re-sync, and
  removal convergence via tombstones.
- `tests/ldp.test.ts` — the content-hash resource URL builders
  (`diffsContainerUrl`, `diffResourceUrl`, `extractCommitHash`) and header/URL
  helpers.
- `tests/cross-runtime.test.ts` — revision derivation through the store.
- `tests/projection.test.ts` — Channel B core: the literal codec, node-expression
  evaluator, SHACL profile parsing, `project`/`ingest` round-trip, and the Solid
  RDF adapter (`toNative` emits a clean `sioc:Post` resource with no `ad4m:`
  reification; `fromNative` parses it back; typed literals / URI objects).
- `tests/channel-b-bridge.test.ts` — Channel B orchestration over the Solid
  adapter: `projectInstances` (graph → native RDF resources), `ingestNative`
  (native resource → authoritative links, with container parenting), and the
  default Flux → SIOC message profile.

**Needs a live pod (not covered here):** real LDP container creation and
`PUT`/`GET` round-trips against a running Solid server (e.g. Community Solid
Server), WebID-OIDC / CSS token authentication, and Web Access Control.

## Module map

- `src/diffdag.ts` — the convergence substrate: link/commit content hashing,
  head computation, revision derivation, OR-Set fold, commit ↔ Turtle
  serialization (with `ad4m:previous`). Pure; no adapter or host imports.
- `src/store.ts` — the DAG cache (source of truth: `dag/commit/*`, `dag/heads`)
  and the derived link cache, plus query and peer state.
- `src/sync.ts` — the pod-side DAG walk: discover commit resources, follow
  `ad4m:previous`, fetch missing ancestors, re-fold.
- `src/ldp.ts` — LDP GET/HEAD/PUT/POST/PATCH/DELETE and the resource-URL
  builders for the `diffs/` container (`diff-<hash>.ttl`) and the Channel-B
  `views/` container (`view-<slug>.ttl`).
- `src/ontology.ts` — the AD4M diff-DAG ontology terms in RDF (`ad4m:DiffCommit`,
  `ad4m:previous`, `ad4m:addition`, `ad4m:removal`, `ad4m:Tombstone`, …).
- `src/rdf.ts` — Turtle parsing/serialization primitives.
- `src/projection/` — the shared, protocol-agnostic Channel-B core, copied
  **verbatim** from the reference (Matrix) language: literal codec, node-expression
  evaluator, SHACL profile parsing, and the `project`/`ingest`/`projectInstances`/
  `ingestNative` fold. Not modified per-language.
- `src/solid-projection.ts` — the Solid-specific `NativeAdapter<RdfResource>`:
  the only Channel-B code that knows Solid's native shape. `toNative` renders a
  `Projection` as a flat, vocabulary-native RDF resource (subject + direct
  predicate/object triples, `dcterms:` provenance); `fromNative` parses one back.
  The near-identity mapping that distinguishes Solid from the plain-text protocols.
- `src/translate.ts` — link ↔ RDF translation, plus the retained dual-language
  and SDNA-pattern helpers (exercised by `tests/dual-language.test.ts` and
  `tests/sdna.test.ts`). These are orthogonal to the diff-DAG contract and are
  not wired into the append-only commit path.
- `src/acl.ts` — Web Access Control resource management.
- `src/auth.ts` — WebID-OIDC / CSS token authentication.
- `src/settings.ts` — language settings parsing.
- `src/types.ts` — shared link/diff/perspective types.
- `src/adapters.ts` / `src/adapters-deno.ts` — the injected Transport / Storage /
  Runtime / Signing adapters. `ad4m:host` imports are confined to
  `adapters-deno.ts` and `index.ts`, so every core module is testable across
  runtimes.

## License

CAL-1.0
