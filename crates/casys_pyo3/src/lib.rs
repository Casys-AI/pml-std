//! Casys Python SDK - pyo3 bindings (crates-first)

use pyo3::prelude::*;
use pyo3::types::PyDict;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;

use ::casys_engine as engine;
use engine::types::{DatabaseName, BranchName, GqlQuery};
use engine::index::InMemoryGraphStore;
use engine::exec::executor::Value;
use engine::index::GraphWriteStore;

/// Engine principal pour gérer les bases de données Casys
#[pyclass]
struct CasysEngine {
    inner: Arc<Mutex<engine::Engine>>,
    stores: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<InMemoryGraphStore>>>>>,
}

/// Convert Python object to serde_json::Value (recursively for lists/tuples/dicts)
fn py_to_json(py: Python, obj: &PyAny) -> PyResult<serde_json::Value> {
    if obj.is_none() {
        return Ok(serde_json::Value::Null);
    }
    if let Ok(b) = obj.extract::<bool>() {
        return Ok(serde_json::Value::Bool(b));
    }
    if let Ok(i) = obj.extract::<i64>() {
        return Ok(serde_json::Value::Number(i.into()));
    }
    if let Ok(f) = obj.extract::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(f) { return Ok(serde_json::Value::Number(n)); }
        return Ok(serde_json::Value::Null);
    }
    if let Ok(s) = obj.extract::<String>() {
        return Ok(serde_json::Value::String(s));
    }
    if let Ok(list) = obj.downcast::<pyo3::types::PyList>() {
        let mut arr = Vec::with_capacity(list.len());
        for item in list.iter() {
            arr.push(py_to_json(py, item)?);
        }
        return Ok(serde_json::Value::Array(arr));
    }
    if let Ok(tuple) = obj.downcast::<pyo3::types::PyTuple>() {
        let mut arr = Vec::with_capacity(tuple.len());
        for item in tuple.iter() {
            arr.push(py_to_json(py, item)?);
        }
        return Ok(serde_json::Value::Array(arr));
    }
    if let Ok(dict) = obj.downcast::<pyo3::types::PyDict>() {
        let mut map = serde_json::Map::new();
        for (k, v) in dict.iter() {
            let key = k.to_string();
            map.insert(key, py_to_json(py, v)?);
        }
        return Ok(serde_json::Value::Object(map));
    }
    Err(PyValueError::new_err("Unsupported Python type for JSON conversion"))
}

#[allow(non_local_definitions, dead_code)]
#[pymethods]
impl CasysEngine {
    #[new]
    fn new(data_dir: String) -> PyResult<Self> {
        let path = PathBuf::from(data_dir);
        let engine = engine::Engine::open(&path)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open engine: {:?}", e)))?;
        
        Ok(Self {
            inner: Arc::new(Mutex::new(engine)),
            stores: Arc::new(Mutex::new(std::collections::HashMap::new())),
        })
    }
    
    fn open_database(&self, name: String) -> PyResult<String> {
        let engine = self.inner.lock().unwrap();
        let _db_handle = engine.open_database(&name)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open database: {:?}", e)))?;
        
        Ok(name)
    }
    
