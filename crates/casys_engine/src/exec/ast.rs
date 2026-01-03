//! AST minimal pour ISO GQL MVP (MATCH/WHERE/RETURN/LIMIT)

use std::collections::{HashMap, HashSet};

/// Multiple statements (batch execution)
#[derive(Debug, Clone, PartialEq)]
pub struct QueryBatch {
    pub queries: Vec<Query>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub match_clause: Option<MatchClause>,    // Optional MATCH
    pub create_clause: Option<CreateClause>,  // Optional CREATE
    pub with_clause: Option<WithClause>,      // Pipeline transformation
    pub where_clause: Option<WhereClause>,
    pub return_clause: Option<ReturnClause>,  // Optional for CREATE without RETURN
    pub order_by: Option<OrderByClause>,
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatchClause {
    pub patterns: Vec<Pattern>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreateClause {
    pub patterns: Vec<Pattern>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Pattern {
    Node(NodePattern),
    Edge(EdgePattern),
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodePattern {
    pub variable: Option<String>,
    pub labels: Vec<String>,
    pub properties: HashMap<String, Literal>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EdgePattern {
    pub variable: Option<String>,
    pub edge_type: Option<String>,
    pub direction: Direction,
    pub properties: HashMap<String, Literal>,
    pub from_node: Box<NodePattern>,
    pub to_node: Box<NodePattern>,
    pub depth: Option<DepthRange>,  // For variable-length paths: *min..max
}

#[derive(Debug, Clone, PartialEq)]
pub struct DepthRange {
    pub min: u32,
    pub max: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Direction {
    Left,     // <-
    Right,    // ->
    Both,     // -
}

#[derive(Debug, Clone, PartialEq)]
pub struct WhereClause {
    pub expr: Expr,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WithClause {
    pub items: Vec<WithItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WithItem {
    pub expr: Expr,
    pub alias: String,  // Required in WITH (unlike RETURN where it's optional)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Literal(Literal),
    Ident(String),
    Property(String, String), // variable.property
    Parameter(String),        // $paramName - named parameter for prepared queries
    BinaryOp(Box<Expr>, BinOp, Box<Expr>),
    UnaryOp(UnOp, Box<Expr>),
    Aggregate(AggFunc, Box<Expr>),
    FunctionCall(String, Vec<Expr>), // Generic function calls (ID, etc.)
    IsNull(Box<Expr>),        // expr IS NULL
    IsNotNull(Box<Expr>),     // expr IS NOT NULL
    Exists(Box<Query>),       // EXISTS { subquery } - returns true if subquery has results
}

#[derive(Debug, Clone, PartialEq)]
pub enum AggFunc {
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BinOp {
    // Comparison
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    // Logical
    And,
    Or,
    // Arithmetic
    Add,
    Sub,
    Mul,
    Div,
}

#[derive(Debug, Clone, PartialEq)]
pub enum UnOp {
    Not,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    String(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Null,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReturnClause {
    pub items: Vec<ReturnItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReturnItem {
    pub expr: Expr,
    pub alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderByClause {
    pub items: Vec<OrderByItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderByItem {
    pub expr: Expr,
    pub descending: bool,
}

impl Query {
    /// Extracts all parameter names used in this query
    pub fn extract_parameters(&self) -> HashSet<String> {
        let mut params = HashSet::new();
        
        // Extract from WITH clause
        if let Some(with_clause) = &self.with_clause {
            for item in &with_clause.items {
                item.expr.collect_parameters(&mut params);
            }
        }
        
        // Extract from WHERE clause
        if let Some(where_clause) = &self.where_clause {
            where_clause.expr.collect_parameters(&mut params);
        }
        
        // Extract from RETURN clause (if present)
        if let Some(ref return_clause) = self.return_clause {
            for item in &return_clause.items {
                item.expr.collect_parameters(&mut params);
            }
        }
        
        // Extract from ORDER BY clause
        if let Some(order_by) = &self.order_by {
            for item in &order_by.items {
                item.expr.collect_parameters(&mut params);
            }
        }
        
        params
    }
}

impl Expr {
    /// Recursively collect all parameter names in this expression
    pub fn collect_parameters(&self, params: &mut HashSet<String>) {
        match self {
            Expr::Parameter(name) => {
                params.insert(name.clone());
            }
            Expr::BinaryOp(left, _, right) => {
                left.collect_parameters(params);
                right.collect_parameters(params);
            }
            Expr::UnaryOp(_, operand) => {
                operand.collect_parameters(params);
            }
            Expr::IsNull(expr) | Expr::IsNotNull(expr) => {
                expr.collect_parameters(params);
            }
            Expr::Aggregate(_, arg) => {
                arg.collect_parameters(params);
            }
            Expr::Exists(subquery) => {
                // Recursively collect parameters from subquery
                let subquery_params = subquery.extract_parameters();
                params.extend(subquery_params);
            }
            _ => {} // Literals, Idents, Properties have no parameters
        }
    }
}
