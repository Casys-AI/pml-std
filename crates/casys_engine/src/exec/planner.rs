//! Planner: transforme AST en plan d'exécution physique

use super::ast::*;
use crate::types::EngineError;

#[derive(Debug, Clone)]
pub struct ExecutionPlan {
    pub root: PlanNode,
}

#[derive(Debug, Clone)]
pub enum PlanNode {
    // Scan nodes by label (uses label index if available)
    LabelScan {
        variable: String,
        label: String,
    },
    // Full table scan (no index)
    FullScan {
        variable: String,
    },
    // Create nodes and edges
    Create {
        patterns: Vec<Pattern>,
    },
    // Match then Create (for MATCH ... CREATE pattern)
    MatchCreate {
        match_input: Box<PlanNode>,
        create_patterns: Vec<Pattern>,
    },
    // Filter predicate
    Filter {
        input: Box<PlanNode>,
        predicate: Expr,
    },
    // Project (select columns)
    Project {
        input: Box<PlanNode>,
        items: Vec<ReturnItem>,
    },
    // Order results
    OrderBy {
        input: Box<PlanNode>,
        items: Vec<super::ast::OrderByItem>,
    },
    // Aggregate (with optional GROUP BY)
    Aggregate {
        input: Box<PlanNode>,
        group_by: Vec<Expr>,
        aggregates: Vec<(String, Expr)>, // (alias, aggregate_expr)
    },
    // Limit results
    Limit {
        input: Box<PlanNode>,
        count: u64,
    },
    // Expand edges (adjacency traversal)
    Expand {
        input: Box<PlanNode>,
        from_var: String,
        edge_var: Option<String>,
        to_var: String,
        edge_type: Option<String>,
        direction: Direction,  // Left (<-), Right (->), Both (-)
        depth: Option<super::ast::DepthRange>,  // For variable-length paths
    },
    // Cartesian product (for MATCH (a), (b) patterns)
    CartesianProduct {
        left: Box<PlanNode>,
        right: Box<PlanNode>,
    },
}

pub struct Planner;

impl Planner {
    pub fn plan(query: &Query) -> Result<ExecutionPlan, EngineError> {
        // Debug: print patterns for MATCH and CREATE clauses
        if std::env::var("CASYS_DEBUG_PLAN").ok().as_deref() == Some("1") {
            if let Some(ref m) = query.match_clause {
                println!("MATCH PATTERNS: {:#?}", m.patterns);
            }
            if let Some(ref c) = query.create_clause {
                println!("CREATE PATTERNS: {:#?}", c.patterns);
            }
        }
        // Handle different clause combinations
        let mut plan = if query.match_clause.is_some() && query.create_clause.is_some() {
            // MATCH ... CREATE pattern
            let match_plan = Self::plan_match(query.match_clause.as_ref().unwrap())?;
            PlanNode::MatchCreate {
                match_input: Box::new(match_plan),
                create_patterns: query.create_clause.as_ref().unwrap().patterns.clone(),
            }
        } else if let Some(ref match_clause) = query.match_clause {
            // MATCH only
            Self::plan_match(match_clause)?
        } else if let Some(ref create_clause) = query.create_clause {
            // CREATE only
            Self::plan_create(create_clause)?
        } else {
            return Err(EngineError::InvalidArgument("query must have MATCH or CREATE".into()));
        };

        // Apply WITH transformation if present (pipeline intermediate projection)
        if let Some(ref with_clause) = query.with_clause {
            // Convert WithItem to ReturnItem for projection
            let items: Vec<ReturnItem> = with_clause.items.iter()
                .map(|item| ReturnItem {
                    expr: item.expr.clone(),
                    alias: Some(item.alias.clone()),
                })
                .collect();
            
            plan = PlanNode::Project {
                input: Box::new(plan),
                items,
            };
        }

        // Apply WHERE filter if present
        if let Some(ref where_clause) = query.where_clause {
            plan = PlanNode::Filter {
                input: Box::new(plan),
                predicate: where_clause.expr.clone(),
            };
        }

        // RETURN is optional for CREATE
        if query.return_clause.is_none() {
            return Ok(ExecutionPlan { root: plan });
        }
        
        let return_clause = query.return_clause.as_ref().unwrap();

        // Check if RETURN has aggregates
        let has_aggregates = return_clause.items.iter().any(|item| Self::has_aggregate(&item.expr));
        
        if has_aggregates {
            // Separate GROUP BY expressions from aggregates
            let mut group_by = Vec::new();
            let mut aggregates = Vec::new();
            
            for item in &return_clause.items {
                if Self::has_aggregate(&item.expr) {
                    // This is an aggregate
                    let alias = item.alias.clone().unwrap_or_else(|| {
                        match &item.expr {
                            Expr::Aggregate(func, _) => format!("{:?}", func).to_lowercase(),
                            _ => "agg".to_string(),
                        }
                    });
                    aggregates.push((alias, item.expr.clone()));
                } else {
                    // Non-aggregate in SELECT with aggregate → implicit GROUP BY
                    group_by.push(item.expr.clone());
                }
            }
            
            plan = PlanNode::Aggregate {
                input: Box::new(plan),
                group_by,
                aggregates,
            };
        } else {
            // Normal projection
            plan = PlanNode::Project {
                input: Box::new(plan),
                items: return_clause.items.clone(),
            };
        }

        // Apply ORDER BY if present
        if let Some(ref order_by) = query.order_by {
            plan = PlanNode::OrderBy {
                input: Box::new(plan),
                items: order_by.items.clone(),
            };
        }

        // Apply LIMIT if present
        if let Some(limit) = query.limit {
            plan = PlanNode::Limit {
                input: Box::new(plan),
                count: limit,
            };
        }

        let ep = ExecutionPlan { root: plan };
        if std::env::var("CASYS_DEBUG_PLAN").ok().as_deref() == Some("1") {
            println!("PLAN: {:#?}", ep);
        }
        Ok(ep)
    }

