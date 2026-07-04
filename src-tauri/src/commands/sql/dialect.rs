//! SQL dialect domain helpers.
//!
//! Phase 9 adds foundation for PostgreSQL/MySQL SQL generation.

#![allow(dead_code)]

use super::types::SqlConnectionKind;

pub const SQL_DEFAULT_TABLE_PREVIEW_LIMIT: usize = 100;
pub const SQL_MAX_TABLE_PREVIEW_LIMIT: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    Sqlite,
    PostgreSql,
    MySql,
}

impl SqlDialect {
    pub fn from_connection_kind(kind: SqlConnectionKind) -> Self {
        match kind {
            SqlConnectionKind::Sqlite => Self::Sqlite,
            SqlConnectionKind::PostgreSql => Self::PostgreSql,
            SqlConnectionKind::MySql => Self::MySql,
        }
    }

    pub fn quote_identifier(self, value: &str) -> Result<String, String> {
        let normalized = normalize_identifier(value, "identifier")?;

        match self {
            Self::Sqlite | Self::PostgreSql => {
                Ok(format!("\"{}\"", normalized.replace('"', "\"\"")))
            }
            Self::MySql => Ok(format!("`{}`", normalized.replace('`', "``"))),
        }
    }

    pub fn format_qualified_name(self, schema: Option<&str>, name: &str) -> Result<String, String> {
        let normalized_name = normalize_identifier(name, "name")?;
        let normalized_schema = normalize_optional_identifier(schema, "schema")?;

        match normalized_schema {
            None => self.quote_identifier(&normalized_name),
            Some(schema) if self.should_omit_schema(&schema) => {
                self.quote_identifier(&normalized_name)
            }
            Some(schema) => Ok(format!(
                "{}.{}",
                self.quote_identifier(&schema)?,
                self.quote_identifier(&normalized_name)?
            )),
        }
    }

    pub fn create_table_preview_sql(
        self,
        schema: Option<&str>,
        table_name: &str,
        limit: Option<usize>,
    ) -> Result<String, String> {
        let limit = normalize_preview_limit(limit)?;
        let table_name = self.format_qualified_name(schema, table_name)?;

        Ok(format!("SELECT *\nFROM {table_name}\nLIMIT {limit};\n"))
    }

    fn should_omit_schema(self, schema: &str) -> bool {
        match self {
            Self::Sqlite => schema == "main",
            Self::PostgreSql => schema == "public",
            Self::MySql => false,
        }
    }
}

pub fn normalize_preview_limit(limit: Option<usize>) -> Result<usize, String> {
    match limit {
        None => Ok(SQL_DEFAULT_TABLE_PREVIEW_LIMIT),
        Some(0) => Err("limit must be a positive integer".to_string()),
        Some(value) => Ok(value.min(SQL_MAX_TABLE_PREVIEW_LIMIT)),
    }
}

fn normalize_identifier(value: &str, field_name: &str) -> Result<String, String> {
    let normalized = value.trim();

    if normalized.is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }

    if normalized.contains('\0') {
        return Err(format!("{field_name} must not contain NUL bytes"));
    }

    Ok(normalized.to_string())
}

