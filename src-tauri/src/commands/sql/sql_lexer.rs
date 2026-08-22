//! Small SQL lexer helpers used only for statement classification.
//!
//! This is deliberately not a SQL parser. It skips comments, quoted values,
//! and nested parentheses so read-only guards and result-shape detection do
//! not mistake trivia or a CTE body for the statement's top-level keyword.

use super::dialect::SqlDialect;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SqlToken {
    Word(String),
    QuotedIdentifier(String),
    Symbol(u8),
}

pub(super) fn first_sql_keyword(sql: &str) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut index = skip_sql_trivia(bytes, 0);
    read_sql_keyword(sql, bytes, &mut index)
}

pub(super) fn first_sql_keyword_for_dialect(sql: &str, dialect: SqlDialect) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut index = skip_statement_trivia(bytes, 0, dialect);
    read_sql_keyword(sql, bytes, &mut index)
}

fn read_sql_keyword(sql: &str, bytes: &[u8], index: &mut usize) -> Option<String> {
    let start = *index;

    while *index < bytes.len() && (bytes[*index].is_ascii_alphabetic() || bytes[*index] == b'_') {
        *index += 1;
    }

    if start == *index {
        return None;
    }

    Some(sql[start..*index].to_ascii_lowercase())
}

/// Finds the first top-level statement keyword after one or more CTE bodies.
pub(super) fn statement_keyword_after_with(sql: &str) -> Option<String> {
    statement_keyword_after_with_inner(sql, None)
}

pub(super) fn statement_keyword_after_with_for_dialect(
    sql: &str,
    dialect: SqlDialect,
) -> Option<String> {
    statement_keyword_after_with_inner(sql, Some(dialect))
}

fn statement_keyword_after_with_inner(sql: &str, dialect: Option<SqlDialect>) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut index = 0;
    let mut depth = 0usize;
    let mut awaiting_cte_body = false;
    let mut cte_body_depth = None;
    let mut after_cte_body = false;

    while index < bytes.len() {
        index = match dialect {
            Some(dialect) => skip_statement_trivia(bytes, index, dialect),
            None => skip_sql_trivia(bytes, index),
        };
        if index >= bytes.len() {
            break;
        }

        match bytes[index] {
            b'\'' | b'"' => {
                index = match dialect {
                    Some(dialect) => skip_statement_quoted(bytes, index, bytes[index], dialect),
                    None => skip_sql_quoted(bytes, index, bytes[index]),
                };
            }
            b'`' if dialect != Some(SqlDialect::PostgreSql) => {
                index = match dialect {
                    Some(dialect) => skip_statement_quoted(bytes, index, b'`', dialect),
                    None => skip_sql_quoted(bytes, index, b'`'),
                };
            }
            b'[' if dialect.is_none() || dialect == Some(SqlDialect::Sqlite) => {
                index = skip_sql_bracket_identifier(bytes, index);
            }
            b'$' if dialect == Some(SqlDialect::PostgreSql) => {
                index = skip_postgres_dollar_quote(bytes, index).unwrap_or(index + 1);
            }
            b'(' => {
                depth += 1;
                if awaiting_cte_body && depth == 1 {
                    cte_body_depth = Some(depth);
                    awaiting_cte_body = false;
                }
                index += 1;
            }
            b')' => {
                if depth == 0 {
                    return None;
                }

                let closing_cte_body = cte_body_depth == Some(depth);
                depth -= 1;
                if closing_cte_body && depth == 0 {
                    cte_body_depth = None;
                    after_cte_body = true;
                }
                index += 1;
            }
            b',' if depth == 0 && after_cte_body => {
                after_cte_body = false;
                index += 1;
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }

                if depth == 0 {
                    if after_cte_body {
                        return Some(sql[start..index].to_ascii_lowercase());
                    }

                    if sql[start..index].eq_ignore_ascii_case("as") {
                        awaiting_cte_body = true;
                    }
                }
            }
            _ => {
                index += 1;
            }
        }
    }

    None
}

pub(super) fn split_sql_statements(sql: &str, dialect: SqlDialect) -> Vec<&str> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        let next = skip_statement_trivia(bytes, index, dialect);
        if next != index {
            index = next;
            continue;
        }

        match bytes[index] {
            b'\'' | b'"' => index = skip_statement_quoted(bytes, index, bytes[index], dialect),
            b'`' if dialect != SqlDialect::PostgreSql => {
                index = skip_statement_quoted(bytes, index, b'`', dialect);
            }
            b'[' if dialect == SqlDialect::Sqlite => {
                index = skip_sql_bracket_identifier(bytes, index);
            }
            b'$' if dialect == SqlDialect::PostgreSql => {
                index = skip_postgres_dollar_quote(bytes, index).unwrap_or(index + 1);
            }
            b';' => {
                push_sql_statement(&mut statements, &sql[start..index], dialect);
                start = index + 1;
                index += 1;
            }
            _ => index += 1,
        }
    }

    push_sql_statement(&mut statements, &sql[start..], dialect);
    statements
}

