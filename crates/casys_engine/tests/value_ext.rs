//! Tests for casys_core::Value unified type and ValueExt extension trait
//! Added as part of Story 15.R1 code review

use casys_core::{Value, NodeId};
use casys_engine::exec::executor::ValueExt;
use std::collections::BTreeMap;

#[test]
fn test_value_nodeid_to_json() {
    let node_id: NodeId = 42;
    let value = Value::NodeId(node_id);
    let json = value.to_json();

    assert_eq!(json, serde_json::json!(42));
}

#[test]
fn test_value_nodeid_roundtrip() {
    // NodeId -> JSON -> Value (becomes Int since JSON has no NodeId type)
    let original = Value::NodeId(123);
    let json = original.to_json();
    let recovered = Value::from_json(&json);

    // NodeId serializes to number, deserializes back as Int (expected behavior)
    assert_eq!(recovered, Some(Value::Int(123)));
}

#[test]
fn test_value_string_roundtrip() {
    let original = Value::String("hello".to_string());
    let json = original.to_json();
    let recovered = Value::from_json(&json).unwrap();

    assert_eq!(original, recovered);
}

#[test]
fn test_value_int_roundtrip() {
    let original = Value::Int(-42);
    let json = original.to_json();
    let recovered = Value::from_json(&json).unwrap();

    assert_eq!(original, recovered);
}

#[test]
fn test_value_float_roundtrip() {
    let original = Value::Float(3.14159);
    let json = original.to_json();
    let recovered = Value::from_json(&json).unwrap();

    assert_eq!(original, recovered);
}

#[test]
fn test_value_bool_roundtrip() {
    for b in [true, false] {
        let original = Value::Bool(b);
        let json = original.to_json();
        let recovered = Value::from_json(&json).unwrap();
        assert_eq!(original, recovered);
    }
}

#[test]
fn test_value_null_roundtrip() {
    let original = Value::Null;
    let json = original.to_json();
    let recovered = Value::from_json(&json).unwrap();

    assert_eq!(original, recovered);
}

#[test]
fn test_value_bytes_to_json() {
    let original = Value::Bytes(vec![0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello" in bytes
    let json = original.to_json();

    // Should be base64 encoded
    assert!(json.is_string());
    assert_eq!(json.as_str().unwrap(), "SGVsbG8=");
}

#[test]
fn test_value_array_roundtrip() {
    let original = Value::Array(vec![
        Value::Int(1),
        Value::String("two".to_string()),
        Value::Bool(true),
    ]);
    let json = original.to_json();
    let recovered = Value::from_json(&json).unwrap();

    assert_eq!(original, recovered);
}

#[test]
fn test_value_map_roundtrip() {
    let mut map = BTreeMap::new();
    map.insert("name".to_string(), Value::String("Alice".to_string()));
    map.insert("age".to_string(), Value::Int(30));

    let original = Value::Map(map);
    let json = original.to_json();
    let recovered = Value::from_json(&json).unwrap();

    assert_eq!(original, recovered);
}

#[test]
fn test_value_nested_structures() {
    let mut inner_map = BTreeMap::new();
    inner_map.insert("x".to_string(), Value::Int(10));
    inner_map.insert("y".to_string(), Value::Int(20));

    let original = Value::Array(vec![
        Value::Map(inner_map),
        Value::Array(vec![Value::Bool(true), Value::Null]),
    ]);

    let json = original.to_json();
    let recovered = Value::from_json(&json).unwrap();

    assert_eq!(original, recovered);
}

#[test]
fn test_value_partialeq() {
    // Test PartialEq derive (AC1 requirement)
    assert_eq!(Value::Int(42), Value::Int(42));
    assert_ne!(Value::Int(42), Value::Int(43));
    assert_eq!(Value::NodeId(1), Value::NodeId(1));
    assert_ne!(Value::NodeId(1), Value::NodeId(2));
    assert_ne!(Value::Int(1), Value::NodeId(1)); // Different variants
}
