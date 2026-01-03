//! Casys N-API wrapper for TypeScript/Node.js
//! Thin FFI layer mirroring casys_pyo3 pattern: JSON conversions only.

use napi::{bindgen_prelude::*, JsObject, JsString, JsNumber};
use napi_derive::napi;
use std::sync::{Arc, Mutex};
use casys_engine as engine;
use engine::types::{DatabaseName, BranchName, GqlQuery};
use engine::index::InMemoryGraphStore;

/// Casys Engine wrapper for Node.js
#[napi]
pub struct CasysEngine {
  inner: Arc<Mutex<engine::Engine>>,
  stores: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<InMemoryGraphStore>>>>>,
}

#[napi]
impl CasysEngine {
  /// Create a new engine instance
  #[napi(constructor)]
  pub fn new(data_dir: String) -> napi::Result<Self> {
    let path = std::path::PathBuf::from(data_dir);
    let engine = engine::Engine::open(&path)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open engine: {:?}", e)))?;
    
    Ok(Self {
      inner: Arc::new(Mutex::new(engine)),
      stores: Arc::new(Mutex::new(std::collections::HashMap::new())),
    })
  }

  /// Open a database by name
  #[napi]
  pub fn open_database(&self, name: String) -> napi::Result<String> {
    let engine = self.inner.lock().unwrap();
    let _db_handle = engine.open_database(&name)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open database: {:?}", e)))?;
    Ok(name)
  }

  /// Open a branch within a database
  #[napi]
  pub fn open_branch(&self, db_name: String, branch_name: String) -> napi::Result<CasysBranch> {
    let engine = self.inner.lock().unwrap();
    let db_handle = engine.open_database(&db_name)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open database: {:?}", e)))?;
    let _branch_handle = engine.open_branch(&db_handle, &branch_name)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open branch: {:?}", e)))?;

    let key = format!("{}/{}", db_name, branch_name);
    let mut stores = self.stores.lock().unwrap();
    let store = stores.entry(key.clone()).or_insert_with(|| {
      Arc::new(Mutex::new(InMemoryGraphStore::new()))
    }).clone();

    Ok(CasysBranch {
      db_name,
      branch_name,
      store,
      engine: self.inner.clone(),
    })
  }

  /// Create a new branch from an existing one
  #[napi]
  pub fn create_branch(&self, db_name: String, branch_name: String) -> napi::Result<()> {
    let engine = self.inner.lock().unwrap();
    let db_handle = engine.open_database(&db_name)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open database: {:?}", e)))?;
    engine.create_branch(&db_handle, "main", &branch_name, None)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to create branch: {:?}", e)))?;
    Ok(())
  }

  /// List snapshot timestamps for a branch (requires fs feature)
  #[napi]
  #[cfg(feature = "fs")]
  pub fn list_snapshots(&self, db_name: String, branch_name: String) -> napi::Result<Vec<f64>> {
    let engine = self.inner.lock().unwrap();
    let db_handle = engine.open_database(&db_name)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open database: {:?}", e)))?;
    let branch_handle = engine.open_branch(&db_handle, &branch_name)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open branch: {:?}", e)))?;

    let timestamps = engine.list_snapshot_timestamps(&db_handle, &branch_handle)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to list snapshots: {:?}", e)))?;

    Ok(timestamps.iter().map(|ts| *ts as f64).collect())
  }

  #[napi]
  #[cfg(not(feature = "fs"))]
  pub fn list_snapshots(&self, _db_name: String, _branch_name: String) -> napi::Result<Vec<f64>> {
    Err(napi::Error::new(napi::Status::GenericFailure, "list_snapshots() requires the 'fs' feature"))
  }
}

/// Branch handle for Node.js
#[napi]
pub struct CasysBranch {
  db_name: String,
  branch_name: String,
  store: Arc<Mutex<InMemoryGraphStore>>,
  engine: Arc<Mutex<engine::Engine>>,
}

