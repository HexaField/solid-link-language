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
  builders for the `diffs/` container and `diff-<hash>.ttl` resources.
- `src/ontology.ts` — the AD4M diff-DAG ontology terms in RDF (`ad4m:DiffCommit`,
  `ad4m:previous`, `ad4m:addition`, `ad4m:removal`, `ad4m:Tombstone`, …).
- `src/rdf.ts` — Turtle parsing/serialization primitives.
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
