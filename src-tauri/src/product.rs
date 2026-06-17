//! Product constants for SQL Studio Next.
//!
//! Keep user-visible branding in one place so future refactors do not
//! accidentally regress back to upstream `SideX` names.
#![allow(clippy::doc_markdown)]

#[allow(dead_code)]
pub(crate) const PRODUCT_NAME: &str = "SQL Studio Next";
#[allow(dead_code)]
pub(crate) const APP_TITLE: &str = "SQL Studio";
#[allow(dead_code)]
pub(crate) const APP_IDENTIFIER: &str = "com.baicie.sqlstudio";

pub(crate) const APP_MENU_ID: &str = "sql_studio_menu";
pub(crate) const APP_MENU_LABEL: &str = "SQL Studio";
pub(crate) const ABOUT_MENU_LABEL: &str = "About SQL Studio";

pub(crate) const STORAGE_DB_FILE_NAME: &str = "sql_studio_storage.db";
pub(crate) const STATE_DB_FILE_NAME: &str = "sql_studio_state.db";

/// Legacy file names left by the upstream SideX fork.
///
/// Used by the one-shot migration in [`crate::resolve_product_data_file`].
/// Keep them around until all pre-Phase-1 user data has rolled forward.
pub(crate) const LEGACY_STORAGE_DB_FILE_NAME: &str = "sidex_storage.db";
pub(crate) const LEGACY_STATE_DB_FILE_NAME: &str = "sidex_state.db";

/// Value exposed to child shells via the `TERM_PROGRAM` env var.
///
/// Mirrors [`APP_TITLE`] so terminal-aware tooling (e.g. shell prompts,
/// `iterm2`/`tmux` integrations) shows the SQL Studio brand.
pub(crate) const TERMINAL_PROGRAM_NAME: &str = APP_TITLE;

pub(crate) const NATIVE_MENU_EVENT: &str = "sql-studio-native-menu";

/// Transitional compatibility event for existing frontend listeners.
///
/// This is intentionally not user-visible. Remove this once all frontend
/// listeners have migrated to [`NATIVE_MENU_EVENT`].
pub(crate) const LEGACY_NATIVE_MENU_EVENT: &str = "sidex-native-menu";

pub(crate) const UPDATE_STATE_EVENT: &str = "sql-studio://update/state-change";
#[allow(dead_code)]
pub(crate) const UPDATE_USER_AGENT_NAME: &str = "sql-studio-next";

pub(crate) fn update_user_agent(version: &str, os: &str) -> String {
    format!("{UPDATE_USER_AGENT_NAME}/{version} ({os})")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_no_legacy_brand(name: &str, value: &str) {
        let normalized = value.to_ascii_lowercase();

        assert!(
            !normalized.contains("sidex"),
            "{name} must not expose legacy SideX branding: {value}"
        );
        assert!(
            !normalized.contains("siden"),
            "{name} must not expose upstream Siden branding: {value}"
        );
    }

    #[test]
    fn product_identity_uses_sql_studio_branding() {
        let values = [
            ("PRODUCT_NAME", PRODUCT_NAME),
            ("APP_TITLE", APP_TITLE),
            ("APP_IDENTIFIER", APP_IDENTIFIER),
            ("APP_MENU_ID", APP_MENU_ID),
            ("APP_MENU_LABEL", APP_MENU_LABEL),
            ("ABOUT_MENU_LABEL", ABOUT_MENU_LABEL),
            ("TERMINAL_PROGRAM_NAME", TERMINAL_PROGRAM_NAME),
            ("STORAGE_DB_FILE_NAME", STORAGE_DB_FILE_NAME),
            ("STATE_DB_FILE_NAME", STATE_DB_FILE_NAME),
            ("NATIVE_MENU_EVENT", NATIVE_MENU_EVENT),
            ("UPDATE_STATE_EVENT", UPDATE_STATE_EVENT),
            ("UPDATE_USER_AGENT_NAME", UPDATE_USER_AGENT_NAME),
        ];

        for (name, value) in values {
            assert_no_legacy_brand(name, value);
        }
    }

    #[test]
    fn database_file_names_are_product_scoped() {
        assert_eq!(STORAGE_DB_FILE_NAME, "sql_studio_storage.db");
        assert_eq!(STATE_DB_FILE_NAME, "sql_studio_state.db");
    }

    #[test]
    fn legacy_database_file_names_are_marked_for_migration() {
        assert_eq!(LEGACY_STORAGE_DB_FILE_NAME, "sidex_storage.db");
        assert_eq!(LEGACY_STATE_DB_FILE_NAME, "sidex_state.db");
    }

    #[test]
    fn terminal_program_name_mirrors_app_title() {
        assert_eq!(TERMINAL_PROGRAM_NAME, APP_TITLE);
        assert!(TERMINAL_PROGRAM_NAME.contains("SQL Studio"));
    }

    #[test]
    fn native_menu_event_uses_sql_studio_namespace() {
        assert_eq!(NATIVE_MENU_EVENT, "sql-studio-native-menu");
    }

    #[test]
    fn legacy_native_menu_event_is_explicitly_compat_only() {
        assert_eq!(LEGACY_NATIVE_MENU_EVENT, "sidex-native-menu");
    }

    #[test]
    fn update_user_agent_uses_product_name() {
        assert_eq!(
            update_user_agent("0.1.0", "macos"),
            "sql-studio-next/0.1.0 (macos)"
        );
    }
}
