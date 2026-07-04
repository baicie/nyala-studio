/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL runtime status command.
 *
 * Exposes `runtime_status::RUNTIME_STATUS_TABLE` to the frontend via a Tauri
 * command so all UI surfaces can read driver status from a single source.
 * Phase 00 — Runtime Status Alignment.
 *--------------------------------------------------------------------------------------------*/

use crate::runtime_status::{DriverId, DriverRuntimeEntry, RuntimeStatus};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverRuntimeStatusDto {
    pub id: String,
    pub display_name: String,
    pub status: String,
    pub summary: String,
    pub notes: Vec<String>,
}

impl From<&DriverRuntimeEntry> for DriverRuntimeStatusDto {
    fn from(entry: &DriverRuntimeEntry) -> Self {
        Self {
            id: entry.id.as_token().to_string(),
            display_name: entry.display_name.to_string(),
            status: entry.status.as_token().to_string(),
            summary: entry.summary.to_string(),
            notes: entry.notes.iter().map(|note| note.to_string()).collect(),
        }
    }
}

#[tauri::command]
pub fn sql_list_driver_runtime_status() -> Vec<DriverRuntimeStatusDto> {
    crate::runtime_status::snapshot()
        .iter()
        .map(DriverRuntimeStatusDto::from)
        .collect()
}

/// Runtime guard exposed to the frontend for any UI flow that wants to
/// verify a driver can be opened before issuing the actual command. The
/// string error is intentionally not specific to avoid leaking internal
/// state across the IPC boundary.
#[tauri::command]
pub fn sql_assert_driver_runtime_status(driver_id: String, minimum: String) -> Result<(), String> {
    let driver: DriverId = parse_driver(&driver_id)?;
    let minimum_status = parse_runtime_status(&minimum)?;
    crate::runtime_status::assert_minimum_status(driver, minimum_status)
        .map_err(|message| format!("driver {driver_id} ({minimum}) guard rejected: {message}"))
}

fn parse_driver(value: &str) -> Result<DriverId, String> {
    match value {
        "sqlite" => Ok(DriverId::Sqlite),
        "mysql" => Ok(DriverId::MySql),
        "postgres" | "postgresql" => Ok(DriverId::Postgres),
        _ => Err(format!("unknown driver id: {value}")),
    }
}

fn parse_runtime_status(value: &str) -> Result<RuntimeStatus, String> {
    match value {
        "stable" => Ok(RuntimeStatus::Stable),
        "preview" => Ok(RuntimeStatus::Preview),
        "planned" => Ok(RuntimeStatus::Planned),
        "disabled" => Ok(RuntimeStatus::Disabled),
        _ => Err(format!("unknown runtime status: {value}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_uses_lowercase_token_strings() {
        let entry = crate::runtime_status::lookup(DriverId::MySql).unwrap();
        let dto = DriverRuntimeStatusDto::from(entry);
        assert_eq!(dto.id, "mysql");
        assert_eq!(dto.status, "preview");
        assert!(dto.notes.len() >= 2);
    }

    #[test]
    fn list_command_returns_full_table_in_documented_order() {
        let list = sql_list_driver_runtime_status();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].id, "sqlite");
        assert_eq!(list[1].id, "mysql");
        assert_eq!(list[2].id, "postgres");
    }

    #[test]
    fn assert_command_rejects_planned_when_stable_required() {
        let err = sql_assert_driver_runtime_status("postgres".into(), "stable".into()).unwrap_err();
        assert!(err.contains("guard rejected"));
    }

    #[test]
    fn assert_command_allows_stable_for_any_minimum() {
        for m in ["stable", "preview", "planned", "disabled"] {
            sql_assert_driver_runtime_status("sqlite".into(), m.into())
                .expect("sqlite should always be allowed");
        }
    }

    #[test]
    fn assert_command_accepts_postgres_alias() {
        sql_assert_driver_runtime_status("postgresql".into(), "planned".into())
            .expect("postgresql alias should resolve");
    }

    #[test]
    fn assert_command_rejects_unknown_driver() {
        assert!(sql_assert_driver_runtime_status("oracle".into(), "stable".into()).is_err());
    }

    #[test]
    fn assert_command_rejects_unknown_runtime_status() {
        assert!(sql_assert_driver_runtime_status("sqlite".into(), "beta".into()).is_err());
    }
}
