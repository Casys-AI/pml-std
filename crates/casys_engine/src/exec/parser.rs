//! Parser ISO GQL MVP (MATCH/WHERE/RETURN/LIMIT)

use super::ast::*;
use super::ast::AggFunc;
use crate::types::EngineError;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
enum Token {
    // Keywords
    Match,
    Create,       // CREATE (for data modification)
    Set,          // SET (for updates)
    Delete,       // DELETE (for deletions)
    Where,
    With,         // WITH (for pipeline transformations)
    As,           // AS (for aliases)
    Return,
    Order,
    By,
    Asc,
    Desc,
    Limit,
    And,
    Or,
    Not,
    Null,
    True,
    False,
    Is,           // IS (for IS NULL)
    Exists,       // EXISTS (for subqueries)

    // Symbols
    LeftParen,
    RightParen,
    LeftBrace,
    RightBrace,
    LeftBracket,  // [
    RightBracket, // ]
    Colon,
    Comma,
    Dot,
    Dollar,       // $ (for parameters)
    Arrow,        // ->
    LeftArrow,    // <-
    Star,         // *
    DotDot,       // ..
    Pipe,         // |

    // Operators
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Plus,         // +
    Minus,        // -
    // Star already exists for *
    Slash,        // /

    // Literals
    Ident(String),
    String(String),
    Int(i64),
    Float(f64),

    Eof,
}

struct Lexer {
    input: Vec<char>,
    pos: usize,
}

