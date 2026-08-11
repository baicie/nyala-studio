//! Conservative SQL analysis for local Agent safety decisions.

use serde::Serialize;

use super::sql_lexer::{
    first_sql_keyword_for_dialect, split_sql_statements, sql_tokens,
    statement_keyword_after_with_for_dialect, SqlToken,
};
use super::SqlDialect;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlAnalysis {
    pub dialect: SqlDialect,
    pub statement_count: usize,
    pub statement_class: StatementClass,
    pub risk: StatementRisk,
    pub referenced_tables: Vec<SqlTableRef>,
    pub warnings: Vec<SqlAnalysisWarning>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementClass {
    Metadata,
    Query,
    Explain,
    Mutation,
    Definition,
    Maintenance,
    Unknown,
}

/// Static syntax risk only; database-enforced read-only mode is still required before execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementRisk {
    Metadata,
    ReadOnly,
    ExplainReadOnly,
    TransactionalWrite,
    Ddl,
    Destructive,
    Forbidden,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlTableRef {
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlAnalysisWarning {
    EmptySql,
    MultipleStatements,
    UnknownStatement,
    ReferencesIncomplete,
}

pub fn analyze_sql(sql: &str, dialect: SqlDialect) -> SqlAnalysis {
    let statements = split_sql_statements(sql, dialect);
    if statements.is_empty() {
        return unknown_analysis(dialect, 0, SqlAnalysisWarning::EmptySql);
    }

    if statements.len() > 1 {
        return unknown_analysis(
            dialect,
            statements.len(),
            SqlAnalysisWarning::MultipleStatements,
        );
    }

    let statement = statements[0];
    let tokens = sql_tokens(statement, dialect);
    let Some(first_keyword) = first_sql_keyword_for_dialect(statement, dialect) else {
        return unknown_analysis(dialect, 1, SqlAnalysisWarning::UnknownStatement);
    };
    let effective_keyword = if first_keyword == "with" {
        statement_keyword_after_with_for_dialect(statement, dialect)
    } else {
        Some(first_keyword.clone())
    };
    let Some(effective_keyword) = effective_keyword else {
        return unknown_analysis(dialect, 1, SqlAnalysisWarning::UnknownStatement);
    };

    let must_fail_closed = (dialect == SqlDialect::MySql
        && (sql.contains("/*!") || sql.contains("/*M!") || sql.contains("/*m!")))
        // Backslash quote behavior depends on connection/session modes that A0
        // does not receive, so treating either interpretation as safe would guess.
        || contains_ambiguous_backslash_quote(sql)
        || (first_keyword == "with" && cte_body_may_mutate(&tokens));
    let (statement_class, risk) = if must_fail_closed {
        (StatementClass::Unknown, StatementRisk::Unknown)
    } else {
        classify_statement(&effective_keyword, &tokens, dialect)
    };
    let mut warnings = Vec::new();
    if risk == StatementRisk::Unknown {
        warnings.push(SqlAnalysisWarning::UnknownStatement);
    }

    let (referenced_tables, references_incomplete) =
        extract_table_references(&tokens, first_keyword == "with");
    if references_incomplete {
        warnings.push(SqlAnalysisWarning::ReferencesIncomplete);
    }

    SqlAnalysis {
        dialect,
        statement_count: 1,
        statement_class,
        risk,
        referenced_tables,
        warnings,
    }
}

fn unknown_analysis(
    dialect: SqlDialect,
    statement_count: usize,
    warning: SqlAnalysisWarning,
) -> SqlAnalysis {
    SqlAnalysis {
        dialect,
        statement_count,
        statement_class: StatementClass::Unknown,
        risk: StatementRisk::Unknown,
        referenced_tables: Vec::new(),
        warnings: vec![warning],
    }
}

fn classify_statement(
    keyword: &str,
    tokens: &[SqlToken],
    dialect: SqlDialect,
) -> (StatementClass, StatementRisk) {
    if keyword == "select" {
        if dialect == SqlDialect::PostgreSql && contains_word(tokens, "into") {
            return (StatementClass::Definition, StatementRisk::Ddl);
        }
        if dialect == SqlDialect::MySql && contains_word(tokens, "into") {
            return (StatementClass::Query, StatementRisk::Forbidden);
        }
        if contains_word_sequence(tokens, &["for", "update"])
            || contains_word_sequence(tokens, &["for", "share"])
            || contains_word_sequence(tokens, &["for", "no", "key", "update"])
            || contains_word_sequence(tokens, &["for", "key", "share"])
            || contains_word_sequence(tokens, &["lock", "in", "share", "mode"])
        {
            return (StatementClass::Query, StatementRisk::TransactionalWrite);
        }
    }

    match keyword {
        "show" | "describe" | "desc" => (StatementClass::Metadata, StatementRisk::Metadata),
        "select" | "values" => (StatementClass::Query, StatementRisk::ReadOnly),
        "explain" if explain_is_read_only(tokens) => {
            (StatementClass::Explain, StatementRisk::ExplainReadOnly)
        }
        "insert" | "update" | "delete" | "replace" | "merge" => {
            (StatementClass::Mutation, StatementRisk::TransactionalWrite)
        }
        "create" | "alter" | "rename" => (StatementClass::Definition, StatementRisk::Ddl),
        "drop" | "truncate" => (StatementClass::Definition, StatementRisk::Destructive),
        "attach" | "detach" | "vacuum" => (StatementClass::Maintenance, StatementRisk::Forbidden),
        _ => (StatementClass::Unknown, StatementRisk::Unknown),
    }
}

fn cte_body_may_mutate(tokens: &[SqlToken]) -> bool {
    let mut depth = 0usize;
    let mut saw_body = false;

    for token in tokens {
        match token {
            SqlToken::Symbol(b'(') => {
                depth += 1;
                saw_body = true;
            }
            SqlToken::Symbol(b')') => depth = depth.saturating_sub(1),
            SqlToken::Word(word) if depth > 0 => {
                if [
                    "insert", "update", "delete", "replace", "merge", "create", "alter", "rename",
                    "drop", "truncate", "attach", "detach", "vacuum",
                ]
                .iter()
                .any(|keyword| word.eq_ignore_ascii_case(keyword))
                {
                    return true;
                }
            }
            SqlToken::Word(word)
                if saw_body
                    && depth == 0
                    && [
                        "select", "values", "show", "describe", "desc", "explain", "insert",
                        "update", "delete", "replace", "merge", "create", "alter", "rename",
                        "drop", "truncate", "attach", "detach", "vacuum",
                    ]
                    .iter()
                    .any(|keyword| word.eq_ignore_ascii_case(keyword)) =>
            {
                break;
            }
            _ => {}
        }
    }

    false
}

fn explain_is_read_only(tokens: &[SqlToken]) -> bool {
    let mut index = 1usize;
    if token_is_word(tokens.get(index), "query") && token_is_word(tokens.get(index + 1), "plan") {
        index += 2;
    }

    token_is_word(tokens.get(index), "select") || token_is_word(tokens.get(index), "values")
}

fn extract_table_references(
    tokens: &[SqlToken],
    starts_with_cte: bool,
) -> (Vec<SqlTableRef>, bool) {
    if starts_with_cte {
        return (Vec::new(), true);
    }

    let mut references = Vec::new();
    let mut incomplete = false;
    let mut index = 0usize;

    while index < tokens.len() {
        let is_direct_target = ["from", "join", "update", "into", "describe", "desc"]
            .iter()
            .any(|keyword| token_is_word(tokens.get(index), keyword));
        let is_ddl_target = token_is_word(tokens.get(index), "table")
            && index > 0
            && ["create", "alter", "drop", "truncate"]
                .iter()
                .any(|keyword| token_is_word(tokens.get(index - 1), keyword));

        if !is_direct_target && !is_ddl_target {
            index += 1;
            continue;
        }

        let mut target_index = index + 1;
        if is_ddl_target && token_is_word(tokens.get(target_index), "if") {
            target_index += 1;
            if token_is_word(tokens.get(target_index), "not") {
                target_index += 1;
            }
            if !token_is_word(tokens.get(target_index), "exists") {
                incomplete = true;
                index = target_index + 1;
                continue;
            }
            target_index += 1;
        }
        if token_is_word(tokens.get(target_index), "outfile")
            || token_is_word(tokens.get(target_index), "dumpfile")
        {
            index = target_index + 1;
            continue;
        }
        if matches!(tokens.get(target_index), Some(SqlToken::Symbol(b'('))) {
            incomplete = true;
            index = target_index + 1;
            continue;
        }

        let Some((table_ref, next_index)) = parse_table_reference(tokens, target_index) else {
            incomplete = true;
            index = target_index + 1;
            continue;
        };

        if matches!(tokens.get(next_index), Some(SqlToken::Symbol(b'('))) {
            incomplete = true;
        } else if !references.contains(&table_ref) {
            // Statement-sized vectors keep ordered dedup dependency-free; use an
            // ordered set only if profiling shows unusually large SQL inputs.
            references.push(table_ref);
        }
        index = next_index;
    }

    (references, incomplete)
}

fn parse_table_reference(tokens: &[SqlToken], start: usize) -> Option<(SqlTableRef, usize)> {
    let first = token_identifier(tokens.get(start))?;
    let dot_index = start + 1;
    if !matches!(tokens.get(dot_index), Some(SqlToken::Symbol(b'.'))) {
        return Some((
            SqlTableRef {
                schema: None,
                name: first.to_string(),
            },
            dot_index,
        ));
    }

    let name_index = dot_index + 1;
    let name = token_identifier(tokens.get(name_index))?;
    if matches!(tokens.get(name_index + 1), Some(SqlToken::Symbol(b'.'))) {
        return None;
    }

    Some((
        SqlTableRef {
            schema: Some(first.to_string()),
            name: name.to_string(),
        },
        name_index + 1,
    ))
}

fn token_is_word(token: Option<&SqlToken>, expected: &str) -> bool {
    matches!(token, Some(SqlToken::Word(value)) if value.eq_ignore_ascii_case(expected))
}

fn token_identifier(token: Option<&SqlToken>) -> Option<&str> {
    match token? {
        SqlToken::Word(value) | SqlToken::QuotedIdentifier(value) => Some(value),
        SqlToken::Symbol(_) => None,
    }
}

fn contains_word(tokens: &[SqlToken], expected: &str) -> bool {
    tokens
        .iter()
        .any(|token| token_is_word(Some(token), expected))
}

fn contains_word_sequence(tokens: &[SqlToken], expected: &[&str]) -> bool {
    tokens.windows(expected.len()).any(|window| {
        window
            .iter()
            .zip(expected)
            .all(|(token, expected)| token_is_word(Some(token), expected))
    })
}

fn contains_ambiguous_backslash_quote(sql: &str) -> bool {
    sql.as_bytes()
        .windows(2)
        .any(|pair| pair[0] == b'\\' && matches!(pair[1], b'\'' | b'"'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dialect_corpus_classifies_known_statement_risks() {
        let cases = [
            (
                SqlDialect::Sqlite,
                "SELECT * FROM users",
                StatementClass::Query,
                StatementRisk::ReadOnly,
            ),
            (
                SqlDialect::PostgreSql,
                "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent",
                StatementClass::Query,
                StatementRisk::ReadOnly,
            ),
            (
                SqlDialect::MySql,
                "SHOW TABLES",
                StatementClass::Metadata,
                StatementRisk::Metadata,
            ),
            (
                SqlDialect::MySql,
                "DESCRIBE users",
                StatementClass::Metadata,
                StatementRisk::Metadata,
            ),
            (
                SqlDialect::Sqlite,
                "EXPLAIN QUERY PLAN SELECT * FROM users",
                StatementClass::Explain,
                StatementRisk::ExplainReadOnly,
            ),
            (
                SqlDialect::PostgreSql,
                "INSERT INTO users(name) VALUES ('Nyala')",
                StatementClass::Mutation,
                StatementRisk::TransactionalWrite,
            ),
            (
                SqlDialect::MySql,
                "WITH stale AS (SELECT id FROM users) UPDATE users SET active = 0",
                StatementClass::Mutation,
                StatementRisk::TransactionalWrite,
            ),
            (
                SqlDialect::Sqlite,
                "CREATE TABLE users (id INTEGER)",
                StatementClass::Definition,
                StatementRisk::Ddl,
            ),
            (
                SqlDialect::PostgreSql,
                "DROP TABLE users",
                StatementClass::Definition,
                StatementRisk::Destructive,
            ),
            (
                SqlDialect::MySql,
                "TRUNCATE TABLE users",
                StatementClass::Definition,
                StatementRisk::Destructive,
            ),
            (
                SqlDialect::Sqlite,
                "ATTACH DATABASE 'other.db' AS other",
                StatementClass::Maintenance,
                StatementRisk::Forbidden,
            ),
            (
                SqlDialect::Sqlite,
                "DETACH DATABASE other",
                StatementClass::Maintenance,
                StatementRisk::Forbidden,
            ),
            (
                SqlDialect::Sqlite,
                "VACUUM",
                StatementClass::Maintenance,
                StatementRisk::Forbidden,
            ),
        ];

        for (dialect, sql, statement_class, risk) in cases {
            let analysis = analyze_sql(sql, dialect);
            assert_eq!(analysis.statement_count, 1, "{sql}");
            assert_eq!(analysis.statement_class, statement_class, "{sql}");
            assert_eq!(analysis.risk, risk, "{sql}");
        }
    }

    #[test]
    fn unsupported_or_unsafe_forms_fail_closed() {
        for sql in [
            "PRAGMA journal_mode = WAL",
            "EXPLAIN ANALYZE SELECT * FROM users",
            "WITH recent AS (SELECT * FROM orders",
            "WITH removed AS (DELETE FROM users RETURNING *) SELECT * FROM removed",
            "CALL refresh_cache()",
        ] {
            let analysis = analyze_sql(sql, SqlDialect::Sqlite);
            assert_eq!(analysis.statement_count, 1, "{sql}");
            assert_eq!(analysis.statement_class, StatementClass::Unknown, "{sql}");
            assert_eq!(analysis.risk, StatementRisk::Unknown, "{sql}");
            assert!(
                analysis
                    .warnings
                    .contains(&SqlAnalysisWarning::UnknownStatement),
                "{sql}"
            );
        }
    }

    #[test]
    fn dialect_specific_select_side_effects_are_not_read_only() {
        let postgres = analyze_sql(
            "SELECT * INTO archived_users FROM users",
            SqlDialect::PostgreSql,
        );
        assert_eq!(postgres.statement_class, StatementClass::Definition);
        assert_eq!(postgres.risk, StatementRisk::Ddl);

        for sql in [
            "SELECT * FROM users INTO OUTFILE '/tmp/users.csv'",
            "SELECT * FROM users FOR UPDATE",
            "SELECT * FROM users FOR SHARE",
            "SELECT * FROM users LOCK IN SHARE MODE",
            "/*!50000 SELECT * FROM users */ SELECT 1",
        ] {
            let mysql = analyze_sql(sql, SqlDialect::MySql);
            assert_ne!(mysql.risk, StatementRisk::ReadOnly, "{sql}");
            assert_ne!(mysql.risk, StatementRisk::ExplainReadOnly, "{sql}");
        }

        for sql in [
            "SELECT * FROM users FOR NO KEY UPDATE",
            "SELECT * FROM users FOR KEY SHARE",
        ] {
            let postgres = analyze_sql(sql, SqlDialect::PostgreSql);
            assert_eq!(postgres.risk, StatementRisk::TransactionalWrite, "{sql}");
        }
    }

    #[test]
    fn mysql_dash_comment_rules_cannot_hide_a_second_statement() {
        let analysis = analyze_sql(
            "SELECT 1--not-a-comment; DROP TABLE users",
            SqlDialect::MySql,
        );

        assert_eq!(analysis.statement_count, 2);
        assert_eq!(analysis.risk, StatementRisk::Unknown);
    }

    #[test]
    fn dialect_quote_and_comment_forms_cannot_hide_a_second_statement() {
        for dialect in [SqlDialect::Sqlite, SqlDialect::PostgreSql] {
            let analysis = analyze_sql(r"SELECT '\'; DROP TABLE users; -- '", dialect);
            assert_eq!(analysis.statement_count, 2, "{dialect:?}");
            assert_eq!(analysis.risk, StatementRisk::Unknown, "{dialect:?}");
        }

        let postgres = analyze_sql(
            "SELECT $x$ -- not a comment $x$; DROP TABLE users;",
            SqlDialect::PostgreSql,
        );
        assert_eq!(postgres.statement_count, 2);
        assert_eq!(postgres.risk, StatementRisk::Unknown);

        let unicode_tag = analyze_sql(
            "SELECT $é$ -- not a comment $é$; DROP TABLE users;",
            SqlDialect::PostgreSql,
        );
        assert_eq!(unicode_tag.statement_count, 2);
        assert_eq!(unicode_tag.risk, StatementRisk::Unknown);

        let nested_comment = analyze_sql(
            "SELECT 1 /* outer /* inner */ -- still outer */; DROP TABLE users;",
            SqlDialect::PostgreSql,
        );
        assert_eq!(nested_comment.statement_count, 2);
        assert_eq!(nested_comment.risk, StatementRisk::Unknown);

        let carriage_return = analyze_sql(
            "SELECT 1 -- comment\r; DROP TABLE users;",
            SqlDialect::PostgreSql,
        );
        assert_eq!(carriage_return.statement_count, 2);
        assert_eq!(carriage_return.risk, StatementRisk::Unknown);

        for dialect in [SqlDialect::PostgreSql, SqlDialect::MySql] {
            let analysis = analyze_sql(
                r"SELECT E'x\'-- quote mode is session-defined'; DROP TABLE users;",
                dialect,
            );
            assert_eq!(analysis.risk, StatementRisk::Unknown, "{dialect:?}");
        }
    }

    #[test]
    fn empty_and_multi_statement_input_fail_closed() {
        let empty = analyze_sql(" -- only trivia\n/* still trivia */ ", SqlDialect::Sqlite);
        assert_eq!(empty.statement_count, 0);
        assert_eq!(empty.risk, StatementRisk::Unknown);
        assert_eq!(empty.warnings, vec![SqlAnalysisWarning::EmptySql]);

        let multiple = analyze_sql(
            "SELECT ';' AS value; -- keep ; here\nSELECT `a;b` FROM [records;archive];",
            SqlDialect::Sqlite,
        );
        assert_eq!(multiple.statement_count, 2);
        assert_eq!(multiple.statement_class, StatementClass::Unknown);
        assert_eq!(multiple.risk, StatementRisk::Unknown);
        assert!(multiple
            .warnings
            .contains(&SqlAnalysisWarning::MultipleStatements));
    }

    #[test]
    fn simple_qualified_and_quoted_table_references_are_deduplicated() {
        let sqlite = analyze_sql(
            "SELECT * FROM \"analytics\".\"events\" e JOIN [users] u ON u.id = e.user_id JOIN [users] u2 ON u2.id = e.owner_id",
            SqlDialect::Sqlite,
        );
        assert_eq!(
            sqlite.referenced_tables,
            vec![
                SqlTableRef {
                    schema: Some("analytics".to_string()),
                    name: "events".to_string(),
                },
                SqlTableRef {
                    schema: None,
                    name: "users".to_string(),
                },
            ]
        );

        let mysql = analyze_sql(
            "UPDATE `app`.`orders` SET status = 'paid'",
            SqlDialect::MySql,
        );
        assert_eq!(
            mysql.referenced_tables,
            vec![SqlTableRef {
                schema: Some("app".to_string()),
                name: "orders".to_string(),
            }]
        );

        let ddl = analyze_sql("DROP TABLE IF EXISTS users", SqlDialect::PostgreSql);
        assert_eq!(
            ddl.referenced_tables,
            vec![SqlTableRef {
                schema: None,
                name: "users".to_string(),
            }]
        );
    }

    #[test]
    fn ambiguous_subquery_reference_is_reported_without_guessing() {
        let analysis = analyze_sql(
            "SELECT * FROM (SELECT * FROM users) nested",
            SqlDialect::PostgreSql,
        );

        assert!(analysis
            .warnings
            .contains(&SqlAnalysisWarning::ReferencesIncomplete));

        let cte = analyze_sql(
            "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent",
            SqlDialect::PostgreSql,
        );
        assert!(cte.referenced_tables.is_empty());
        assert!(cte
            .warnings
            .contains(&SqlAnalysisWarning::ReferencesIncomplete));
    }

    #[test]
    fn analysis_has_stable_wire_names() {
        let value = serde_json::to_value(analyze_sql(
            "SELECT * FROM public.users",
            SqlDialect::PostgreSql,
        ))
        .unwrap();

        assert_eq!(
            value,
            json!({
                "dialect": "postgresql",
                "statementCount": 1,
                "statementClass": "query",
                "risk": "read_only",
                "referencedTables": [{ "schema": "public", "name": "users" }],
                "warnings": []
            })
        );

        let empty = serde_json::to_value(analyze_sql("", SqlDialect::Sqlite)).unwrap();
        assert_eq!(
            empty,
            json!({
                "dialect": "sqlite",
                "statementCount": 0,
                "statementClass": "unknown",
                "risk": "unknown",
                "referencedTables": [],
                "warnings": ["empty_sql"]
            })
        );
    }
}
