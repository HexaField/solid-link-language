# Solid Link Language for AD4M

AD4M link language that syncs Perspective triples to Solid pods via LDP (Linked Data Platform), stored as RDF/Turtle resources.

## What It Does

- **Commits:** links → RDF/Turtle resources created in an LDP container on a Solid pod
- **Sync:** polls container for new resources → local links
- **Query:** indexed local store (source, target, predicate)
- **Native Linked Data:** links become first-class RDF, browseable in any Solid app (Penny, Mashlib)
- **Access control:** Web Access Control (WAC) for fine-grained permissions

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
pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

```bash
node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

194 tests across 10 suites.

## Architecture

Same [pure/impure pattern](https://github.com/HexaField/ad4m-link-language-template) as all AD4M link languages. Protocol-specific modules:

- `src/ldp.ts` / `ldp.pure.ts` — LDP container operations
- `src/rdf.ts` / `rdf.pure.ts` — RDF/Turtle serialization
- `src/acl.ts` — Web Access Control management
- `src/auth.ts` / `auth.pure.ts` — WebID-OIDC / CSS token authentication
- `src/ontology.ts` — AD4M link ontology in RDF
- `src/translate.ts` / `translate.pure.ts` — link ↔ RDF translation
- `src/dual-language.ts` — dual-language support
- `src/sdna.ts` — social DNA definitions
- `src/settings.ts` — language settings
- `src/sync.ts` — sync orchestration

`ad4m:host` imports confined to 4 adapter files + `index.ts`.

## License

CAL-1.0