impl Lexer {
    fn new(input: &str) -> Self {
        Self {
            input: input.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.input.get(self.pos).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.pos += 1;
        Some(ch)
    }

    fn skip_whitespace(&mut self) {
        while let Some(ch) = self.peek() {
            if ch.is_whitespace() {
                self.advance();
            } else {
                break;
            }
        }
    }

    fn read_ident(&mut self) -> String {
        let mut s = String::new();
        while let Some(ch) = self.peek() {
            if ch.is_alphanumeric() || ch == '_' {
                s.push(ch);
                self.advance();
            } else {
                break;
            }
        }
        s
    }

    fn read_string(&mut self) -> Result<String, EngineError> {
        self.advance(); // consume opening quote
        let mut s = String::new();
        while let Some(ch) = self.advance() {
            if ch == '\'' {
                return Ok(s);
            }
            s.push(ch);
        }
        Err(EngineError::InvalidArgument("unterminated string".into()))
    }

    fn read_number(&mut self) -> Result<Token, EngineError> {
        let mut num = String::new();
        let mut is_float = false;
        while let Some(ch) = self.peek() {
            if ch.is_ascii_digit() {
                num.push(ch);
                self.advance();
            } else if ch == '.' {
                // Lookahead: if next char is a digit, it's a float decimal; if next is '.', it's a range '..'
                let next = self.input.get(self.pos + 1).copied();
                if let Some(nc) = next {
                    if nc.is_ascii_digit() {
                        is_float = true;
                        num.push('.');
                        self.advance(); // consume '.'
                    } else if nc == '.' {
                        break; // leave '..' to next_token
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        if is_float {
            num.parse::<f64>()
                .map(Token::Float)
                .map_err(|_| EngineError::InvalidArgument("invalid float".into()))
        } else {
            num.parse::<i64>()
                .map(Token::Int)
                .map_err(|_| EngineError::InvalidArgument("invalid int".into()))
        }
    }

    fn next_token(&mut self) -> Result<Token, EngineError> {
        self.skip_whitespace();
        match self.peek() {
            None => Ok(Token::Eof),
            Some('(') => { self.advance(); Ok(Token::LeftParen) }
            Some(')') => { self.advance(); Ok(Token::RightParen) }
            Some('{') => { self.advance(); Ok(Token::LeftBrace) }
            Some('}') => { self.advance(); Ok(Token::RightBrace) }
            Some('[') => { self.advance(); Ok(Token::LeftBracket) }
            Some(']') => { self.advance(); Ok(Token::RightBracket) }
            Some(':') => { self.advance(); Ok(Token::Colon) }
            Some(',') => { self.advance(); Ok(Token::Comma) }
            Some('.') => {
                self.advance();
                if self.peek() == Some('.') {
                    self.advance();
                    Ok(Token::DotDot)
                } else {
                    Ok(Token::Dot)
                }
            }
            Some('*') => { self.advance(); Ok(Token::Star) }
            Some('$') => { self.advance(); Ok(Token::Dollar) }
            Some('+') => { self.advance(); Ok(Token::Plus) }
            Some('/') => { self.advance(); Ok(Token::Slash) }
            Some('|') => { self.advance(); Ok(Token::Pipe) }
            Some('\'') => self.read_string().map(Token::String),
            Some('<') => {
                self.advance();
                if self.peek() == Some('-') {
                    self.advance();
                    Ok(Token::LeftArrow)
                } else if self.peek() == Some('=') {
                    self.advance();
                    Ok(Token::Le)
                } else {
                    Ok(Token::Lt)
                }
            }
            Some('-') => {
                self.advance();
                if self.peek() == Some('>') {
                    self.advance();
                    Ok(Token::Arrow)
                } else {
                    // Could be Minus (arithmetic) or Dash (pattern)
                    // We'll use Minus and handle patterns contextually
                    Ok(Token::Minus)
                }
            }
            Some('>') => {
                self.advance();
                if self.peek() == Some('=') {
                    self.advance();
                    Ok(Token::Ge)
                } else {
                    Ok(Token::Gt)
                }
            }
            Some('=') => { self.advance(); Ok(Token::Eq) }
            Some('!') => {
                self.advance();
                if self.peek() == Some('=') {
                    self.advance();
                    Ok(Token::Ne)
                } else {
                    Err(EngineError::InvalidArgument("unexpected !".into()))
                }
            }
            Some(ch) if ch.is_ascii_digit() => self.read_number(),
            Some(ch) if ch.is_alphabetic() || ch == '_' => {
                let ident = self.read_ident();
                let upper = ident.to_uppercase();
                Ok(match upper.as_str() {
                    "MATCH" => Token::Match,
                    "CREATE" => Token::Create,
                    "SET" => Token::Set,
                    "DELETE" => Token::Delete,
                    "WHERE" => Token::Where,
                    "WITH" => Token::With,
                    "AS" => Token::As,
                    "RETURN" => Token::Return,
                    "ORDER" => Token::Order,
                    "BY" => Token::By,
                    "ASC" => Token::Asc,
                    "DESC" => Token::Desc,
                    "LIMIT" => Token::Limit,
                    "AND" => Token::And,
                    "OR" => Token::Or,
                    "NOT" => Token::Not,
                    "NULL" => Token::Null,
                    "TRUE" => Token::True,
                    "FALSE" => Token::False,
                    "IS" => Token::Is,
                    "EXISTS" => Token::Exists,
                    "COUNT" | "SUM" | "AVG" | "MIN" | "MAX" => Token::Ident(ident), // Aggregate functions
                    _ => Token::Ident(ident),
                })
            }
            Some(ch) => Err(EngineError::InvalidArgument(format!("unexpected char: {ch}"))),
        }
    }
}

pub struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    pub fn new(input: &str) -> Result<Self, EngineError> {
        let mut lexer = Lexer::new(input);
        let mut tokens = Vec::new();
        loop {
            let tok = lexer.next_token()?;
            if tok == Token::Eof {
                tokens.push(tok);
                break;
            }
            tokens.push(tok);
        }
        Ok(Self { tokens, pos: 0 })
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token::Eof)
    }

    fn advance(&mut self) -> Token {
        let tok = self.peek().clone();
        if tok != Token::Eof {
            self.pos += 1;
        }
        tok
    }

    fn expect(&mut self, expected: Token) -> Result<(), EngineError> {
        let tok = self.advance();
        if tok == expected {
            Ok(())
        } else {
            Err(EngineError::InvalidArgument(format!("expected {:?}, got {:?}", expected, tok)))
        }
    }

    pub fn parse_query(&mut self) -> Result<Query, EngineError> {
        // Parse optional MATCH clause
        let match_clause = if *self.peek() == Token::Match {
            Some(self.parse_match()?)
        } else {
            None
        };
        
        // Parse optional CREATE clause (can follow MATCH)
        let create_clause = if *self.peek() == Token::Create {
            Some(self.parse_create()?)
        } else {
            None
        };
        
        // At least one of MATCH or CREATE must be present
        if match_clause.is_none() && create_clause.is_none() {
            return Err(EngineError::InvalidArgument(format!("expected MATCH or CREATE, got {:?}", self.peek())));
        }
        
        // WITH clause (optional pipeline transformation)
        let with_clause = if *self.peek() == Token::With {
            Some(self.parse_with()?)
        } else {
            None
        };
        
        // WHERE clause (optional)
        let where_clause = if *self.peek() == Token::Where {
            Some(self.parse_where()?)
        } else {
            None
        };
        
        // RETURN clause (optional for CREATE)
        let return_clause = if *self.peek() == Token::Return {
            Some(self.parse_return()?)
        } else {
            None
        };
        
        let order_by = if *self.peek() == Token::Order {
            Some(self.parse_order_by()?)
        } else {
            None
        };
        let limit = if *self.peek() == Token::Limit {
            self.advance();
            if let Token::Int(n) = self.advance() {
                Some(n as u64)
            } else {
                return Err(EngineError::InvalidArgument("expected int after LIMIT".into()));
            }
        } else {
            None
        };
        Ok(Query { match_clause, create_clause, with_clause, where_clause, return_clause, order_by, limit })
    }

    fn parse_match(&mut self) -> Result<MatchClause, EngineError> {
        self.expect(Token::Match)?;
        let patterns = self.parse_patterns_match()?;
        Ok(MatchClause { patterns })
    }
    
    fn parse_create(&mut self) -> Result<CreateClause, EngineError> {
        self.expect(Token::Create)?;
        let patterns = self.parse_patterns_create()?;
        Ok(CreateClause { patterns })
    }
    
    // MATCH: emit starting node, then edges (no trailing node push)
    fn parse_patterns_match(&mut self) -> Result<Vec<Pattern>, EngineError> {
        let mut all_patterns = Vec::new();
        loop {
            let mut from_node = self.parse_node_pattern()?;
            all_patterns.push(Pattern::Node(from_node.clone()));
            while matches!(self.peek(), Token::Minus | Token::LeftArrow) {
                let edge_pattern = self.parse_edge_pattern(from_node)?;
                from_node = (*edge_pattern.to_node).clone();
                all_patterns.push(Pattern::Edge(edge_pattern));
            }
            if *self.peek() == Token::Comma { self.advance(); continue; } else { break; }
        }
        Ok(all_patterns)
    }

    // CREATE: original behavior - do not emit starting node preemptively, but add trailing node if no edge parsed
    fn parse_patterns_create(&mut self) -> Result<Vec<Pattern>, EngineError> {
        let mut all_patterns = Vec::new();
        loop {
            let mut from_node = self.parse_node_pattern()?;
            while matches!(self.peek(), Token::Minus | Token::LeftArrow) {
                let edge_pattern = self.parse_edge_pattern(from_node)?;
                from_node = (*edge_pattern.to_node).clone();
                all_patterns.push(Pattern::Edge(edge_pattern));
            }
            if all_patterns.is_empty() || !matches!(all_patterns.last(), Some(Pattern::Edge(_))) {
                all_patterns.push(Pattern::Node(from_node));
            }
            if *self.peek() == Token::Comma { self.advance(); continue; } else { break; }
        }
        Ok(all_patterns)
    }
    
    fn parse_edge_pattern(&mut self, from_node: NodePattern) -> Result<EdgePattern, EngineError> {
        // Determine direction and consume symbols
        let direction = if *self.peek() == Token::LeftArrow {
            self.advance(); // consume <-
            Direction::Left
        } else {
            self.expect(Token::Minus)?; // consume -
            Direction::Both // will be updated if we find ->
        };
        
        // Parse edge: [r:TYPE*min..max {props}] or [r] or [] (optional)
        let (edge_var, edge_type, edge_props, depth) = if *self.peek() == Token::LeftBracket {
            self.advance(); // consume [
            // optional variable
            let var = if let Token::Ident(name) = self.peek() {
                let v = Some(name.clone());
                self.advance();
                v
            } else {
                None
            };

            // optional :TYPE or :TYPE1|TYPE2|...
            let typ = if *self.peek() == Token::Colon {
                self.advance(); // consume :
                let mut types = Vec::new();
                if let Token::Ident(t) = self.peek() {
                    types.push(t.clone());
                    self.advance(); // consume type ident
                    
                    // Check for union types (|)
                    while *self.peek() == Token::Pipe {
                        self.advance(); // consume |
                        if let Token::Ident(t) = self.peek() {
                            types.push(t.clone());
                            self.advance(); // consume type ident
                        } else {
                            return Err(EngineError::InvalidArgument("expected type after |".into()));
                        }
                    }
                    
                    Some(types.join("|"))
                } else {
                    return Err(EngineError::InvalidArgument("expected type after :".into()));
                }
            } else {
                None
            };

            // optional *min[..max]
            let depth = self.parse_depth_range()?;

            // optional {props}
            let props = if *self.peek() == Token::LeftBrace {
                self.advance();
                let p = self.parse_properties()?;
                self.expect(Token::RightBrace)?;
                p
            } else {
                HashMap::new()
            };

            self.expect(Token::RightBracket)?; // consume ]
            // Support quantifier outside bracket: -[:TYPE|TYPE2]*min..max-
            let depth_outside = self.parse_depth_range()?;
            let final_depth = match (depth, depth_outside) {
                (Some(_), Some(_)) => {
                    return Err(EngineError::InvalidArgument(
                        "depth specified twice (inside and outside bracket)".into(),
                    ));
                }
                (Some(d), None) => Some(d),
                (None, Some(d)) => Some(d),
                (None, None) => None,
            };
            (var, typ, props, final_depth)
        } else {
            (None, None, HashMap::new(), None)
        };
        
        // Now check for arrow after edge (for ->)
        let final_direction = if direction == Direction::Both && *self.peek() == Token::Arrow {
            self.advance(); // consume ->
            Direction::Right
        } else if direction == Direction::Both && *self.peek() == Token::Minus {
            // Pattern non-orienté: -[r]- consume le - final
            self.advance(); // consume -
            Direction::Both
        } else {
            direction
        };
        
        // Parse destination node
        let to_node = self.parse_node_pattern()?;
        
        Ok(EdgePattern {
            variable: edge_var,
            edge_type,
            direction: final_direction,
            properties: edge_props,
            from_node: Box::new(from_node),
            to_node: Box::new(to_node),
            depth,
        })
    }

    /// Parse optional depth range inside edge bracket: *N, *N..M, *..M, *
    fn parse_depth_range(&mut self) -> Result<Option<DepthRange>, EngineError> {
        // If no '*', no depth specified
        if *self.peek() != Token::Star {
            return Ok(None);
        }
        self.advance(); // consume '*'

        // Handle forms: * (min=1, max=UINT_MAX), *N, *N..M, *..M, *N..
        // Default if just '*' → 1..u32::MAX
        match self.peek() {
            Token::Int(n) => {
                let min_val = *n as u32;
                self.advance(); // consume number
                // Check for '..'
                if *self.peek() == Token::DotDot {
                    self.advance(); // consume '..'
                    match self.peek() {
                        Token::Int(m) => {
                            let max_val = *m as u32;
                            self.advance();
                            Ok(Some(DepthRange { min: min_val, max: max_val }))
                        }
                        _ => {
                            // *N..  (open upper bound)
                            Ok(Some(DepthRange { min: min_val, max: u32::MAX }))
                        }
                    }
                } else {
                    // *N shorthand => exact depth
                    Ok(Some(DepthRange { min: min_val, max: min_val }))
                }
            }
            Token::DotDot => {
                // *..M  (0..M)
                self.advance(); // consume '..'
                if let Token::Int(m) = self.peek() {
                    let max_val = *m as u32;
                    self.advance();
                    Ok(Some(DepthRange { min: 0, max: max_val }))
                } else {
                    return Err(EngineError::InvalidArgument("expected number after ..".into()));
                }
            }
            _ => {
                // bare '*' → 1..∞
                Ok(Some(DepthRange { min: 1, max: u32::MAX }))
            }
        }
    }

    fn parse_node_pattern(&mut self) -> Result<NodePattern, EngineError> {
        self.expect(Token::LeftParen)?;
        let variable = if let Token::Ident(name) = self.peek() {
            let v = Some(name.clone());
            self.advance();
            v
        } else {
            None
        };
        let mut labels = Vec::new();
        if *self.peek() == Token::Colon {
            self.advance();
            if let Token::Ident(label) = self.advance() {
                labels.push(label);
            }
        }
        let mut properties = HashMap::new();
        if *self.peek() == Token::LeftBrace {
            self.advance();
            properties = self.parse_properties()?;
            self.expect(Token::RightBrace)?;
        }
        self.expect(Token::RightParen)?;
        Ok(NodePattern { variable, labels, properties })
    }

    fn parse_properties(&mut self) -> Result<HashMap<String, Literal>, EngineError> {
        let mut props = HashMap::new();
        loop {
            if *self.peek() == Token::RightBrace {
                break;
            }
            let key = if let Token::Ident(k) = self.advance() {
                k
            } else {
                return Err(EngineError::InvalidArgument("expected property key".into()));
            };
            self.expect(Token::Colon)?;
            let val = self.parse_literal()?;
            props.insert(key, val);
            if *self.peek() == Token::Comma {
                self.advance();
            } else {
                break;
            }
        }
        Ok(props)
    }

    fn parse_literal(&mut self) -> Result<Literal, EngineError> {
        match self.advance() {
            Token::String(s) => Ok(Literal::String(s)),
            Token::Int(i) => Ok(Literal::Int(i)),
            Token::Float(f) => Ok(Literal::Float(f)),
            Token::True => Ok(Literal::Bool(true)),
            Token::False => Ok(Literal::Bool(false)),
            Token::Null => Ok(Literal::Null),
            tok => Err(EngineError::InvalidArgument(format!("expected literal, got {:?}", tok))),
        }
    }

    fn parse_where(&mut self) -> Result<WhereClause, EngineError> {
        self.expect(Token::Where)?;
        let expr = self.parse_expr()?;
        Ok(WhereClause { expr })
    }

    fn parse_with(&mut self) -> Result<WithClause, EngineError> {
        self.expect(Token::With)?;
        let mut items = Vec::new();
        
        loop {
            let expr = self.parse_expr()?;
            
            // Alias is required in WITH (AS is mandatory in ISO GQL WITH)
            self.expect(Token::As)?;
            let alias = if let Token::Ident(name) = self.advance() {
                name
            } else {
                return Err(EngineError::InvalidArgument("expected alias after AS".into()));
            };
            
            items.push(WithItem { expr, alias });
            
            if *self.peek() == Token::Comma {
                self.advance();
            } else {
                break;
            }
        }
        
        Ok(WithClause { items })
    }

    fn parse_expr(&mut self) -> Result<Expr, EngineError> {
        self.parse_or_expr()
    }

    fn parse_or_expr(&mut self) -> Result<Expr, EngineError> {
        let mut left = self.parse_and_expr()?;
        while *self.peek() == Token::Or {
            self.advance();
            let right = self.parse_and_expr()?;
            left = Expr::BinaryOp(Box::new(left), BinOp::Or, Box::new(right));
        }
        Ok(left)
    }

    fn parse_and_expr(&mut self) -> Result<Expr, EngineError> {
        let mut left = self.parse_comparison()?;
        while *self.peek() == Token::And {
            self.advance();
            let right = self.parse_comparison()?;
            left = Expr::BinaryOp(Box::new(left), BinOp::And, Box::new(right));
        }
        Ok(left)
    }

    fn parse_comparison(&mut self) -> Result<Expr, EngineError> {
        let left = self.parse_additive()?;
        
        // Check for IS NULL / IS NOT NULL
        if *self.peek() == Token::Is {
            self.advance(); // consume IS
            
            // Check for NOT
            let is_not = if *self.peek() == Token::Not {
                self.advance(); // consume NOT
                true
            } else {
                false
            };
            
            // Expect NULL
            self.expect(Token::Null)?;
            
            return Ok(if is_not {
                Expr::IsNotNull(Box::new(left))
            } else {
                Expr::IsNull(Box::new(left))
            });
        }
        
        // Regular comparison operators
        let op = match self.peek() {
            Token::Eq => { self.advance(); BinOp::Eq }
            Token::Ne => { self.advance(); BinOp::Ne }
            Token::Lt => { self.advance(); BinOp::Lt }
            Token::Le => { self.advance(); BinOp::Le }
            Token::Gt => { self.advance(); BinOp::Gt }
            Token::Ge => { self.advance(); BinOp::Ge }
            _ => return Ok(left),
        };
        let right = self.parse_additive()?;
        Ok(Expr::BinaryOp(Box::new(left), op, Box::new(right)))
    }

    fn parse_additive(&mut self) -> Result<Expr, EngineError> {
        let mut left = self.parse_multiplicative()?;
        loop {
            let op = match self.peek() {
                Token::Plus => { self.advance(); BinOp::Add }
                Token::Minus => { self.advance(); BinOp::Sub }
                _ => break,
            };
            let right = self.parse_multiplicative()?;
            left = Expr::BinaryOp(Box::new(left), op, Box::new(right));
        }
        Ok(left)
    }

    fn parse_multiplicative(&mut self) -> Result<Expr, EngineError> {
        let mut left = self.parse_primary()?;
        loop {
            let op = match self.peek() {
                Token::Star => { self.advance(); BinOp::Mul }
                Token::Slash => { self.advance(); BinOp::Div }
                _ => break,
            };
            let right = self.parse_primary()?;
            left = Expr::BinaryOp(Box::new(left), op, Box::new(right));
        }
        Ok(left)
    }

    fn parse_primary(&mut self) -> Result<Expr, EngineError> {
        match self.peek().clone() {
            Token::Dollar => {
                self.advance(); // consume $
                if let Token::Ident(param_name) = self.advance() {
                    Ok(Expr::Parameter(param_name))
                } else {
                    Err(EngineError::InvalidArgument("expected parameter name after $".into()))
                }
            }
            Token::Ident(name) => {
                self.advance();
                
                // Check for function call
                if *self.peek() == Token::LeftParen {
                    let upper = name.to_uppercase();
                    
                    // Try aggregate functions first
                    let agg_func = match upper.as_str() {
                        "COUNT" => Some(AggFunc::Count),
                        "SUM" => Some(AggFunc::Sum),
                        "AVG" => Some(AggFunc::Avg),
                        "MIN" => Some(AggFunc::Min),
                        "MAX" => Some(AggFunc::Max),
                        _ => None,
                    };
                    
                    if let Some(func) = agg_func {
                        // Aggregate function
                        self.advance(); // consume (
                        let arg = self.parse_expr()?;
                        self.expect(Token::RightParen)?;
                        return Ok(Expr::Aggregate(func, Box::new(arg)));
                    } else {
                        // Generic function call (ID, etc.)
                        self.advance(); // consume (
                        let mut args = Vec::new();
                        
                        // Parse arguments (comma-separated)
                        if *self.peek() != Token::RightParen {
                            loop {
                                args.push(self.parse_expr()?);
                                if *self.peek() == Token::Comma {
                                    self.advance();
                                } else {
                                    break;
                                }
                            }
                        }
                        
                        self.expect(Token::RightParen)?;
                        return Ok(Expr::FunctionCall(name, args));
                    }
                }
                
                if *self.peek() == Token::Dot {
                    self.advance();
                    if let Token::Ident(prop) = self.advance() {
                        Ok(Expr::Property(name, prop))
                    } else {
                        Err(EngineError::InvalidArgument("expected property name".into()))
                    }
                } else {
                    Ok(Expr::Ident(name))
                }
            }
            Token::String(_) | Token::Int(_) | Token::Float(_) | Token::True | Token::False | Token::Null => {
                Ok(Expr::Literal(self.parse_literal()?))
            }
            Token::Not => {
                self.advance();
                Ok(Expr::UnaryOp(UnOp::Not, Box::new(self.parse_primary()?)))
            }
            Token::Exists => {
                self.advance(); // consume EXISTS
                self.expect(Token::LeftBrace)?; // expect {
                
                // Parse the subquery
                let subquery = self.parse_query()?;
                
                self.expect(Token::RightBrace)?; // expect }
                Ok(Expr::Exists(Box::new(subquery)))
            }
            Token::LeftParen => {
                self.advance();
                let expr = self.parse_expr()?;
                self.expect(Token::RightParen)?;
                Ok(expr)
            }
            tok => Err(EngineError::InvalidArgument(format!("unexpected token in expr: {:?}", tok))),
        }
    }

    fn parse_order_by(&mut self) -> Result<OrderByClause, EngineError> {
        self.expect(Token::Order)?;
        self.expect(Token::By)?;
        let mut items = Vec::new();
        loop {
            let expr = self.parse_expr()?;
            let descending = match self.peek() {
                Token::Desc => { self.advance(); true }
                Token::Asc => { self.advance(); false }
                _ => false, // Default to ASC
            };
            items.push(OrderByItem { expr, descending });
            if *self.peek() == Token::Comma {
                self.advance();
            } else {
                break;
            }
        }
        Ok(OrderByClause { items })
    }

    fn parse_return(&mut self) -> Result<ReturnClause, EngineError> {
        self.expect(Token::Return)?;
        let mut items = Vec::new();
        loop {
            let expr = self.parse_expr()?;
            let alias = None; // Simplified: no AS alias support yet
            items.push(ReturnItem { expr, alias });
            if *self.peek() == Token::Comma {
                self.advance();
            } else {
                break;
            }
        }
        Ok(ReturnClause { items })
    }
}

pub fn parse(input: &str) -> Result<Query, EngineError> {
    let mut parser = Parser::new(input)?;
    parser.parse_query()
}