/// Returns false when quotes, comments, or parentheses cannot be closed.
/// Classification must fail closed for these inputs because statement
/// boundaries and side effects are otherwise ambiguous.
pub(super) fn sql_structure_is_well_formed(sql: &str, dialect: SqlDialect) -> bool {
    let bytes = sql.as_bytes();
    let mut index = 0usize;
    let mut depth = 0usize;

    while index < bytes.len() {
        let next = skip_statement_trivia(bytes, index, dialect);
        if next != index {
            // A block comment that reaches EOF is indistinguishable from a
            // comment containing the rest of the query.
            if next == bytes.len() && !statement_trivia_is_well_formed(bytes, index, dialect) {
                return false;
            }
            index = next;
            continue;
        }

        index = match bytes[index] {
            b'\'' | b'"' => {
                let next = scan_statement_quoted(bytes, index, bytes[index], dialect);
                if !quoted_is_closed(bytes, index, bytes[index], dialect) {
                    return false;
                }
                next
            }
            b'`' if dialect != SqlDialect::PostgreSql => {
                let next = scan_statement_quoted(bytes, index, b'`', dialect);
                if !quoted_is_closed(bytes, index, b'`', dialect) {
                    return false;
                }
                next
            }
            b'[' if dialect == SqlDialect::Sqlite => {
                let next = skip_sql_bracket_identifier(bytes, index);
                if !bracket_identifier_is_closed(bytes, index) {
                    return false;
                }
                next
            }
            b'$' if dialect == SqlDialect::PostgreSql => {
                match skip_postgres_dollar_quote(bytes, index) {
                    Some(next) if next == bytes.len() => {
                        let delimiter_end = postgres_dollar_delimiter_end(bytes, index);
                        let delimiter = &bytes[index..=delimiter_end];
                        let content_start = delimiter_end + 1;
                        if !bytes[content_start..]
                            .windows(delimiter.len())
                            .any(|window| window == delimiter)
                        {
                            return false;
                        }
                        next
                    }
                    Some(next) => next,
                    None => index + 1,
                }
            }
            b'(' => {
                depth += 1;
                index + 1
            }
            b')' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
                index + 1
            }
            _ => index + 1,
        };
    }

    depth == 0
}

