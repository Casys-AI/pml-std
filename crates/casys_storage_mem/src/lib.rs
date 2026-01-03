//! In-memory storage placeholder (MVP). Currently no-op; engine writes to WAL via existing code.

pub struct MemStorage;

impl MemStorage {
    pub fn new() -> Self { Self }
}
