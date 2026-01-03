# Crates Casys — Architecture proposée

Objectif: clarifier la séparation des responsabilités entre cœur du moteur, adaptateurs de stockage et wrappers FFI, tout en préparant l’extension multi-SDK (Python/TypeScript) et des binaires optionnels (CLI/HTTP).

## 1) État actuel (workspace)

- Workspace (`Cargo.toml` racine):
  - `engine/` (crate `casys`) — contient des deps serveur (Axum/Tokio)
  - `crates/casys_core/`
  - `crates/casys_engine/`
  - `crates/casys_ffi/` (FFI actuel)
  - `crates/casys_storage_mem/`
  - `crates/casys_storage_fs/`
- SDK Python (`sdk/python/`) pointe aujourd’hui vers `engine/` (crate `casys`).

Limitation: les wrappers FFI et le SDK Python dépendent du crate `engine/`, qui inclut des concerns HTTP/serveur. On souhaite isoler le moteur pur Rust et rendre les wrappers FFI minces et stables.

## 2) Cible (architecture « carrée »)

```
KuzuEventBus/
├── crates/
│   ├── casys_core/          # Domain pur: AST, types, erreurs, traits/ports, algos
│   ├── casys_storage_mem/   # Adapter stockage en mémoire (feature: mem)
│   ├── casys_storage_fs/    # Adapter stockage FS (feature: fs)
│   ├── casys_engine/        # Moteur pur Rust: parser, planner, executor, API publique
│   ├── casys_pyo3/          # Wrapper pyo3 (FFI Python) — cdylib, dépend de casys_engine
│   └── casys_napi/          # Wrapper napi-rs (SDK TS) — plus tard
├── apps/
│   ├── casys-cli/           # Binaire CLI (debug/maintenance)
│   └── casys-http/          # Service HTTP Axum (optionnel)
│   └── casysdb/             # Application web (à déplacer)
└── sdk/
    ├── python/              # Wheel maturin pointant sur crates/casys_pyo3
    └── typescript/          # NPM (plus tard) pointant sur crates/casys_napi
```

Notes:
- `crates/casys_ffi/` → renommage recommandé en `crates/casys_pyo3/` (wrapper Python explicite).
- `engine/` → déplacé vers `apps/casys-http/` (facultatif). Les apps dépendent de `casys_engine`.

## 3) Rôles et dépendances

- `casys_core`: invariants de domaine, structures, erreurs, traits; aucune dépendance FFI/HTTP.
- `casys_storage_mem` / `casys_storage_fs`: adaptateurs de stockage interchangeables.
- `casys_engine`: orchestre parser → planner → executor, expose l’API moteur pure Rust.
- `casys_pyo3` (ex-`casys_ffi`): couche FFI mince vers Python (pyo3/abi3), dépend de `casys_engine` uniquement.
- `casys_napi`: couche FFI pour TypeScript via `napi-rs` (plus tard), dépend de `casys_engine`.
- Apps (`casys-cli`, `casys-http`): binaire(s) consommant `casys_engine` + features de stockage.

### Graphe de dépendances (cible)

```
casys_core → casys_engine ← casys_storage_mem
                        └─ casys_storage_fs
casys_engine → casys_pyo3 → sdk/python
casys_engine → casys_napi → sdk/typescript
apps/* → casys_engine
```

## 4) Features & builds

- Features workspace proposées:
  - `default = ["mem"]`
  - `mem`: active `casys_storage_mem`
  - `fs`: active `casys_storage_fs`
- Wrappers FFI (Python): `pyo3` avec `abi3` (p.ex. `abi3-py38`) pour wheels compatibles.
- CI: matrice par crate et par feature, `cargo test` (workspace), `maturin build` (SDK Python), lint.

## 5) Plan minimal de migration (sans casser le build)

1. Re-câbler `crates/casys_engine` pour dépendre de `casys_core` + `casys_storage_*` (retirer lien vers `engine/`).
2. Faire dépendre `crates/casys_ffi` (bientôt `casys_pyo3`) de `casys_engine` (retirer lien vers `engine/`).
3. Pointer `sdk/python` vers `crates/casys_ffi` (ou `casys_pyo3` après renommage) dans `Cargo.toml`/`pyproject.toml`.
4. Optionnel: déplacer `engine/` sous `apps/casys-http/` et l’exclure des wrappers FFI/SDK.
5. Tests: `cargo test` (workspace), `maturin develop` (SDK Python), exécuter les tests existants Python/Rust.