fn scan_statement_quoted(bytes: &[u8], mut index: usize, quote: u8, dialect: SqlDialect) -> usize {
    index += 1;
    while index < bytes.len() {
        if dialect == SqlDialect::MySql && bytes[index] == b'\\' && quote != b'`' {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if bytes[index] == quote {
            if index + 1 < bytes.len() && bytes[index + 1] == quote {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    index
}

fn quoted_is_closed(bytes: &[u8], start: usize, quote: u8, dialect: SqlDialect) -> bool {
    let mut index = start + 1;
    while index < bytes.len() {
        if dialect == SqlDialect::MySql && bytes[index] == b'\\' && quote != b'`' {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if bytes[index] == quote {
            if index + 1 < bytes.len() && bytes[index + 1] == quote {
                index += 2;
                continue;
            }
            return true;
        }
        index += 1;
    }
    false
}

fn bracket_identifier_is_closed(bytes: &[u8], start: usize) -> bool {
    let mut index = start + 1;
    while index < bytes.len() {
        if bytes[index] == b']' {
            if index + 1 < bytes.len() && bytes[index + 1] == b']' {
                index += 2;
                continue;
            }
            return true;
        }
        index += 1;
    }
    false
}

fn statement_block_comment_is_closed(bytes: &[u8], start: usize, dialect: SqlDialect) -> bool {
    let mut index = start + 2;
    let mut depth = 1usize;
    while index + 1 < bytes.len() {
        if dialect == SqlDialect::PostgreSql && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            depth += 1;
            index += 2;
            continue;
        }
        if bytes[index] == b'*' && bytes[index + 1] == b'/' {
            depth -= 1;
            if depth == 0 {
                return true;
            }
            index += 2;
            continue;
        }
        index += 1;
    }
    false
}

fn statement_trivia_is_well_formed(bytes: &[u8], mut index: usize, dialect: SqlDialect) -> bool {
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if dialect == SqlDialect::MySql && index < bytes.len() && bytes[index] == b'#' {
            index = skip_sql_line_comment(bytes, index + 1);
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'-' && bytes[index + 1] == b'-' {
            index = skip_sql_line_comment(bytes, index + 2);
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            if !statement_block_comment_is_closed(bytes, index, dialect) {
                return false;
            }
            index = skip_statement_block_comment(bytes, index, dialect);
            continue;
        }
        return true;
    }
}

fn postgres_dollar_delimiter_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start + 1;
    if bytes.get(end) != Some(&b'$') {
        while end < bytes.len() && bytes[end] != b'$' && is_postgres_identifier_byte(bytes[end]) {
            end += 1;
        }
    }
    end
}

fn skip_statement_quoted(bytes: &[u8], mut index: usize, quote: u8, dialect: SqlDialect) -> usize {
    index += 1;
    while index < bytes.len() {
        if dialect == SqlDialect::MySql && bytes[index] == b'\\' && quote != b'`' {
            index = (index + 2).min(bytes.len());
            continue;
        }

        if bytes[index] == quote {
            if index + 1 < bytes.len() && bytes[index + 1] == quote {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    index
}

fn skip_statement_trivia(bytes: &[u8], mut index: usize, dialect: SqlDialect) -> usize {
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }

        if dialect == SqlDialect::MySql && index < bytes.len() && bytes[index] == b'#' {
            index = skip_sql_line_comment(bytes, index + 1);
            continue;
        }

        if index + 1 < bytes.len() && bytes[index] == b'-' && bytes[index + 1] == b'-' {
            let is_comment = dialect != SqlDialect::MySql
                || index + 2 == bytes.len()
                || bytes[index + 2].is_ascii_whitespace()
                || bytes[index + 2].is_ascii_control();
            if is_comment {
                index = skip_sql_line_comment(bytes, index + 2);
                continue;
            }
        }

        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            index = skip_statement_block_comment(bytes, index, dialect);
            continue;
        }

        return index;
    }
}

fn skip_statement_block_comment(bytes: &[u8], mut index: usize, dialect: SqlDialect) -> usize {
    let mut depth = 1usize;
    index += 2;

    while index + 1 < bytes.len() {
        if dialect == SqlDialect::PostgreSql && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            depth += 1;
            index += 2;
            continue;
        }

        if bytes[index] == b'*' && bytes[index + 1] == b'/' {
            depth -= 1;
            index += 2;
            if depth == 0 {
                return index;
            }
            continue;
        }

        index += 1;
    }

    bytes.len()
}

fn skip_sql_line_comment(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && !matches!(bytes[index], b'\n' | b'\r') {
        index += 1;
    }
    index
}

pub(super) fn sql_tokens(sql: &str, dialect: SqlDialect) -> Vec<SqlToken> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;

    while index < bytes.len() {
        let next = skip_statement_trivia(bytes, index, dialect);
        if next != index {
            index = next;
            continue;
        }

        match bytes[index] {
            b'\'' => index = skip_statement_quoted(bytes, index, b'\'', dialect),
            b'"' | b'`' if bytes[index] == b'"' || dialect != SqlDialect::PostgreSql => {
                let quote = bytes[index];
                let (identifier, next) = read_quoted_identifier(sql, index, quote, dialect);
                if let Some(identifier) = identifier {
                    tokens.push(SqlToken::QuotedIdentifier(identifier));
                }
                index = next;
            }
            b'[' if dialect == SqlDialect::Sqlite => {
                let (identifier, next) = read_bracket_identifier(sql, index);
                if let Some(identifier) = identifier {
                    tokens.push(SqlToken::QuotedIdentifier(identifier));
                }
                index = next;
            }
            b'$' if dialect == SqlDialect::PostgreSql => {
                index = skip_postgres_dollar_quote(bytes, index).unwrap_or(index + 1);
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'$'))
                {
                    index += 1;
                }
                tokens.push(SqlToken::Word(sql[start..index].to_string()));
            }
            b'.' | b',' | b'(' | b')' | b'=' => {
                tokens.push(SqlToken::Symbol(bytes[index]));
                index += 1;
            }
            _ => index += 1,
        }
    }

    tokens
}

fn push_sql_statement<'a>(statements: &mut Vec<&'a str>, sql: &'a str, dialect: SqlDialect) {
    let mysql_executable_comment = dialect == SqlDialect::MySql
        && (sql.contains("/*!") || sql.contains("/*M!") || sql.contains("/*m!"));
    if mysql_executable_comment || skip_statement_trivia(sql.as_bytes(), 0, dialect) < sql.len() {
        statements.push(sql);
    }
}

fn read_quoted_identifier(
    sql: &str,
    start: usize,
    quote: u8,
    dialect: SqlDialect,
) -> (Option<String>, usize) {
    let bytes = sql.as_bytes();
    let end = skip_statement_quoted(bytes, start, quote, dialect);
    if end <= start + 1 || bytes.get(end - 1) != Some(&quote) {
        return (None, end);
    }

    let quote = char::from(quote).to_string();
    let escaped = format!("{quote}{quote}");
    (Some(sql[start + 1..end - 1].replace(&escaped, &quote)), end)
}

