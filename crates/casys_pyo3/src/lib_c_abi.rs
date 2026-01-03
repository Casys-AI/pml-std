//! Minimal C ABI for Casys engine (FFI). Opaque handles + error buffer.

use once_cell::sync::OnceCell;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::sync::Mutex;

// Re-export timestamp type
use casys_engine::{BranchHandle, DbHandle, Engine, EngineError, Timestamp};

// Global last-error buffer
static LAST_ERROR: OnceCell<Mutex<Option<CString>>> = OnceCell::new();

fn set_last_error<S: ToString>(msg: S) {
    let guard = LAST_ERROR.get_or_init(|| Mutex::new(None));
    if let Ok(mut slot) = guard.lock() {
        *slot = Some(CString::new(msg.to_string()).unwrap_or_else(|_| CString::new("<invalid utf8>").unwrap()));
    }
}

/// Commit a single WAL record buffer to a branch. Returns timestamp or 0 on error.
#[no_mangle]
pub extern "C" fn casys_commit_tx(ptr_eng: *mut CasysEngine, ptr_br: *mut CasysBranch, data_ptr: *const u8, data_len: usize) -> u64 {
    clear_last_error();
    if ptr_eng.is_null() { set_last_error("engine is null"); return 0; }
    if ptr_br.is_null() { set_last_error("branch is null"); return 0; }
    if data_ptr.is_null() && data_len > 0 { set_last_error("data is null"); return 0; }
    let eng = unsafe { &*ptr_eng };
    let br = unsafe { &*ptr_br };
    let rec: &[u8] = unsafe { std::slice::from_raw_parts(data_ptr, data_len) };
    match map_err(eng.inner.commit_tx(&br.inner, &[rec.to_vec()])) { Ok(ts) => ts, Err(()) => 0 }
}

fn clear_last_error() {
    let guard = LAST_ERROR.get_or_init(|| Mutex::new(None));
    if let Ok(mut slot) = guard.lock() {
        *slot = None;
    }
}

#[no_mangle]
pub extern "C" fn casys_last_error() -> *const c_char {
    let guard = LAST_ERROR.get_or_init(|| Mutex::new(None));
    if let Ok(slot) = guard.lock() {
        if let Some(ref s) = *slot {
            return s.as_ptr();
        }
    }
    ptr::null()
}

#[repr(C)]
pub struct CasysEngine {
    inner: Engine,
}

#[repr(C)]
pub struct CasysDb {
    inner: DbHandle,
}

#[repr(C)]
pub struct CasysBranch {
    inner: BranchHandle,
}

unsafe fn cstr_to_str<'a>(ptr: *const c_char) -> Result<&'a str, &'static str> {
    if ptr.is_null() { return Err("null ptr"); }
    let c = CStr::from_ptr(ptr);
    c.to_str().map_err(|_| "invalid utf8")
}

fn map_err<T>(res: Result<T, EngineError>) -> Result<T, ()> {
    match res {
        Ok(v) => Ok(v),
        Err(e) => { set_last_error(e.to_string()); Err(()) }
    }
}

#[no_mangle]
pub extern "C" fn casys_engine_open(data_dir: *const c_char) -> *mut CasysEngine {
    clear_last_error();
    let dir = match unsafe { cstr_to_str(data_dir) } { Ok(s) => s, Err(e) => { set_last_error(e); return ptr::null_mut(); } };
    let eng = match map_err(Engine::open(dir)) { Ok(e) => e, Err(()) => return ptr::null_mut() };
    Box::into_raw(Box::new(CasysEngine { inner: eng }))
}

#[no_mangle]
pub extern "C" fn casys_engine_free(ptr_eng: *mut CasysEngine) {
    if ptr_eng.is_null() { return; }
    unsafe { drop(Box::from_raw(ptr_eng)); }
}

#[no_mangle]
pub extern "C" fn casys_db_open(ptr_eng: *mut CasysEngine, name: *const c_char) -> *mut CasysDb {
    clear_last_error();
    if ptr_eng.is_null() { set_last_error("engine is null"); return ptr::null_mut(); }
    let eng = unsafe { &*ptr_eng };
    let name = match unsafe { cstr_to_str(name) } { Ok(s) => s, Err(e) => { set_last_error(e); return ptr::null_mut(); } };
    let db = match map_err(eng.inner.open_database(name)) { Ok(d) => d, Err(()) => return ptr::null_mut() };
    Box::into_raw(Box::new(CasysDb { inner: db }))
}

#[no_mangle]
pub extern "C" fn casys_db_free(ptr_db: *mut CasysDb) {
    if ptr_db.is_null() { return; }
    unsafe { drop(Box::from_raw(ptr_db)); }
}

#[no_mangle]
pub extern "C" fn casys_branch_open(ptr_eng: *mut CasysEngine, ptr_db: *mut CasysDb, branch: *const c_char) -> *mut CasysBranch {
    clear_last_error();
    if ptr_eng.is_null() { set_last_error("engine is null"); return ptr::null_mut(); }
    if ptr_db.is_null() { set_last_error("db is null"); return ptr::null_mut(); }
    let eng = unsafe { &*ptr_eng };
    let db = unsafe { &*ptr_db };
    let br = match unsafe { cstr_to_str(branch) } { Ok(s) => s, Err(e) => { set_last_error(e); return ptr::null_mut(); } };
    let handle = match map_err(eng.inner.open_branch(&db.inner, br)) { Ok(h) => h, Err(()) => return ptr::null_mut() };
    Box::into_raw(Box::new(CasysBranch { inner: handle }))
}

#[no_mangle]
pub extern "C" fn casys_branch_free(ptr_br: *mut CasysBranch) {
    if ptr_br.is_null() { return; }
    unsafe { drop(Box::from_raw(ptr_br)); }
}

/// Create a snapshot on a branch. Returns timestamp or 0 on error.
#[no_mangle]
pub extern "C" fn casys_snapshot(ptr_eng: *mut CasysEngine, ptr_br: *mut CasysBranch) -> u64 {
    clear_last_error();
    if ptr_eng.is_null() { set_last_error("engine is null"); return 0; }
    if ptr_br.is_null() { set_last_error("branch is null"); return 0; }
    let eng = unsafe { &*ptr_eng };
    let br = unsafe { &*ptr_br };
    match map_err(eng.inner.snapshot(&br.inner, None)) { Ok(ts) => ts, Err(()) => 0 }
}

/// Create a new branch from an existing branch, optionally at timestamp (0 => None). Returns 0 on success, -1 on error.
#[no_mangle]
pub extern "C" fn casys_create_branch(ptr_eng: *mut CasysEngine, ptr_db: *mut CasysDb, from: *const c_char, new_branch: *const c_char, at_ts: u64) -> c_int {
    clear_last_error();
    if ptr_eng.is_null() { set_last_error("engine is null"); return -1; }
    if ptr_db.is_null() { set_last_error("db is null"); return -1; }
    let eng = unsafe { &*ptr_eng };
    let db = unsafe { &*ptr_db };
    let from = match unsafe { cstr_to_str(from) } { Ok(s) => s, Err(e) => { set_last_error(e); return -1; } };
    let newb = match unsafe { cstr_to_str(new_branch) } { Ok(s) => s, Err(e) => { set_last_error(e); return -1; } };
    let at: Option<Timestamp> = if at_ts == 0 { None } else { Some(at_ts) };
    match map_err(eng.inner.create_branch(&db.inner, from, newb, at)) { Ok(()) => 0, Err(()) => -1 }
}