## 6) Bonnes pratiques

- Moteur (`casys_engine`) sans dépendance pyo3/HTTP.
- Wrappers FFI minces et stables; versionnement semver aligné moteur/SDK.
- Stockage sélectionné par features (YAGNI: mémoire par défaut, FS optionnel).
- TDD: tests Rust (engine + storage) et tests SDK (Python) miroirs.

## 7) Statut

- Ce document décrit la cible et le chemin de migration. Aucune modification de code n’est effectuée ici.
- Voir la TODO du repo pour le suivi des étapes (re-câblage deps, renommage FFI, déplacement `engine/`, MAJ SDK Python).

---

## 8) API moteur (MVP) et points d’entrée

- **`Engine::open(data_dir)`**: ouvre/crée un moteur local (FS activé si feature `fs`).
- **`Engine::open_with_backend(data_dir, backend)`**: injection d’un backend qui implémente `StorageBackend` (feature `fs`).
- **`Engine::open_fs_composite(data_dir)`**: compose un `CompositeBackend` basé sur l’adaptateur FS (ports granulaires), pour préparer des mix (FS/S3/Redis) — feature `fs`.
- **`open_database(name)`**, **`open_branch(db, name)`**: handles opaques.
- **`flush_branch(db, branch, store)`**: persiste un `InMemoryGraphStore` en segments FS.
- **`load_branch(db, branch)`**: recharge un `InMemoryGraphStore` depuis segments.
- **`list_snapshot_timestamps(db, branch)`**: liste des versions manifest (timestamps).
- **`commit_tx(branch, records)`**: append WAL + publie manifest (timestamp).
- **`execute_gql_on_store(store, GqlQuery, params)`**: parse → plan → exécute sur un store en mémoire (wrappers FFI minces).

## 9) Ports de stockage granulaires (dans `casys_core`)

- **`StorageCatalog`**: `list_branches(...)`, `create_branch(...)`.
- **`ManifestStore`**: `list_snapshot_timestamps(...)`, `latest_manifest_meta(...)`, `write_manifest_meta(...)`, etc.
- **`SegmentStore`**: `write_segment(...)`, `read_segment(...)`.
- **`WalSink` / `WalSource`**: `append_records(...)`, `list_wal_segments(...)`, `read_wal_segment(...)`.
- Types associés: **`SegmentId`**, **`WalTailMeta`**, **`ManifestMeta`**.

### Impl FS

- `crates/casys_storage_fs/` implémente tous ces ports + `StorageBackend` en s’appuyant sur `manifest.rs`, `segments.rs`, `wal.rs`, `catalog.rs`.

## 10) CompositeBackend

`CompositeBackend` implémente `StorageBackend` par délégation vers les ports granulaires injectés. Permet de mixer des adaptateurs (ex: segments = S3, WAL = Redis, catalog = FS).

Exemple (FS pur):

```rust
use std::sync::Arc;
use casys_engine::Engine;
use casys_core::CompositeBackend;

let fs = Arc::new(casys_storage_fs::backend::FsBackend::new());
let backend = CompositeBackend::new(
    fs.clone(),     // StorageCatalog
    fs.clone(),     // ManifestStore
    fs.clone(),     // SegmentStore
    Some(fs.clone()), // WalSink
    Some(fs),         // WalSource
);
let engine = Engine::open_with_backend("data", Arc::new(backend))?;
```

## 11) Quickstart FS (flush/load + requête)

```rust
use casys_engine::{Engine, GqlQuery};

let engine = Engine::open("data")?;               // feature fs activée
let db = engine.open_database("main")?;
let br = engine.open_branch(&db, "main")?;

// Travail en mémoire
let mut store = casys_engine::index::InMemoryGraphStore::new();
engine.execute_gql_on_store(
    &mut store,
    &GqlQuery("CREATE (:Person {name:'Alice'})".into()),
    None,
)?;

// Persistance puis rechargement
engine.flush_branch(&db, &br, &store)?;
let mut loaded = engine.load_branch(&db, &br)?;
let res = engine.execute_gql_on_store(
    &mut loaded,
    &GqlQuery("MATCH (p:Person) RETURN p.name".into()),
    None,
)?;
assert_eq!(res.rows[0][0], serde_json::json!("Alice"));
```
