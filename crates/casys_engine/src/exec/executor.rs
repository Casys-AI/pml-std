//! Executor: exécute le plan via itérateurs

use super::planner::{ExecutionPlan, PlanNode};
use super::ast::{Expr, BinOp, UnOp, Literal, AggFunc, Pattern};
use crate::types::{EngineError, QueryResult, ColumnMeta};
use crate::index::{GraphReadStore, GraphWriteStore};
use std::collections::{HashMap, HashSet};

// Re-export Value from casys_core (unified type across crates)
pub use casys_core::Value;

pub type Tuple = HashMap<String, Value>;

#[derive(Default)]
struct ExecCounters {
    scanned: u64,
    expanded: u64,
}

/// Extension trait for Value to provide JSON conversion methods
/// These methods are engine-specific and use serde_json which is not in casys_core
pub trait ValueExt {
    fn to_json(&self) -> serde_json::Value;
    fn from_json(v: &serde_json::Value) -> Option<Value>;
}

impl ValueExt for Value {
    fn to_json(&self) -> serde_json::Value {
        match self {
            Value::String(s) => serde_json::Value::String(s.clone()),
            Value::Int(i) => serde_json::Value::Number((*i).into()),
            Value::Float(f) => serde_json::Number::from_f64(*f)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            Value::Bool(b) => serde_json::Value::Bool(*b),
            Value::Null => serde_json::Value::Null,
            Value::NodeId(id) => serde_json::Value::Number((*id).into()),
            // Handle additional casys_core::Value variants gracefully
            Value::Bytes(b) => serde_json::Value::String(base64_encode(b)),
            Value::Array(arr) => serde_json::Value::Array(
                arr.iter().map(|v| v.to_json()).collect()
            ),
            Value::Map(map) => serde_json::Value::Object(
                map.iter().map(|(k, v)| (k.clone(), v.to_json())).collect()
            ),
        }
    }

    fn from_json(v: &serde_json::Value) -> Option<Value> {
        match v {
            serde_json::Value::String(s) => Some(Value::String(s.clone())),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() { Some(Value::Int(i)) }
                else if let Some(f) = n.as_f64() { Some(Value::Float(f)) }
                else { None }
            }
            serde_json::Value::Bool(b) => Some(Value::Bool(*b)),
            serde_json::Value::Null => Some(Value::Null),
            serde_json::Value::Array(arr) => {
                let values: Option<Vec<Value>> = arr.iter().map(Value::from_json).collect();
                values.map(Value::Array)
            }
            serde_json::Value::Object(obj) => {
                let mut map = std::collections::BTreeMap::new();
                for (k, v) in obj {
                    if let Some(val) = Value::from_json(v) {
                        map.insert(k.clone(), val);
                    } else {
                        return None;
                    }
                }
                Some(Value::Map(map))
            }
        }
    }
}

/// Simple base64 encoding for Bytes variant (no external dependency)
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        result.push(ALPHABET[b0 >> 2] as char);
        result.push(ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        if chunk.len() > 1 {
            result.push(ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(ALPHABET[b2 & 0x3f] as char);
        } else {
            result.push('=');
        }
    }
    result
}

pub struct Executor<'a> {
    read: Option<&'a dyn GraphReadStore>,
    parameters: HashMap<String, Value>,
}

impl<'a> Executor<'a> {
    pub fn new(read: &'a dyn GraphReadStore) -> Self {
        Self { 
            read: Some(read),
            parameters: HashMap::new(),
        }
    }

    pub fn new_no_read() -> Self {
        Self {
            read: None,
            parameters: HashMap::new(),
        }
    }
    
    pub fn with_parameters(read: &'a dyn GraphReadStore, parameters: HashMap<String, Value>) -> Self {
        Self { read: Some(read), parameters }
    }

    pub fn with_parameters_no_read(parameters: HashMap<String, Value>) -> Self {
        Self { read: None, parameters }
    }

