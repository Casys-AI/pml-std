// Integration test: FS persistence roundtrip using Engine API

#[cfg(feature = "fs")]
#[test]
fn persistence_roundtrip_flush_load() {
    use casys_engine as engine;
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::fs;

    // Unique temp dir under target/tmp
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let root = std::env::current_dir().unwrap()
        .join("target").join("tmp").join(format!("engine_fs_{}", now));
    fs::create_dir_all(&root).unwrap();

    // Open engine and handles
    let eng = engine::Engine::open(&root).unwrap();
    let db = eng.open_database("testdb").unwrap();
    let br = eng.open_branch(&db, "main").unwrap();

    // Build an in-memory store and create data via GQL
    let mut store = engine::index::InMemoryGraphStore::new();
    let create = engine::types::GqlQuery("CREATE (:Person {name: 'Alice'})".to_string());
    let _ = eng.execute_gql_on_store(&mut store, &create, None).unwrap();

    // Flush to disk (segments)
    eng.flush_branch(&db, &br, &store).unwrap();

    // Load back into a new store
    let mut loaded = eng.load_branch(&db, &br).unwrap();

    // Query the loaded data
    let q = engine::types::GqlQuery("MATCH (p:Person) RETURN p.name".to_string());
    let res = eng.execute_gql_on_store(&mut loaded, &q, None).unwrap();

    assert_eq!(res.rows.len(), 1);
    assert_eq!(res.columns.len(), 1);
    assert_eq!(res.columns[0].name, "p.name");
    assert_eq!(res.rows[0][0], serde_json::Value::String("Alice".to_string()));
}

#[cfg(not(feature = "fs"))]
#[test]
fn skip_persistence_roundtrip_without_fs() {
    // This test is a no-op when fs feature is not enabled
}