#[napi]
impl CasysBranch {
  /// Execute a GQL query against the branch store
  #[napi]
  pub fn query(&self, gql: String, params: Option<JsObject>, env: Env) -> napi::Result<JsObject> {
    let mut params_json: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    
    if let Some(p) = params {
      let keys: Vec<String> = p.get_property_names()?
        .into_iter()
        .filter_map(|k| k.as_string().ok())
        .collect();
      
      for key in keys {
        if let Ok(val) = p.get::<_, JsUnknown>(&key) {
          if let Ok(json_val) = js_to_json(&env, &val) {
            params_json.insert(key, json_val);
          }
        }
      }
    }

    let gql = GqlQuery(gql);
    let mut store = self.store.lock().unwrap();
    let engine = self.engine.lock().unwrap();
    let result = engine.execute_gql_on_store(&mut *store, &gql, if params_json.is_empty() { None } else { Some(params_json) })
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Execution error: {:?}", e)))?;

    let obj = env.create_object()?;
    
    // Columns
    let cols: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
    obj.set("columns", env.create_string_from_std(serde_json::to_string(&cols).unwrap())?)?;
    
    // Rows
    let rows_json = serde_json::to_string(&result.rows).unwrap();
    obj.set("rows", env.create_string_from_std(rows_json)?)?;

    Ok(obj)
  }

  /// Flush store to disk (requires fs feature)
  #[napi]
  #[cfg(feature = "fs")]
  pub fn flush(&self) -> napi::Result<()> {
    let db = DatabaseName::try_from(self.db_name.as_str())
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Invalid database name: {:?}", e)))?;
    let branch = BranchName::try_from(self.branch_name.as_str())
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Invalid branch name: {:?}", e)))?;
    
    let engine = self.engine.lock().unwrap();
    let db_handle = engine.open_database(db.as_str())
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open database: {:?}", e)))?;
    let branch_handle = engine.open_branch(&db_handle, branch.as_str())
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open branch: {:?}", e)))?;
    let store = self.store.lock().unwrap();
    engine.flush_branch(&db_handle, &branch_handle, &store)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Flush error: {:?}", e)))?;
    
    Ok(())
  }

  #[napi]
  #[cfg(not(feature = "fs"))]
  pub fn flush(&self) -> napi::Result<()> {
    Err(napi::Error::new(napi::Status::GenericFailure, "flush() requires the 'fs' feature"))
  }

  /// Load store from disk (requires fs feature)
  #[napi]
  #[cfg(feature = "fs")]
  pub fn load(&self) -> napi::Result<()> {
    let db = DatabaseName::try_from(self.db_name.as_str())
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Invalid database name: {:?}", e)))?;
    let branch = BranchName::try_from(self.branch_name.as_str())
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Invalid branch name: {:?}", e)))?;
    
    let engine = self.engine.lock().unwrap();
    let db_handle = engine.open_database(db.as_str())
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open database: {:?}", e)))?;
    let branch_handle = engine.open_branch(&db_handle, branch.as_str())
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Failed to open branch: {:?}", e)))?;
    let loaded_store = engine.load_branch(&db_handle, &branch_handle)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Load error: {:?}", e)))?;
    let mut store = self.store.lock().unwrap();
    *store = loaded_store;
    
    Ok(())
  }

  #[napi]
  #[cfg(not(feature = "fs"))]
  pub fn load(&self) -> napi::Result<()> {
    Err(napi::Error::new(napi::Status::GenericFailure, "load() requires the 'fs' feature"))
  }
}

/// Convert JS value to serde_json::Value
fn js_to_json(env: &Env, val: &JsUnknown) -> napi::Result<serde_json::Value> {
  if let Ok(null) = val.coerce_to_null() {
    return Ok(serde_json::Value::Null);
  }
  if let Ok(b) = val.coerce_to_bool() {
    return Ok(serde_json::Value::Bool(b.get_value()?));
  }
  if let Ok(n) = val.coerce_to_number() {
    let num = n.get_double()?;
    if let Some(json_num) = serde_json::Number::from_f64(num) {
      return Ok(serde_json::Value::Number(json_num));
    }
  }
  if let Ok(s) = val.coerce_to_string() {
    return Ok(serde_json::Value::String(s.into_utf8()?.into_owned()));
  }
  Ok(serde_json::Value::Null)
}