    pub fn execute(&self, plan: &ExecutionPlan, write: Option<&mut dyn GraphWriteStore>) -> Result<QueryResult, EngineError> {
        let start = std::time::Instant::now();
        let mut write_opt = write;
        let mut counters = ExecCounters::default();
        let tuples = self.execute_node(&plan.root, &mut write_opt, &mut counters)?;
        
        // Convert tuples to QueryResult format
        let mut columns: Vec<ColumnMeta> = Vec::new();
        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();

        // Try to preserve column order based on the nearest Project node in the plan
        fn projection_names_from_plan(node: &super::planner::PlanNode) -> Option<Vec<String>> {
            match node {
                super::planner::PlanNode::Project { items, .. } => {
                    let mut names = Vec::new();
                    for item in items {
                        let name = item.alias.clone().unwrap_or_else(|| {
                            match &item.expr {
                                Expr::Ident(n) => n.clone(),
                                Expr::Property(var, prop) => format!("{}.{}", var, prop),
                                _ => "?".to_string(),
                            }
                        });
                        names.push(name);
                    }
                    Some(names)
                }
                super::planner::PlanNode::OrderBy { input, .. } => projection_names_from_plan(input),
                super::planner::PlanNode::Limit { input, .. } => projection_names_from_plan(input),
                // Aggregate produces its own projection; leave None to derive from tuples
                _ => None,
            }
        }
        let ordered_names = projection_names_from_plan(&plan.root);

        if let Some(names) = ordered_names {
            // Use ordered names from RETURN items
            for n in &names {
                columns.push(ColumnMeta { name: n.clone(), r#type: "any".to_string() });
            }
            for tuple in tuples {
                let mut row = Vec::new();
                for n in &names {
                    let val = tuple.get(n).cloned().unwrap_or(Value::Null);
                    row.push(val.to_json());
                }
                rows.push(row);
            }
        } else {
            // Fallback: derive columns from first tuple (unordered)
            if let Some(first) = tuples.first() {
                for key in first.keys() {
                    columns.push(ColumnMeta { name: key.clone(), r#type: "any".to_string() });
                }
            }
            for tuple in tuples {
                let mut row = Vec::new();
                for col in &columns {
                    let val = tuple.get(&col.name).cloned().unwrap_or(Value::Null);
                    row.push(val.to_json());
                }
                rows.push(row);
            }
        }

        let elapsed_ms = start.elapsed().as_millis() as u64;
        Ok(QueryResult {
            columns,
            rows,
            stats: Some(crate::types::QueryStats { elapsed_ms, scanned: counters.scanned, expanded: counters.expanded }),
        })
    }

    fn execute_node(&self, node: &PlanNode, write: &mut Option<&mut dyn GraphWriteStore>, counters: &mut ExecCounters) -> Result<Vec<Tuple>, EngineError> {
        self.execute_node_with_context(node, &HashMap::new(), write, counters)
    }
    fn execute_node_with_context(&self, node: &PlanNode, parent_tuple: &Tuple, write: &mut Option<&mut dyn GraphWriteStore>, counters: &mut ExecCounters) -> Result<Vec<Tuple>, EngineError> {
        match node {
            PlanNode::Create { patterns } => {
                if let Some(w) = write.as_deref_mut() {
                    self.execute_create(patterns, parent_tuple, Some(w))
                } else {
                    Err(EngineError::InvalidArgument("CREATE requires a write-capable store".into()))
                }
            }
            PlanNode::MatchCreate { match_input, create_patterns } => {
                // For each matched tuple, execute CREATE with that context
                let match_tuples = {
                    let t = self.execute_node_with_context(match_input, parent_tuple, write, counters)?;
                    if std::env::var("CASYS_DEBUG_PLAN").ok().as_deref() == Some("1") {
                        println!("MATCH tuples for CREATE: {}", t.len());
                    }
                    t
                };
                if let Some(wi) = write.as_deref_mut() {
                    let mut all_results = Vec::new();
                    for tuple in match_tuples {
                        let created = self.execute_create(create_patterns, &tuple, Some(wi))?;
                        all_results.extend(created);
                    }
                    Ok(all_results)
                } else {
                    Err(EngineError::InvalidArgument("CREATE requires a write-capable store".into()))
                }
            }
            PlanNode::CartesianProduct { left, right } => {
                // Execute both sides
                let left_tuples = { self.execute_node_with_context(left, parent_tuple, write, counters)? };
                let right_tuples = { self.execute_node_with_context(right, parent_tuple, write, counters)? };
                
                // Cartesian product: combine every tuple from left with every tuple from right
                let mut result = Vec::new();
                for left_tuple in &left_tuples {
                    for right_tuple in &right_tuples {
                        let mut combined = left_tuple.clone();
                        // Merge right tuple into combined (right values overwrite if keys conflict)
                        for (k, v) in right_tuple {
                            combined.insert(k.clone(), v.clone());
                        }
                        result.push(combined);
                    }
                }
                Ok(result)
            }
            PlanNode::LabelScan { variable, label } => {
                // Check if variable already exists in parent tuple (correlated subquery)
                if let Some(existing_node_id) = parent_tuple.get(variable) {
                    // Variable exists in parent context - use it directly (correlated)
                    if let Value::NodeId(node_id) = existing_node_id {
                        // Fetch the node to verify it has the correct label
                        let node_opt = if let Some(r) = self.read {
                            r.get_node(*node_id)?
                        } else if let Some(w) = write.as_deref_mut() {
                            w.get_node(*node_id)?
                        } else {
                            None
                        };
                        if let Some(node) = node_opt {
                            if node.labels.contains(label) {
                                // Node matches - return single tuple with parent context
                                let mut tuple = parent_tuple.clone();
                                tuple.insert(variable.clone(), Value::NodeId(*node_id));
                                for (k, v) in node.properties {
                                    let prop_key = format!("{}.{}", variable, k);
                                    tuple.insert(prop_key, v);
                                }
                                return Ok(vec![tuple]);
                            }
                        }
                    }
                    // Variable exists but doesn't match - return empty
                    return Ok(vec![]);
                }
                
                // Variable doesn't exist in parent - normal scan
                let nodes = if let Some(r) = self.read {
                    r.scan_by_label(label)?
                } else if let Some(w) = write.as_deref_mut() {
                    w.scan_by_label(label)?
                } else {
                    Vec::new()
                };
                counters.scanned += nodes.len() as u64;
                Ok(nodes.into_iter().map(|n| {
                    let mut tuple = parent_tuple.clone();
                    tuple.insert(variable.clone(), Value::NodeId(n.id));
                    for (k, v) in n.properties {
                        let prop_key = format!("{}.{}", variable, k);
                        tuple.insert(prop_key, v);
                    }
                    tuple
                }).collect())
            }
            PlanNode::FullScan { variable } => {
                // Correlated subquery: if the variable already exists in parent context, reuse it
                if let Some(existing_node_id) = parent_tuple.get(variable) {
                    if let Value::NodeId(node_id) = existing_node_id {
                        let node_opt = if let Some(r) = self.read {
                            r.get_node(*node_id)?
                        } else if let Some(w) = write.as_deref_mut() {
                            w.get_node(*node_id)?
                        } else { None };
                        if let Some(node) = node_opt {
                            let mut tuple = parent_tuple.clone();
                            tuple.insert(variable.clone(), Value::NodeId(*node_id));
                            for (k, v) in node.properties {
                                let prop_key = format!("{}.{}", variable, k);
                                tuple.insert(prop_key, v);
                            }
                            return Ok(vec![tuple]);
                        }
                    }
                    // Variable exists but cannot be resolved -> empty
                    return Ok(vec![]);
                }
                // Non-correlated: scan all nodes
                let nodes = if let Some(r) = self.read { r.scan_all()? } else if let Some(w) = write.as_deref_mut() { w.scan_all()? } else { Vec::new() };
                counters.scanned += nodes.len() as u64;
                Ok(nodes.into_iter().map(|n| {
                    let mut tuple = parent_tuple.clone();
                    tuple.insert(variable.clone(), Value::NodeId(n.id));
                    for (k, v) in n.properties {
                        let prop_key = format!("{}.{}", variable, k);
                        tuple.insert(prop_key, v.clone());
                    }
                    tuple
                }).collect())
            }
            PlanNode::Filter { input, predicate } => {
                let tuples = self.execute_node_with_context(input, parent_tuple, write, counters)?;
                Ok(tuples.into_iter().filter(|t| {
                    self.eval_expr(predicate, t, None).ok()
                        .and_then(|v| match v {
                            Value::Bool(b) => Some(b),
                            _ => None,
                        })
                        .unwrap_or(false)
                }).collect())
            }
            PlanNode::Project { input, items } => {
                let tuples = self.execute_node_with_context(input, parent_tuple, write, counters)?;
                Ok(tuples.into_iter().map(|t| {
                    let mut result = HashMap::new();
                    for item in items {
                        if let Ok(val) = self.eval_expr(&item.expr, &t, None) {
                            let key = item.alias.clone().unwrap_or_else(|| {
                                match &item.expr {
                                    Expr::Ident(name) => name.clone(),
                                    Expr::Property(var, prop) => format!("{}.{}", var, prop),
                                    _ => "?".to_string(),
                                }
                            });
                            result.insert(key, val);
                        }
                    }
                    result
                }).collect())
            }
            PlanNode::Aggregate { input, group_by, aggregates } => {
                let tuples = self.execute_node_with_context(input, parent_tuple, write, counters)?;
                
                if group_by.is_empty() {
                    // Global aggregation (no GROUP BY)
                    let mut result = HashMap::new();
                    for (alias, agg_expr) in aggregates {
                        let val = self.eval_aggregate(agg_expr, &tuples, None)?;
                        result.insert(alias.clone(), val);
                    }
                    Ok(vec![result])
                } else {
                    // GROUP BY aggregation
                    let mut groups: HashMap<Vec<String>, Vec<Tuple>> = HashMap::new();
                    
                    // Group tuples by group_by expressions
                    for tuple in tuples {
                        let mut group_key = Vec::new();
                        for expr in group_by {
                            let val = self.eval_expr(expr, &tuple, None)?;
                            // Stable key serialization via JSON string
                            let key = serde_json::to_string(&val.to_json()).unwrap_or("null".to_string());
                            group_key.push(key);
                        }
                        groups.entry(group_key).or_insert_with(Vec::new).push(tuple);
                    }
                    
                    // Compute aggregates for each group
                    let mut results = Vec::new();
                    for (_group_key, group_tuples) in groups {
                        let mut result = HashMap::new();
                        
                        // Add GROUP BY columns (from first tuple of group)
                        if let Some(first) = group_tuples.first() {
                            for (idx, expr) in group_by.iter().enumerate() {
                                let val = self.eval_expr(expr, first, None)?;
                                let key = match expr {
                                    Expr::Ident(name) => name.clone(),
                                    Expr::Property(var, prop) => format!("{}.{}", var, prop),
                                    _ => format!("group_{}", idx),
                                };
                                result.insert(key, val);
                            }
                        }
                        
                        // Compute aggregates
                        for (alias, agg_expr) in aggregates {
                            let val = self.eval_aggregate(agg_expr, &group_tuples, None)?;
                            result.insert(alias.clone(), val);
                        }
                        
                        results.push(result);
                    }
                    
                    Ok(results)
                }
            }
            PlanNode::OrderBy { input, items } => {
                let mut tuples = self.execute_node_with_context(input, parent_tuple, write, counters)?;
                tuples.sort_by(|a, b| {
                    for item in items {
                        let val_a = self.eval_expr(&item.expr, a, None).ok();
                        let val_b = self.eval_expr(&item.expr, b, None).ok();
                        let cmp = match (val_a, val_b) {
                            (Some(Value::Int(ia)), Some(Value::Int(ib))) => ia.cmp(&ib),
                            (Some(Value::Float(fa)), Some(Value::Float(fb))) => {
                                fa.partial_cmp(&fb).unwrap_or(std::cmp::Ordering::Equal)
                            }
                            (Some(Value::String(sa)), Some(Value::String(sb))) => sa.cmp(&sb),
                            _ => std::cmp::Ordering::Equal,
                        };
                        if cmp != std::cmp::Ordering::Equal {
                            return if item.descending { cmp.reverse() } else { cmp };
                        }
                    }
                    std::cmp::Ordering::Equal
                });
                Ok(tuples)
            }
            PlanNode::Limit { input, count } => {
                let tuples = self.execute_node_with_context(input, parent_tuple, write, counters)?;
                Ok(tuples.into_iter().take(*count as usize).collect())
            }
            PlanNode::Expand { input, from_var, edge_var, to_var, edge_type, direction, depth } => {
                use super::ast::Direction;
                
                let input_tuples = { self.execute_node_with_context(input, parent_tuple, write, counters)? };
                let mut result = Vec::new();
                // Resolve reader once to avoid repeated mutable borrows of `write`
                let reader: &dyn GraphReadStore = if let Some(r) = self.read { r } else if let Some(w) = write.as_deref_mut() { w } else { return Ok(result) };

                for tuple in input_tuples {
                    // Get from_node_id
                    if let Some(Value::NodeId(from_id)) = tuple.get(from_var) {
                        // Check if variable-length path
                        if let Some(depth_range) = depth {
                            // Variable-length traversal with optional union edge types and direction
                            let edge_types: Vec<&str> = if let Some(et) = edge_type {
                                et.split('|').map(|s| s.trim()).filter(|s| !s.is_empty()).collect()
                            } else {
                                Vec::new()
                            };
                            let reachable = self.traverse_variable_length(
                                reader,
                                *from_id,
                                &edge_types,
                                direction.clone(),
                                depth_range.min,
                                depth_range.max,
                            )?;
                            let debug = std::env::var("CASYS_DEBUG_EXPAND").ok().as_deref() == Some("1");
                            if debug {
                                println!(
                                    "EXPAND varlen from {} to {} depth {}..{} -> {} nodes",
                                    from_var,
                                    to_var,
                                    depth_range.min,
                                    depth_range.max,
                                    reachable.len()
                                );
                            }
                            counters.expanded += reachable.len() as u64;
                            // Deduplicate and ensure we never emit the origin node
                            let mut emitted: HashSet<u64> = HashSet::new();
                            for to_node in reachable {
                                if to_node.id == *from_id { continue; }
                                if !emitted.insert(to_node.id) { continue; }
                                // If to_var already bound in incoming tuple and equals this node, skip
                                if let Some(Value::NodeId(existing)) = tuple.get(to_var) {
                                    if *existing == to_node.id { continue; }
                                }
                                let mut new_tuple = tuple.clone();
                                new_tuple.insert(to_var.clone(), Value::NodeId(to_node.id));
                                for (k, v) in &to_node.properties {
                                    let prop_key = format!("{}.{}", to_var, k);
                                    new_tuple.insert(prop_key, v.clone());
                                }
                                result.push(new_tuple);
                            }
                        } else {
                            // Single-hop traversal with direction support
                            // Check for union types (e.g., [:BOSS|FRIEND])
                            let edge_types: Vec<&str> = if let Some(et) = edge_type {
                                et.split('|').map(|s| s.trim()).collect()
                            } else {
                                vec![]
                            };
                            let mut neighbors = match direction {
                                Direction::Right => {
                                    // Outgoing: (from)-[:REL]->(to)
                                    reader.get_neighbors(*from_id, None)?
                                }
                                Direction::Left => {
                                    // Incoming: (to)-[:REL]->(from) donc on cherche incoming
                                    reader.get_neighbors_incoming(*from_id, None)?
                                }
                                Direction::Both => {
                                    // Both directions: combine outgoing + incoming
                                    let mut out = reader.get_neighbors(*from_id, None)?;
                                    let incoming = reader.get_neighbors_incoming(*from_id, None)?;
                                    out.extend(incoming);
                                    out
                                }
                            };
                            // Filter by edge types if union specified
                            if !edge_types.is_empty() {
                                neighbors.retain(|(edge, _)| edge_types.contains(&edge.edge_type.as_str()));
                            }
                            counters.expanded += neighbors.len() as u64;
                            for (edge, to_node) in neighbors {
                                let mut new_tuple = tuple.clone();
                                // If to_var already bound in incoming tuple and equals this node, skip
                                if let Some(Value::NodeId(existing)) = tuple.get(to_var) {
                                    if *existing == to_node.id { continue; }
                                }
                                
                                // Add to_node to tuple
                                new_tuple.insert(to_var.clone(), Value::NodeId(to_node.id));
                                for (k, v) in &to_node.properties {
                                    let prop_key = format!("{}.{}", to_var, k);
                                    new_tuple.insert(prop_key, v.clone());
                                }
                                
                                // Add edge to tuple if variable specified
                                if let Some(ref ev) = edge_var {
                                    new_tuple.insert(ev.clone(), Value::Int(edge.id as i64));
                                    // Add edge type for union type support
                                    let edge_type_key = format!("{}.edge_type", ev);
                                    new_tuple.insert(edge_type_key, Value::String(edge.edge_type.clone()));
                                    for (k, v) in &edge.properties {
                                        let prop_key = format!("{}.{}", ev, k);
                                        new_tuple.insert(prop_key, v.clone());
                                    }
                                }
                                
                                result.push(new_tuple);
                            }
                        }
                    }
                }
                
                Ok(result)
            }
        }
    }

    /// Traverse variable-length paths using BFS with optional union edge types and direction
    fn traverse_variable_length(
        &self,
        reader: &dyn GraphReadStore,
        start_id: u64,
        edge_types: &[&str],
        direction: super::ast::Direction,
        min_depth: u32,
        max_depth: u32,
    ) -> Result<Vec<crate::index::Node>, EngineError> {
        use std::collections::{HashSet, VecDeque};
        use super::ast::Direction;
        
        let mut result = Vec::new();
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        
        // BFS: (node_id, current_depth)
        queue.push_back((start_id, 0));
        visited.insert(start_id);
        
        let debug = std::env::var("CASYS_DEBUG_EXPAND").ok().as_deref() == Some("1");
        while let Some((node_id, depth)) = queue.pop_front() {
            if debug {
                println!("BFS pop node {} at depth {}", node_id, depth);
            }
            // If we've reached max depth, stop expanding from this node
            if depth >= max_depth {
                continue;
            }
            
            // Collect neighbors according to direction
            let mut neighbors = match direction {
                Direction::Right => reader.get_neighbors(node_id, None)?,
                Direction::Left => reader.get_neighbors_incoming(node_id, None)?,
                Direction::Both => {
                    let mut out = reader.get_neighbors(node_id, None)?;
                    let incoming = reader.get_neighbors_incoming(node_id, None)?;
                    out.extend(incoming);
                    out
                }
            };
            if debug {
                println!(
                    "Neighbors before type filter for node {}: {}",
                    node_id,
                    neighbors.len()
                );
            }
            
            // Filter by edge types if provided
            if !edge_types.is_empty() {
                neighbors.retain(|(edge, _)| edge_types.contains(&edge.edge_type.as_str()));
                if debug {
                    println!(
                        "Neighbors after type filter (types={:?}) for node {}: {}",
                        edge_types,
                        node_id,
                        neighbors.len()
                    );
                }
            }
            
            for (_edge, to_node) in neighbors {
                if visited.contains(&to_node.id) {
                    continue;
                }
                // Mark visited immediately to avoid duplicates across different parents
                visited.insert(to_node.id);
                let next_depth = depth + 1;
                // Add to result if within depth range and exclude the origin node
                if next_depth >= min_depth && next_depth <= max_depth && to_node.id != start_id {
                    if debug {
                        println!(
                            "Add node {} to results at depth {}",
                            to_node.id,
                            next_depth
                        );
                    }
                    result.push(to_node.clone());
                }
                // Continue BFS if haven't reached max depth
                if next_depth < max_depth {
                    if debug {
                        println!("Queue node {} at depth {}", to_node.id, next_depth);
                    }
                    queue.push_back((to_node.id, next_depth));
                }
            }
        }
        
        Ok(result)
    }

    fn eval_expr<'w>(&'w self, expr: &Expr, tuple: &Tuple, mut write: Option<&'w mut dyn GraphWriteStore>) -> Result<Value, EngineError> {
        match expr {
            Expr::Literal(lit) => Ok(match lit {
                Literal::String(s) => Value::String(s.clone()),
                Literal::Int(i) => Value::Int(*i),
                Literal::Float(f) => Value::Float(*f),
                Literal::Bool(b) => Value::Bool(*b),
                Literal::Null => Value::Null,
            }),
            Expr::Ident(name) => {
                tuple.get(name).cloned()
                    .ok_or_else(|| EngineError::InvalidArgument(format!("variable not found: {}", name)))
            }
            Expr::Property(var, prop) => {
                let key = format!("{}.{}", var, prop);
                tuple.get(&key).cloned()
                    .ok_or_else(|| EngineError::InvalidArgument(format!("property not found: {}", key)))
            }
            Expr::BinaryOp(left, op, right) => {
                let l = self.eval_expr(left, tuple, None)?;
                let r = self.eval_expr(right, tuple, None)?;
                self.eval_binary_op(&l, op, &r)
            }
            Expr::UnaryOp(op, operand) => {
                let val = self.eval_expr(operand, tuple, None)?;
                match op {
                    UnOp::Not => match val {
                        Value::Bool(b) => Ok(Value::Bool(!b)),
                        _ => Err(EngineError::InvalidArgument("NOT requires boolean".into())),
                    }
                }
            }
            Expr::Parameter(param_name) => {
                self.parameters
                    .get(param_name)
                    .cloned()
                    .ok_or_else(|| EngineError::InvalidArgument(format!(
                        "parameter ${} not bound - pass it in params argument",
                        param_name
                    )))
            }
            Expr::IsNull(expr) => {
                let val = self.eval_expr(expr, tuple, None)?;
                Ok(Value::Bool(matches!(val, Value::Null)))
            }
            Expr::IsNotNull(expr) => {
                let val = self.eval_expr(expr, tuple, None)?;
                Ok(Value::Bool(!matches!(val, Value::Null)))
            }
            Expr::FunctionCall(name, args) => {
                match name.to_uppercase().as_str() {
                    "ID" => {
                        // ID(node) - extract node ID from node reference
                        if args.len() != 1 {
                            return Err(EngineError::InvalidArgument("ID() requires exactly 1 argument".into()));
                        }
                        let arg_val = self.eval_expr(&args[0], tuple, None)?;
                        match arg_val {
                            Value::NodeId(id) => Ok(Value::Int(id as i64)),
                            _ => Err(EngineError::InvalidArgument("ID() requires a node argument".into())),
                        }
                    }
                    _ => Err(EngineError::InvalidArgument(format!("unknown function: {}", name))),
                }
            }
            Expr::Exists(subquery) => {
                // Fast-path for simple pattern EXISTS { MATCH (x)-[:TYPE]->(:Label) }
                if subquery.where_clause.is_none() && subquery.match_clause.is_some() {
                    let patterns = &subquery.match_clause.as_ref().unwrap().patterns;
                    if let Some(first) = patterns.get(0) {
                        if let super::ast::Pattern::Edge(edge) = first {
                            if let Some(ref from_var) = edge.from_node.variable {
                                if let Some(Value::NodeId(from_id)) = tuple.get(from_var) {
                                    // Select reader
                                    let reader: &dyn GraphReadStore = if let Some(r) = self.read { r } else if let Some(w) = write.as_deref_mut() { w } else { return Ok(Value::Bool(false)); };
                                    // To-node label filter
                                    let label_matches = |node: &crate::index::Node| -> bool {
                                        if edge.to_node.labels.is_empty() { return true; }
                                        edge.to_node.labels.iter().any(|lbl| node.labels.contains(lbl))
                                    };
                                    // Variable-length
                                    if let Some(depth) = &edge.depth {
                                        // Support union edge types
                                        let edge_types: Vec<&str> = edge
                                            .edge_type
                                            .as_deref()
                                            .map(|s| s.split('|').map(|t| t.trim()).filter(|t| !t.is_empty()).collect())
                                            .unwrap_or_else(|| Vec::new());
                                        let reachable = self.traverse_variable_length(
                                            reader,
                                            *from_id,
                                            &edge_types,
                                            edge.direction.clone(),
                                            depth.min,
                                            depth.max,
                                        )?;
                                        let any = reachable.into_iter().any(|n| label_matches(&n));
                                        return Ok(Value::Bool(any));
                                    }
                                    // Single-hop with direction and type union
                                    use super::ast::Direction;
                                    let mut neighbors = match edge.direction {
                                        Direction::Right => reader.get_neighbors(*from_id, edge.edge_type.as_deref())?,
                                        Direction::Left => reader.get_neighbors_incoming(*from_id, edge.edge_type.as_deref())?,
                                        Direction::Both => {
                                            let mut out = reader.get_neighbors(*from_id, edge.edge_type.as_deref())?;
                                            let incoming = reader.get_neighbors_incoming(*from_id, edge.edge_type.as_deref())?;
                                            out.extend(incoming);
                                            out
                                        }
                                    };
                                    // Filter to-node labels
                                    neighbors.retain(|(_e, to)| label_matches(to));
                                    return Ok(Value::Bool(!neighbors.is_empty()));
                                }
                            }
                        }
                    }
                }
                // General fallback: execute subquery plan
                let plan = crate::exec::planner::Planner::plan(subquery)
                    .map_err(|e| EngineError::InvalidArgument(format!("EXISTS subquery planning error: {:?}", e)))?;
                let reader: &dyn GraphReadStore = if let Some(r) = self.read { r } else if let Some(w) = write.as_deref_mut() { w } else { return Ok(Value::Bool(false)); };
                let sub_executor = Executor { read: Some(reader), parameters: self.parameters.clone() };
                let mut none: Option<&mut dyn GraphWriteStore> = None;
                let mut sub_counters = ExecCounters::default();
                let sub_tuples = sub_executor.execute_node_with_context(&plan.root, tuple, &mut none, &mut sub_counters)?;
                Ok(Value::Bool(!sub_tuples.is_empty()))
            }
            Expr::Aggregate(_, _) => Err(EngineError::InvalidArgument("aggregate must be evaluated at Project".into())),
        }
    }

    fn eval_binary_op(&self, left: &Value, op: &BinOp, right: &Value) -> Result<Value, EngineError> {
        match (left, right) {
            // Int operations (arithmetic + comparison)
            (Value::Int(l), Value::Int(r)) => match op {
                // Arithmetic
                BinOp::Add => Ok(Value::Int(l + r)),
                BinOp::Sub => Ok(Value::Int(l - r)),
                BinOp::Mul => Ok(Value::Int(l * r)),
                BinOp::Div => {
                    if *r == 0 {
                        Err(EngineError::InvalidArgument("division by zero".into()))
                    } else {
                        Ok(Value::Int(l / r))
                    }
                }
                // Comparison
                BinOp::Eq => Ok(Value::Bool(l == r)),
                BinOp::Ne => Ok(Value::Bool(l != r)),
                BinOp::Lt => Ok(Value::Bool(l < r)),
                BinOp::Le => Ok(Value::Bool(l <= r)),
                BinOp::Gt => Ok(Value::Bool(l > r)),
                BinOp::Ge => Ok(Value::Bool(l >= r)),
                _ => Err(EngineError::InvalidArgument("invalid int op".into())),
            },
            // Float operations (arithmetic + comparison)
            (Value::Float(l), Value::Float(r)) => match op {
                // Arithmetic
                BinOp::Add => Ok(Value::Float(l + r)),
                BinOp::Sub => Ok(Value::Float(l - r)),
                BinOp::Mul => Ok(Value::Float(l * r)),
                BinOp::Div => {
                    if *r == 0.0 {
                        Err(EngineError::InvalidArgument("division by zero".into()))
                    } else {
                        Ok(Value::Float(l / r))
                    }
                }
                // Comparison
                BinOp::Eq => Ok(Value::Bool(l == r)),
                BinOp::Ne => Ok(Value::Bool(l != r)),
                BinOp::Lt => Ok(Value::Bool(l < r)),
                BinOp::Le => Ok(Value::Bool(l <= r)),
                BinOp::Gt => Ok(Value::Bool(l > r)),
                BinOp::Ge => Ok(Value::Bool(l >= r)),
                _ => Err(EngineError::InvalidArgument("invalid float op".into())),
            },
            // Mixed int/float (coercion to float)
            (Value::Int(l), Value::Float(r)) => {
                let lf = *l as f64;
                match op {
                    // Arithmetic
                    BinOp::Add => Ok(Value::Float(lf + r)),
                    BinOp::Sub => Ok(Value::Float(lf - r)),
                    BinOp::Mul => Ok(Value::Float(lf * r)),
                    BinOp::Div => {
                        if *r == 0.0 {
                            Err(EngineError::InvalidArgument("division by zero".into()))
                        } else {
                            Ok(Value::Float(lf / r))
                        }
                    }
                    // Comparison
                    BinOp::Eq => Ok(Value::Bool(lf == *r)),
                    BinOp::Ne => Ok(Value::Bool(lf != *r)),
                    BinOp::Lt => Ok(Value::Bool(lf < *r)),
                    BinOp::Le => Ok(Value::Bool(lf <= *r)),
                    BinOp::Gt => Ok(Value::Bool(lf > *r)),
                    BinOp::Ge => Ok(Value::Bool(lf >= *r)),
                    _ => Err(EngineError::InvalidArgument("invalid numeric op".into())),
                }
            }
            (Value::Float(l), Value::Int(r)) => {
                let rf = *r as f64;
                match op {
                    // Arithmetic
                    BinOp::Add => Ok(Value::Float(l + rf)),
                    BinOp::Sub => Ok(Value::Float(l - rf)),
                    BinOp::Mul => Ok(Value::Float(l * rf)),
                    BinOp::Div => {
                        if *r == 0 {
                            Err(EngineError::InvalidArgument("division by zero".into()))
                        } else {
                            Ok(Value::Float(l / rf))
                        }
                    }
                    // Comparison
                    BinOp::Eq => Ok(Value::Bool(*l == rf)),
                    BinOp::Ne => Ok(Value::Bool(*l != rf)),
                    BinOp::Lt => Ok(Value::Bool(*l < rf)),
                    BinOp::Le => Ok(Value::Bool(*l <= rf)),
                    BinOp::Gt => Ok(Value::Bool(*l > rf)),
                    BinOp::Ge => Ok(Value::Bool(*l >= rf)),
                    _ => Err(EngineError::InvalidArgument("invalid numeric op".into())),
                }
            }
            // Bool comparisons
            (Value::Bool(l), Value::Bool(r)) => Ok(Value::Bool(match op {
                BinOp::And => *l && *r,
                BinOp::Or => *l || *r,
                BinOp::Eq => l == r,
                BinOp::Ne => l != r,
                _ => return Err(EngineError::InvalidArgument("invalid bool op".into())),
            })),
            // String comparisons
            (Value::String(l), Value::String(r)) => Ok(Value::Bool(match op {
                BinOp::Eq => l == r,
                BinOp::Ne => l != r,
                _ => return Err(EngineError::InvalidArgument("invalid string op".into())),
            })),
            _ => Err(EngineError::InvalidArgument(format!(
                "type mismatch in binary op: {:?} {:?} {:?}",
                left, op, right
            ))),
        }
    }
    
    fn eval_aggregate(&self, expr: &Expr, tuples: &[Tuple], _write: Option<&mut dyn GraphWriteStore>) -> Result<Value, EngineError> {
        match expr {
            Expr::Aggregate(func, arg) => match func {
                AggFunc::Count => Ok(Value::Int(tuples.len() as i64)),
                AggFunc::Sum => {
                    let mut sum = 0.0f64;
                    for t in tuples {
                        if let Ok(v) = self.eval_expr(arg, t, None) {
                            match v {
                                Value::Int(i) => sum += i as f64,
                                Value::Float(f) => sum += f,
                                _ => {}
                            }
                        }
                    }
                    Ok(Value::Float(sum))
                }
                AggFunc::Avg => {
                    let mut sum = 0.0f64;
                    let mut cnt = 0usize;
                    for t in tuples {
                        if let Ok(v) = self.eval_expr(arg, t, None) {
                            match v {
                                Value::Int(i) => { sum += i as f64; cnt += 1; }
                                Value::Float(f) => { sum += f; cnt += 1; }
                                _ => {}
                            }
                        }
                    }
                    if cnt == 0 { Ok(Value::Null) } else { Ok(Value::Float(sum / cnt as f64)) }
                }
                AggFunc::Min => {
                    let mut best: Option<f64> = None;
                    for t in tuples {
                        if let Ok(v) = self.eval_expr(arg, t, None) {
                            let cur = match v { Value::Int(i) => i as f64, Value::Float(f) => f, _ => continue };
                            best = Some(match best { Some(b) => b.min(cur), None => cur });
                        }
                    }
                    Ok(best.map(Value::Float).unwrap_or(Value::Null))
                }
                AggFunc::Max => {
                    let mut best: Option<f64> = None;
                    for t in tuples {
                        if let Ok(v) = self.eval_expr(arg, t, None) {
                            let cur = match v { Value::Int(i) => i as f64, Value::Float(f) => f, _ => continue };
                            best = Some(match best { Some(b) => b.max(cur), None => cur });
                        }
                    }
                    Ok(best.map(Value::Float).unwrap_or(Value::Null))
                }
            },
            _ => Err(EngineError::InvalidArgument("expected aggregate expression".into())),
        }
    }
    
    fn execute_create(&self, patterns: &[Pattern], parent_tuple: &Tuple, write: Option<&mut dyn GraphWriteStore>) -> Result<Vec<Tuple>, EngineError> {
        let write = write.ok_or_else(|| EngineError::InvalidArgument("CREATE requires a write-capable store".into()))?;
        let mut created_vars: HashMap<String, u64> = HashMap::new();
        let mut result_tuple = parent_tuple.clone();
        
        for pattern in patterns {
            match pattern {
                Pattern::Node(node_pattern) => {
                    // Evaluate properties (may contain expressions from parent tuple)
                    let mut props = HashMap::new();
                    for (key, lit) in &node_pattern.properties {
                        let value = self.eval_literal(lit)?;
                        props.insert(key.clone(), value);
                    }
                    
                    // Create the node
                    let node_id = write.add_node(node_pattern.labels.clone(), props)?;
                    
                    // Store in created_vars if it has a variable
                    if let Some(ref var) = node_pattern.variable {
                        created_vars.insert(var.clone(), node_id);
                        result_tuple.insert(var.clone(), Value::NodeId(node_id));
                    }
                }
                Pattern::Edge(edge_pattern) => {
                    // Resolve from_node
                    let from_id = if let Some(ref var) = edge_pattern.from_node.variable {
                        created_vars.get(var).copied()
                            .or_else(|| {
                                parent_tuple.get(var).and_then(|v| match v {
                                    Value::NodeId(id) => Some(*id),
                                    _ => None,
                                })
                            })
                            .ok_or_else(|| EngineError::InvalidArgument(format!("undefined variable: {}", var)))?
                    } else {
                        return Err(EngineError::InvalidArgument("edge from_node must have variable".into()));
                    };
                    
                    // Resolve to_node
                    let to_id = if let Some(ref var) = edge_pattern.to_node.variable {
                        created_vars.get(var).copied()
                            .or_else(|| {
                                parent_tuple.get(var).and_then(|v| match v {
                                    Value::NodeId(id) => Some(*id),
                                    _ => None,
                                })
                            })
                            .ok_or_else(|| EngineError::InvalidArgument(format!("undefined variable: {}", var)))?
                    } else {
                        return Err(EngineError::InvalidArgument("edge to_node must have variable".into()));
                    };
                    
                    // Evaluate edge properties
                    let mut props = HashMap::new();
                    for (key, lit) in &edge_pattern.properties {
                        let value = self.eval_literal(lit)?;
                        props.insert(key.clone(), value);
                    }
                    
                    // Create the edge
                    let edge_type = edge_pattern.edge_type.clone()
                        .ok_or_else(|| EngineError::InvalidArgument("edge must have type".into()))?;
                    let edge_id = write.add_edge(from_id, to_id, edge_type.clone(), props)?;
                    if std::env::var("CASYS_DEBUG_PLAN").ok().as_deref() == Some("1") {
                        println!("CREATE edge id={} {} -> {} type={} ", edge_id, from_id, to_id, edge_type);
                    }
                    
                    // Store edge variable if present (as Int for now)
                    if let Some(ref var) = edge_pattern.variable {
                        result_tuple.insert(var.clone(), Value::Int(edge_id as i64));
                    }
                }
            }
        }
        
        // Return single tuple with all created variables
        Ok(vec![result_tuple])
    }
    
    fn eval_literal(&self, lit: &Literal) -> Result<Value, EngineError> {
        Ok(match lit {
            Literal::String(s) => Value::String(s.clone()),
            Literal::Int(i) => Value::Int(*i),
            Literal::Float(f) => Value::Float(*f),
            Literal::Bool(b) => Value::Bool(*b),
            Literal::Null => Value::Null,
        })
    }
}