    fn open_branch(&self, db_name: String, branch_name: String) -> PyResult<CasysBranch> {
        let engine = self.inner.lock().unwrap();
        let db_handle = engine.open_database(&db_name)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open database: {:?}", e)))?;
        let _branch_handle = engine.open_branch(&db_handle, &branch_name)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open branch: {:?}", e)))?;
        
        // Create or get store for this branch
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
    
    fn create_branch(&self, db_name: String, branch_name: String) -> PyResult<()> {
        let engine = self.inner.lock().unwrap();
        let db_handle = engine.open_database(&db_name)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open database: {:?}", e)))?;
        engine.create_branch(&db_handle, "main", &branch_name, None)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to create branch: {:?}", e)))?;
        
        Ok(())
    }
    
    #[cfg(feature = "fs")]
    fn list_snapshots(&self, db_name: String, branch_name: String, py: Python) -> PyResult<PyObject> {
        let engine = self.inner.lock().unwrap();
        let db_handle = engine.open_database(&db_name)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open database: {:?}", e)))?;
        let branch_handle = engine.open_branch(&db_handle, &branch_name)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open branch: {:?}", e)))?;

        let timestamps = engine.list_snapshot_timestamps(&db_handle, &branch_handle)
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to list snapshots: {:?}", e)))?;

        let mut snapshots: Vec<PyObject> = Vec::new();
        for ts in timestamps {
            let dict = pyo3::types::PyDict::new(py);
            dict.set_item("timestamp", ts)?;
            dict.set_item("branch", branch_name.clone())?;
            snapshots.push(dict.into());
        }
        Ok(snapshots.into_py(py))
    }

    #[cfg(not(feature = "fs"))]
    fn list_snapshots(&self, _db_name: String, _branch_name: String, _py: Python) -> PyResult<PyObject> {
        Err(PyRuntimeError::new_err("list_snapshots() requires the 'fs' feature. Rebuild casys_pyo3 with --features fs."))
    }
}

/// Branch (branche) dans une database Casys
#[pyclass]
struct CasysBranch {
    db_name: String,
    branch_name: String,
    store: Arc<Mutex<InMemoryGraphStore>>,
    engine: Arc<Mutex<engine::Engine>>,
}

#[allow(non_local_definitions, dead_code)]
#[pymethods]
impl CasysBranch {
    #[pyo3(signature = (gql, params=None))]
    fn query(&self, gql: String, params: Option<Py<PyDict>>, py: Python) -> PyResult<PyObject> {
        let mut params_json: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
        if let Some(p) = params {
            for (k, v) in p.as_ref(py).iter() {
                let key = k.to_string();
                let value = py_to_json(py, v)?;
                params_json.insert(key, value);
            }
        }

        let gql = GqlQuery(gql);
        let mut store = self.store.lock().unwrap();
        let engine = self.engine.lock().unwrap();
        let result = engine.execute_gql_on_store(&mut *store, &gql, if params_json.is_empty() { None } else { Some(params_json) })
            .map_err(|e| PyRuntimeError::new_err(format!("Execution error: {:?}", e)))?;
        
        // Convert to Python dict
        let dict = PyDict::new(py);
        
        // Columns
        let cols: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
        dict.set_item("columns", cols)?;
        
        // Rows
        let rows: Vec<Vec<serde_json::Value>> = result.rows;
        let py_rows: Vec<PyObject> = rows.iter().map(|row| {
            row.iter().map(|v| json_to_py(py, v)).collect::<Vec<_>>().into_py(py)
        }).collect();
        dict.set_item("rows", py_rows)?;

        // Stats (if available)
        if let Some(stats) = result.stats {
            let s = PyDict::new(py);
            s.set_item("elapsed_ms", stats.elapsed_ms)?;
            s.set_item("scanned", stats.scanned)?;
            s.set_item("expanded", stats.expanded)?;
            dict.set_item("stats", s)?;
        }
        
        Ok(dict.into())
    }
    
    #[cfg(feature = "fs")]
    fn flush(&self) -> PyResult<()> {
        let db = DatabaseName::try_from(self.db_name.as_str())
            .map_err(|e| PyValueError::new_err(format!("Invalid database name: {:?}", e)))?;
        let branch = BranchName::try_from(self.branch_name.as_str())
            .map_err(|e| PyValueError::new_err(format!("Invalid branch name: {:?}", e)))?;
        
        let engine = self.engine.lock().unwrap();
        let db_handle = engine.open_database(db.as_str())
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open database: {:?}", e)))?;
        let branch_handle = engine.open_branch(&db_handle, branch.as_str())
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open branch: {:?}", e)))?;
        let store = self.store.lock().unwrap();
        engine.flush_branch(&db_handle, &branch_handle, &store)
            .map_err(|e| PyRuntimeError::new_err(format!("Flush error: {:?}", e)))?;
        
        Ok(())
    }
    
    #[cfg(not(feature = "fs"))]
    fn flush(&self) -> PyResult<()> {
        Err(PyRuntimeError::new_err("flush() requires the 'fs' feature. Rebuild casys_pyo3 with --features fs."))
    }
    