fn read_bracket_identifier(sql: &str, start: usize) -> (Option<String>, usize) {
    let bytes = sql.as_bytes();
    let end = skip_sql_bracket_identifier(bytes, start);
    if end <= start + 1 || bytes.get(end - 1) != Some(&b']') {
        return (None, end);
    }

    (Some(sql[start + 1..end - 1].replace("]]", "]")), end)
}

fn skip_postgres_dollar_quote(bytes: &[u8], start: usize) -> Option<usize> {
    if start > 0 && is_postgres_identifier_byte(bytes[start - 1]) {
        return None;
    }

    let first = *bytes.get(start + 1)?;
    let mut delimiter_end = start + 1;
    if first != b'$' {
        if first.is_ascii_digit() || !is_postgres_identifier_byte(first) {
            return None;
        }
        while delimiter_end < bytes.len()
            && bytes[delimiter_end] != b'$'
            && is_postgres_identifier_byte(bytes[delimiter_end])
        {
            delimiter_end += 1;
        }
        if bytes.get(delimiter_end) != Some(&b'$') {
            return None;
        }
    }

    let delimiter = &bytes[start..=delimiter_end];
    let content_start = delimiter_end + 1;
    let closing_offset = bytes[content_start..]
        .windows(delimiter.len())
        .position(|window| window == delimiter);

    Some(closing_offset.map_or(bytes.len(), |offset| {
        content_start + offset + delimiter.len()
    }))
}

fn is_postgres_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$') || !byte.is_ascii()
}

fn skip_sql_trivia(bytes: &[u8], mut index: usize) -> usize {
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }

        if index < bytes.len() && bytes[index] == b'#' {
            index = skip_sql_line_comment(bytes, index + 1);
            continue;
        }

        if index + 1 < bytes.len() && bytes[index] == b'-' && bytes[index + 1] == b'-' {
            index = skip_sql_line_comment(bytes, index + 2);
            continue;
        }

        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }

            if index + 1 < bytes.len() {
                index += 2;
            }
            continue;
        }

        return index;
    }
}

fn skip_sql_quoted(bytes: &[u8], mut index: usize, quote: u8) -> usize {
    index += 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' && quote != b'`' {
            index = (index + 2).min(bytes.len());
            continue;
        }

        if bytes[index] == quote {
            if index + 1 < bytes.len() && bytes[index + 1] == quote {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    index
}

fn skip_sql_bracket_identifier(bytes: &[u8], mut index: usize) -> usize {
    index += 1;
    while index < bytes.len() {
        if bytes[index] == b']' {
            if index + 1 < bytes.len() && bytes[index + 1] == b']' {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_keyword_skips_sqlite_and_mysql_comments() {
        assert_eq!(
            first_sql_keyword("-- comment\nSELECT 1").as_deref(),
            Some("select")
        );
        assert_eq!(
            first_sql_keyword("# comment\nSELECT 1").as_deref(),
            Some("select")
        );
        assert_eq!(
            first_sql_keyword("/* comment */\nSELECT 1").as_deref(),
            Some("select")
        );
    }

    #[test]
    fn cte_keyword_is_found_after_nested_bodies() {
        assert_eq!(
            statement_keyword_after_with(
                "WITH first_cte AS (SELECT ')' AS value), second_cte AS (SELECT 2) SELECT * FROM second_cte"
            )
            .as_deref(),
            Some("select")
        );
        assert_eq!(
            statement_keyword_after_with("WITH cte AS (SELECT 1) UPDATE users SET name = 'x'")
                .as_deref(),
            Some("update")
        );
    }

    #[test]
    fn malformed_cte_is_not_classified_as_a_statement() {
        assert_eq!(statement_keyword_after_with("WITH cte AS (SELECT 1"), None);
    }

    #[test]
    fn malformed_quotes_comments_and_parentheses_are_not_well_formed() {
        for (dialect, sql) in [
            (SqlDialect::Sqlite, "SELECT 'unterminated"),
            (SqlDialect::PostgreSql, "SELECT 1 /* unterminated"),
            (SqlDialect::Sqlite, "SELECT (1"),
            (SqlDialect::MySql, "SELECT 1)"),
        ] {
            assert!(
                !sql_structure_is_well_formed(sql, dialect),
                "{dialect:?}: {sql}"
            );
        }
    }

    #[test]
    fn escaped_quotes_and_nested_comments_remain_well_formed() {
        assert!(sql_structure_is_well_formed(
            "SELECT 'it''s fine'",
            SqlDialect::Sqlite
        ));
        assert!(sql_structure_is_well_formed(
            "SELECT 1 /* outer /* inner */ done */",
            SqlDialect::PostgreSql
        ));
        assert!(sql_structure_is_well_formed(
            "SELECT [a]]b] FROM t",
            SqlDialect::Sqlite
        ));
    }
}