    fn plan_match(match_clause: &MatchClause) -> Result<PlanNode, EngineError> {
        if match_clause.patterns.is_empty() {
            return Err(EngineError::InvalidArgument("empty MATCH clause".into()));
        }

        if std::env::var("CASYS_DEBUG_PLAN").ok().as_deref() == Some("1") {
            println!("PATTERNS: {:#?}", match_clause.patterns);
        }

        let mut plan_opt: Option<PlanNode> = None;
        let mut bound_vars: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Pre-collect variables that appear as to_node in any edge pattern.
        // If Edge.to_node has no explicit variable, derive from the following Node pattern if present.
        let mut to_node_vars: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (idx, p) in match_clause.patterns.iter().enumerate() {
            if let Pattern::Edge(e) = p {
                if let Some(var) = &e.to_node.variable {
                    to_node_vars.insert(var.clone());
                } else if idx + 1 < match_clause.patterns.len() {
                    if let Pattern::Node(next_node) = &match_clause.patterns[idx + 1] {
                        if let Some(var) = &next_node.variable {
                            to_node_vars.insert(var.clone());
                        }
                    }
                }
            }
        }

        for (i, pat) in match_clause.patterns.iter().enumerate() {
            match pat {
                Pattern::Node(node) => {
                    // If this node variable is already bound by a previous step (e.g., produced by Expand),
                    // translate inline properties into a Filter and continue without adding a standalone scan.
                    if let Some(var) = &node.variable {
                        if bound_vars.contains(var) {
                            if !node.properties.is_empty() {
                                // Build predicate: AND of var.prop == literal
                                let mut iter = node.properties.iter();
                                let (first_k, first_v) = iter.next().unwrap();
                                let mut predicate = Expr::BinaryOp(
                                    Box::new(Expr::Property(var.clone(), first_k.clone())),
                                    BinOp::Eq,
                                    Box::new(Expr::Literal(first_v.clone())),
                                );
                                for (k, v) in iter {
                                    predicate = Expr::BinaryOp(
                                        Box::new(predicate),
                                        BinOp::And,
                                        Box::new(Expr::BinaryOp(
                                            Box::new(Expr::Property(var.clone(), k.clone())),
                                            BinOp::Eq,
                                            Box::new(Expr::Literal(v.clone())),
                                        )),
                                    );
                                }
                                plan_opt = Some(PlanNode::Filter { input: Box::new(plan_opt.take().unwrap()), predicate });
                            }
                            continue;
                        }
                    }
                    // Skip standalone scan for any node variable that is produced as to_node elsewhere
                    if let Some(var) = &node.variable {
                        if to_node_vars.contains(var) {
                            continue;
                        }
                    }
                    // If previous pattern is an Edge that already binds this node variable as its to_node,
                    // skip adding an extra standalone scan to avoid CartesianProduct duplication.
                    if i > 0 {
                        if let Pattern::Edge(prev_edge) = &match_clause.patterns[i - 1] {
                            if let (Some(prev_to), Some(curr_var)) = (&prev_edge.to_node.variable, &node.variable) {
                                if prev_to == curr_var {
                                    // Properties/labels on this node could be translated into a filter later if needed.
                                    continue;
                                }
                            }
                        }
                    }
                    // If next pattern is an Edge and this node variable equals the edge's to_node,
                    // skip scanning it standalone; it will be produced by the Expand.
                    if i + 1 < match_clause.patterns.len() {
                        if let Pattern::Edge(next_edge) = &match_clause.patterns[i + 1] {
                            if let (Some(next_to), Some(curr_var)) = (&next_edge.to_node.variable, &node.variable) {
                                if next_to == curr_var {
                                    continue;
                                }
                            }
                            // If plan already exists (we have a left side), and this node variable equals the edge's from_node,
                            // avoid creating a standalone scan that would form a Cartesian product. The from_var will already be bound.
                            if plan_opt.is_some() {
                                if let (Some(next_from), Some(curr_var)) = (&next_edge.from_node.variable, &node.variable) {
                                    if next_from == curr_var {
                                        continue;
                                    }
                                }
                            }
                        }
                    }
                    let var = node.variable.clone()
                        .ok_or_else(|| EngineError::InvalidArgument("node must have variable".into()))?;
                    // Base scan by label or full scan
                    let mut node_plan = if let Some(label) = node.labels.first() {
                        PlanNode::LabelScan { variable: var.clone(), label: label.clone() }
                    } else {
                        PlanNode::FullScan { variable: var.clone() }
                    };
                    // If there are inline properties on the node pattern, add a Filter
                    if !node.properties.is_empty() {
                        // Build predicate: AND of var.prop == literal
                        let mut iter = node.properties.iter();
                        let (first_k, first_v) = iter.next().unwrap();
                        let mut predicate = Expr::BinaryOp(
                            Box::new(Expr::Property(var.clone(), first_k.clone())),
                            BinOp::Eq,
                            Box::new(Expr::Literal(first_v.clone())),
                        );
                        for (k, v) in iter {
                            predicate = Expr::BinaryOp(
                                Box::new(predicate),
                                BinOp::And,
                                Box::new(Expr::BinaryOp(
                                    Box::new(Expr::Property(var.clone(), k.clone())),
                                    BinOp::Eq,
                                    Box::new(Expr::Literal(v.clone())),
                                )),
                            );
                        }
                        node_plan = PlanNode::Filter { input: Box::new(node_plan), predicate };
                    }
                    if plan_opt.is_none() {
                        plan_opt = Some(node_plan);
                    } else {
                        // Multiple standalone nodes: use Cartesian Product
                        plan_opt = Some(PlanNode::CartesianProduct {
                            left: Box::new(plan_opt.take().unwrap()),
                            right: Box::new(node_plan),
                        });
                    }
                    // Mark var as bound
                    bound_vars.insert(var);
                }
                Pattern::Edge(edge) => {
                    // Determine input plan: if none yet, scan from_node; otherwise reuse current plan
                    // Derive from_var/to_var from adjacent Node patterns if not present in EdgePattern
                    let from_var = match edge.from_node.variable.clone() {
                        Some(v) => v,
                        None => {
                            if i > 0 {
                                if let Pattern::Node(prev_node) = &match_clause.patterns[i - 1] {
                                    prev_node.variable.clone().ok_or_else(|| EngineError::InvalidArgument("from node must have variable".into()))?
                                } else {
                                    return Err(EngineError::InvalidArgument("from node must have variable".into()));
                                }
                            } else {
                                return Err(EngineError::InvalidArgument("from node must have variable".into()));
                            }
                        }
                    };
                    let to_var = match edge.to_node.variable.clone() {
                        Some(v) => v,
                        None => {
                            if i + 1 < match_clause.patterns.len() {
                                if let Pattern::Node(next_node) = &match_clause.patterns[i + 1] {
                                    next_node.variable.clone().ok_or_else(|| EngineError::InvalidArgument("to node must have variable".into()))?
                                } else {
                                    // No explicit variable and next pattern is not a Node: synthesize an anonymous to_var
                                    format!("__anon_to_{}", i)
                                }
                            } else {
                                // Last element in chain without following Node: synthesize an anonymous to_var
                                format!("__anon_to_{}", i)
                            }
                        }
                    };

                    let mut input_plan = if let Some(current) = plan_opt.take() {
                        current
                    } else {
                        // Start with scan of from_node
                        if let Some(label) = edge.from_node.labels.first() {
                            PlanNode::LabelScan { variable: from_var.clone(), label: label.clone() }
                        } else {
                            PlanNode::FullScan { variable: from_var.clone() }
                        }
                    };
                    // If the edge's from_node defines inline properties (e.g., (a:Label {k:v})),
                    // apply them as a Filter on the input plan to constrain the starting node.
                    if !edge.from_node.properties.is_empty() {
                        let mut iter = edge.from_node.properties.iter();
                        if let Some((first_k, first_v)) = iter.next() {
                            let mut pred = Expr::BinaryOp(
                                Box::new(Expr::Property(from_var.clone(), first_k.clone())),
                                BinOp::Eq,
                                Box::new(Expr::Literal(first_v.clone())),
                            );
                            for (k, v) in iter {
                                pred = Expr::BinaryOp(
                                    Box::new(pred),
                                    BinOp::And,
                                    Box::new(Expr::BinaryOp(
                                        Box::new(Expr::Property(from_var.clone(), k.clone())),
                                        BinOp::Eq,
                                        Box::new(Expr::Literal(v.clone())),
                                    )),
                                );
                            }
                            input_plan = PlanNode::Filter { input: Box::new(input_plan), predicate: pred };
                        }
                    }

                    // Add expand wrapping previous plan
                    let mut expand_plan = PlanNode::Expand {
                        input: Box::new(input_plan),
                        from_var: from_var.clone(),
                        edge_var: edge.variable.clone(),
                        to_var: to_var.clone(),
                        edge_type: edge.edge_type.clone(),
                        direction: edge.direction.clone(),
                        depth: edge.depth.clone(),
                    };
                    // If an adjacent Node pattern binds the same to_var and defines inline properties,
                    // translate those properties into a post-Expand Filter predicate.
                    // Also, combine any inline properties defined on from_node to guarantee start-node constraints.
                    let mut predicate_opt: Option<Expr> = None;
                    // Check previous Node
                    if i > 0 {
                        if let Pattern::Node(prev_node) = &match_clause.patterns[i - 1] {
                            if let Some(prev_var) = &prev_node.variable {
                                if prev_var == &to_var && !prev_node.properties.is_empty() {
                                    let mut iter = prev_node.properties.iter();
                                    if let Some((first_k, first_v)) = iter.next() {
                                        let mut pred = Expr::BinaryOp(
                                            Box::new(Expr::Property(to_var.clone(), first_k.clone())),
                                            BinOp::Eq,
                                            Box::new(Expr::Literal(first_v.clone())),
                                        );
                                        for (k, v) in iter {
                                            pred = Expr::BinaryOp(
                                                Box::new(pred),
                                                BinOp::And,
                                                Box::new(Expr::BinaryOp(
                                                    Box::new(Expr::Property(to_var.clone(), k.clone())),
                                                    BinOp::Eq,
                                                    Box::new(Expr::Literal(v.clone())),
                                                )),
                                            );
                                        }
                                        predicate_opt = Some(pred);
                                    }
                                }
                            }
                        }
                    }
                    // Check next Node
                    if i + 1 < match_clause.patterns.len() {
                        if let Pattern::Node(next_node) = &match_clause.patterns[i + 1] {
                            if let Some(next_var) = &next_node.variable {
                                if next_var == &to_var && !next_node.properties.is_empty() {
                                    let mut iter = next_node.properties.iter();
                                    if let Some((first_k, first_v)) = iter.next() {
                                        let mut pred = Expr::BinaryOp(
                                            Box::new(Expr::Property(to_var.clone(), first_k.clone())),
                                            BinOp::Eq,
                                            Box::new(Expr::Literal(first_v.clone())),
                                        );
                                        for (k, v) in iter {
                                            pred = Expr::BinaryOp(
                                                Box::new(pred),
                                                BinOp::And,
                                                Box::new(Expr::BinaryOp(
                                                    Box::new(Expr::Property(to_var.clone(), k.clone())),
                                                    BinOp::Eq,
                                                    Box::new(Expr::Literal(v.clone())),
                                                )),
                                            );
                                        }
                                        // Combine with previous predicate if present
                                        predicate_opt = Some(match predicate_opt.take() {
                                            Some(prev) => Expr::BinaryOp(Box::new(prev), BinOp::And, Box::new(pred)),
                                            None => pred,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    // Include from_node inline properties as part of the predicate (enforced post-Expand as well)
                    if !edge.from_node.properties.is_empty() {
                        let mut iter = edge.from_node.properties.iter();
                        if let Some((first_k, first_v)) = iter.next() {
                            let mut from_pred = Expr::BinaryOp(
                                Box::new(Expr::Property(from_var.clone(), first_k.clone())),
                                BinOp::Eq,
                                Box::new(Expr::Literal(first_v.clone())),
                            );
                            for (k, v) in iter {
                                from_pred = Expr::BinaryOp(
                                    Box::new(from_pred),
                                    BinOp::And,
                                    Box::new(Expr::BinaryOp(
                                        Box::new(Expr::Property(from_var.clone(), k.clone())),
                                        BinOp::Eq,
                                        Box::new(Expr::Literal(v.clone())),
                                    )),
                                );
                            }
                            predicate_opt = Some(match predicate_opt.take() {
                                Some(prev) => Expr::BinaryOp(Box::new(prev), BinOp::And, Box::new(from_pred)),
                                None => from_pred,
                            });
                        }
                    }
                    if let Some(pred) = predicate_opt {
                        expand_plan = PlanNode::Filter { input: Box::new(expand_plan), predicate: pred };
                    }
                    // Enforce endpoints differ for variable-length paths with min depth >= 1
                    if let Some(d) = &edge.depth {
                        if d.min >= 1 {
                            let neq = Expr::BinaryOp(
                                Box::new(Expr::FunctionCall("ID".to_string(), vec![Expr::Ident(from_var.clone())])),
                                BinOp::Ne,
                                Box::new(Expr::FunctionCall("ID".to_string(), vec![Expr::Ident(to_var.clone())])),
                            );
                            expand_plan = PlanNode::Filter { input: Box::new(expand_plan), predicate: neq };
                        }
                    }
                    // Mark to_var as bound (produced by Expand)
                    bound_vars.insert(to_var.clone());
                    plan_opt = Some(expand_plan);
                }
            }
        }

        // As a safety net, enforce all inline node properties as a global Filter
        // This covers cases where standalone node scans were skipped due to planning rules.
        if let Some(mut plan) = plan_opt {
            let mut global_pred_opt: Option<Expr> = None;
            for pat in &match_clause.patterns {
                if let Pattern::Node(node) = pat {
                    if let Some(var) = &node.variable {
                        if !node.properties.is_empty() {
                            let mut iter = node.properties.iter();
                            if let Some((first_k, first_v)) = iter.next() {
                                let mut pred = Expr::BinaryOp(
                                    Box::new(Expr::Property(var.clone(), first_k.clone())),
                                    BinOp::Eq,
                                    Box::new(Expr::Literal(first_v.clone())),
                                );
                                for (k, v) in iter {
                                    pred = Expr::BinaryOp(
                                        Box::new(pred),
                                        BinOp::And,
                                        Box::new(Expr::BinaryOp(
                                            Box::new(Expr::Property(var.clone(), k.clone())),
                                            BinOp::Eq,
                                            Box::new(Expr::Literal(v.clone())),
                                        )),
                                    );
                                }
                                global_pred_opt = Some(match global_pred_opt.take() {
                                    Some(prev) => Expr::BinaryOp(Box::new(prev), BinOp::And, Box::new(pred)),
                                    None => pred,
                                });
                            }
                        }
                    }
                }
            }
            if let Some(global_pred) = global_pred_opt {
                plan = PlanNode::Filter { input: Box::new(plan), predicate: global_pred };
            }
            Ok(plan)
        } else {
            Err(EngineError::InvalidArgument("invalid MATCH plan".into()))
        }
    }
    
    fn plan_create(create_clause: &CreateClause) -> Result<PlanNode, EngineError> {
        if create_clause.patterns.is_empty() {
            return Err(EngineError::InvalidArgument("empty CREATE clause".into()));
        }
        
        Ok(PlanNode::Create {
            patterns: create_clause.patterns.clone(),
        })
    }
    
    fn has_aggregate(expr: &Expr) -> bool {
        match expr {
            Expr::Aggregate(_, _) => true,
            Expr::BinaryOp(l, _, r) => Self::has_aggregate(l) || Self::has_aggregate(r),
            Expr::UnaryOp(_, e) => Self::has_aggregate(e),
            _ => false,
        }
    }
}