    #[cfg(feature = "fs")]
    fn load(&self) -> PyResult<()> {
        let db = DatabaseName::try_from(self.db_name.as_str())
            .map_err(|e| PyValueError::new_err(format!("Invalid database name: {:?}", e)))?;
        let branch = BranchName::try_from(self.branch_name.as_str())
            .map_err(|e| PyValueError::new_err(format!("Invalid branch name: {:?}", e)))?;
        
        let engine = self.engine.lock().unwrap();
        let db_handle = engine.open_database(db.as_str())
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open database: {:?}", e)))?;
        let branch_handle = engine.open_branch(&db_handle, branch.as_str())
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open branch: {:?}", e)))?;
        let loaded_store = engine.load_branch(&db_handle, &branch_handle)
            .map_err(|e| PyRuntimeError::new_err(format!("Load error: {:?}", e)))?;
        let mut store = self.store.lock().unwrap();
        *store = loaded_store;
        
        Ok(())
    }
    
    #[cfg(not(feature = "fs"))]
    fn load(&self) -> PyResult<()> {
        Err(PyRuntimeError::new_err("load() requires the 'fs' feature. Rebuild casys_pyo3 with --features fs."))
    }
    
    fn add_node(&self, labels: Vec<String>, properties: Py<PyDict>, py: Python) -> PyResult<u64> {
        let mut store = self.store.lock().unwrap();
        
        // Convert Python dict to HashMap<String, Value>
        let mut props = std::collections::HashMap::new();
        for (k, v) in properties.as_ref(py).iter() {
            let key = k.to_string();
            let value = py_to_value(v)?;
            props.insert(key, value);
        }
        
        let node_id = store.add_node(labels, props)
            .map_err(|e| PyRuntimeError::new_err(format!("Add node error: {:?}", e)))?;
        
        Ok(node_id)
    }
    
    fn add_edge(&self, from_id: u64, to_id: u64, edge_type: String, properties: Py<PyDict>, py: Python) -> PyResult<u64> {
        let mut store = self.store.lock().unwrap();
        
        // Convert Python dict to HashMap<String, Value>
        let mut props = std::collections::HashMap::new();
        for (k, v) in properties.as_ref(py).iter() {
            let key = k.to_string();
            let value = py_to_value(v)?;
            props.insert(key, value);
        }
        
        let edge_id = store.add_edge(from_id, to_id, edge_type, props)
            .map_err(|e| PyRuntimeError::new_err(format!("Add edge error: {:?}", e)))?;
        
        Ok(edge_id)
    }
}

/// Convert Python object to Value
fn py_to_value(obj: &PyAny) -> PyResult<Value> {
    if obj.is_none() {
        Ok(Value::Null)
    } else if let Ok(b) = obj.extract::<bool>() {
        Ok(Value::Bool(b))
    } else if let Ok(i) = obj.extract::<i64>() {
        Ok(Value::Int(i))
    } else if let Ok(f) = obj.extract::<f64>() {
        Ok(Value::Float(f))
    } else if let Ok(s) = obj.extract::<String>() {
        Ok(Value::String(s))
    } else {
        Err(PyValueError::new_err("Unsupported Python type for Value conversion"))
    }
}

/// Convert serde_json::Value to Python object
fn json_to_py(py: Python, val: &serde_json::Value) -> PyObject {
    match val {
        serde_json::Value::Null => py.None(),
        serde_json::Value::Bool(b) => b.into_py(py),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.into_py(py)
            } else if let Some(f) = n.as_f64() {
                f.into_py(py)
            } else {
                py.None()
            }
        }
        serde_json::Value::String(s) => s.into_py(py),
        serde_json::Value::Array(arr) => {
            let py_list: Vec<PyObject> = arr.iter().map(|v| json_to_py(py, v)).collect();
            py_list.into_py(py)
        }
        serde_json::Value::Object(obj) => {
            let dict = PyDict::new(py);
            for (k, v) in obj {
                let _ = dict.set_item(k, json_to_py(py, v));
            }
            dict.into()
        }
    }
}

/// Module Python Casys Engine (native bindings)
#[pymodule]
fn casys_engine(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_class::<CasysEngine>()?;
    m.add_class::<CasysBranch>()?;
    Ok(())
}
