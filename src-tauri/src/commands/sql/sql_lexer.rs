//! Small SQL lexer helpers used only for statement classification.
//!
//! This is deliberately not a SQL parser. It skips comments, quoted values,
//! and nested parentheses so read-only guards and result-shape detection do
//! not mistake trivia or a CTE body for the statement's top-level keyword.

pub(super) fn first_sql_keyword(sql: &str) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut index = skip_sql_trivia(bytes, 0);
    let start = index;

    while index < bytes.len() && (bytes[index].is_ascii_alphabetic() || bytes[index] == b'_') {
        index += 1;
    }

    if start == index {
        return None;
    }

    Some(sql[start..index].to_ascii_lowercase())
}

/// Finds the first top-level statement keyword after one or more CTE bodies.
pub(super) fn statement_keyword_after_with(sql: &str) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut index = 0;
    let mut depth = 0usize;
    let mut awaiting_cte_body = false;
    let mut cte_body_depth = None;
    let mut after_cte_body = false;

    while index < bytes.len() {
        index = skip_sql_trivia(bytes, index);
        if index >= bytes.len() {
            break;
        }

        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                index = skip_sql_quoted(bytes, index, bytes[index]);
            }
            b'[' => {
                index = skip_sql_bracket_identifier(bytes, index);
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

fn skip_sql_trivia(bytes: &[u8], mut index: usize) -> usize {
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }

        if index < bytes.len() && bytes[index] == b'#' {
            index += 1;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }

        if index + 1 < bytes.len() && bytes[index] == b'-' && bytes[index + 1] == b'-' {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
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
}