fn normalize_optional_identifier(
    value: Option<&str>,
    field_name: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    let normalized = value.trim();

    if normalized.is_empty() {
        return Ok(None);
    }

    if normalized.contains('\0') {
        return Err(format!("{field_name} must not contain NUL bytes"));
    }

    Ok(Some(normalized.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_quotes_identifier_with_double_quotes() {
        assert_eq!(
            SqlDialect::Sqlite.quote_identifier("users").unwrap(),
            "\"users\""
        );
    }

    #[test]
    fn sqlite_escapes_double_quotes() {
        assert_eq!(
            SqlDialect::Sqlite.quote_identifier("weird\"name").unwrap(),
            "\"weird\"\"name\""
        );
    }

    #[test]
    fn postgresql_quotes_identifier_with_double_quotes() {
        assert_eq!(
            SqlDialect::PostgreSql.quote_identifier("users").unwrap(),
            "\"users\""
        );
    }

    #[test]
    fn mysql_quotes_identifier_with_backticks() {
        assert_eq!(
            SqlDialect::MySql.quote_identifier("users").unwrap(),
            "`users`"
        );
    }

    #[test]
    fn mysql_escapes_backticks() {
        assert_eq!(
            SqlDialect::MySql.quote_identifier("weird`name").unwrap(),
            "`weird``name`"
        );
    }

    #[test]
    fn sqlite_rejects_empty_identifier() {
        let err = SqlDialect::Sqlite.quote_identifier("  ").unwrap_err();
        assert!(err.contains("identifier must not be empty"));
    }

    #[test]
    fn sqlite_rejects_nul_identifier() {
        let err = SqlDialect::Sqlite
            .quote_identifier("bad\0name")
            .unwrap_err();
        assert!(err.contains("NUL"));
    }

    #[test]
    fn sqlite_omits_main_schema() {
        assert_eq!(
            SqlDialect::Sqlite
                .format_qualified_name(Some("main"), "users")
                .unwrap(),
            "\"users\""
        );
    }

    #[test]
    fn sqlite_includes_attached_schema() {
        assert_eq!(
            SqlDialect::Sqlite
                .format_qualified_name(Some("analytics"), "events")
                .unwrap(),
            "\"analytics\".\"events\""
        );
    }

    #[test]
    fn postgresql_omits_public_schema() {
        assert_eq!(
            SqlDialect::PostgreSql
                .format_qualified_name(Some("public"), "users")
                .unwrap(),
            "\"users\""
        );
    }

    #[test]
    fn mysql_never_omits_schema() {
        assert_eq!(
            SqlDialect::MySql
                .format_qualified_name(Some("app"), "users")
                .unwrap(),
            "`app`.`users`"
        );
    }

    #[test]
    fn sqlite_create_table_preview_sql() {
        assert_eq!(
            SqlDialect::Sqlite
                .create_table_preview_sql(Some("main"), "users", None)
                .unwrap(),
            "SELECT *\nFROM \"users\"\nLIMIT 100;\n"
        );
    }

    #[test]
    fn postgresql_create_table_preview_sql() {
        assert_eq!(
            SqlDialect::PostgreSql
                .create_table_preview_sql(Some("public"), "users", Some(25))
                .unwrap(),
            "SELECT *\nFROM \"users\"\nLIMIT 25;\n"
        );
    }

    #[test]
    fn mysql_create_table_preview_sql() {
        assert_eq!(
            SqlDialect::MySql
                .create_table_preview_sql(Some("app"), "users", Some(50))
                .unwrap(),
            "SELECT *\nFROM `app`.`users`\nLIMIT 50;\n"
        );
    }

    #[test]
    fn normalize_preview_limit_uses_default() {
        assert_eq!(
            normalize_preview_limit(None).unwrap(),
            SQL_DEFAULT_TABLE_PREVIEW_LIMIT
        );
    }

    #[test]
    fn normalize_preview_limit_clamps_large_limit() {
        assert_eq!(
            normalize_preview_limit(Some(usize::MAX)).unwrap(),
            SQL_MAX_TABLE_PREVIEW_LIMIT
        );
    }

    #[test]
    fn normalize_preview_limit_rejects_zero() {
        let err = normalize_preview_limit(Some(0)).unwrap_err();
        assert!(err.contains("positive integer"));
    }

    #[test]
    fn dialect_maps_from_connection_kind() {
        assert_eq!(
            SqlDialect::from_connection_kind(SqlConnectionKind::Sqlite),
            SqlDialect::Sqlite
        );
        assert_eq!(
            SqlDialect::from_connection_kind(SqlConnectionKind::PostgreSql),
            SqlDialect::PostgreSql
        );
        assert_eq!(
            SqlDialect::from_connection_kind(SqlConnectionKind::MySql),
            SqlDialect::MySql
        );
    }
}
