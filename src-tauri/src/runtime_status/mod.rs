/*---------------------------------------------------------------------------------------------
 * Nyala Studio - SQL runtime status contract.
 *
 * This file is the single source of truth for which SQL drivers are
 * available in the current Nyala Studio build. Every surface that
 * renders a driver status (README, product catalog, driver card,
 * command palette, AI context, etc.) must derive its status from
 * `RUNTIME_STATUS_TABLE`; no other module is allowed to handcraft
 * driver status strings.
 *
 * Phase 00 - Runtime Status Alignment.
 *--------------------------------------------------------------------------------------------*/

use serde::Serialize;

/// Runtime maturity of a SQL driver.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Stable,
    Preview,
    Planned,
    Disabled,
}

impl RuntimeStatus {
    pub fn as_token(self) -> &'static str {
        match self {
            RuntimeStatus::Stable => "stable",
            RuntimeStatus::Preview => "preview",
            RuntimeStatus::Planned => "planned",
            RuntimeStatus::Disabled => "disabled",
        }
    }

    /// Returns true when this status can be used as the minimum for opening
    /// a real runtime driver. Stable and Preview are usable; Planned and
    /// Disabled are not.
    pub fn is_runnable(self) -> bool {
        matches!(self, RuntimeStatus::Stable | RuntimeStatus::Preview)
    }
}

/// Logical driver identifier. Driver id is decoupled from `ConnectionKind`
/// so other layers (UI, AI, plugin registry) only see this enum.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DriverId {
    Sqlite,
    MySql,
    Postgres,
}

impl DriverId {
    pub fn as_token(self) -> &'static str {
        match self {
            DriverId::Sqlite => "sqlite",
            DriverId::MySql => "mysql",
            DriverId::Postgres => "postgres",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DriverRuntimeEntry {
    pub id: DriverId,
    pub display_name: &'static str,
    pub status: RuntimeStatus,
    pub summary: &'static str,
    pub notes: &'static [&'static str],
}

/// Truth-of-record for runtime status.
///
/// If you change anything here, also update:
/// - `README.md` runtime driver table
/// - `scripts/verify-sql-runtime-status.mjs` checks
/// - frontend `services/sql/common/sqlDriverCatalog.ts` allowed enum
pub const RUNTIME_STATUS_TABLE: &[DriverRuntimeEntry] = &[
    DriverRuntimeEntry {
        id: DriverId::Sqlite,
        display_name: "SQLite",
        status: RuntimeStatus::Stable,
        summary: "File / in-memory database for MVP stable usage.",
        notes: &[
            "supports file path",
            "supports :memory:",
            "metadata, query execution, cancellation, read-only mode enabled",
        ],
    },
    DriverRuntimeEntry {
        id: DriverId::MySql,
        display_name: "MySQL",
        status: RuntimeStatus::Preview,
        summary: "Local/dev validation only; cancellation not enabled yet.",
        notes: &[
            "connection, metadata, query execution enabled",
            "query cancellation is not supported yet",
            "intended for local/dev validation first",
        ],
    },
    DriverRuntimeEntry {
        id: DriverId::Postgres,
        display_name: "PostgreSQL",
        status: RuntimeStatus::Planned,
        summary: "Protocol fields exist, runtime not enabled yet.",
        notes: &[
            "do not show as available in any product UI",
            "runtime driver will be enabled in a later phase",
        ],
    },
];

pub fn lookup(id: DriverId) -> Option<&'static DriverRuntimeEntry> {
    RUNTIME_STATUS_TABLE.iter().find(|entry| entry.id == id)
}

pub fn snapshot() -> Vec<DriverRuntimeEntry> {
    RUNTIME_STATUS_TABLE.to_vec()
}

/// Runtime guard: ensures the requested driver meets a minimum maturity
/// level. Stable <= Stable, Preview <= Preview, Planned <= Planned all pass.
/// Asking Stable when only Preview is available returns an error string.
pub fn assert_minimum_status(id: DriverId, minimum: RuntimeStatus) -> Result<(), &'static str> {
    let Some(entry) = lookup(id) else {
        return Err("unknown driver");
    };

    if entry.status == RuntimeStatus::Disabled {
        return Err("driver is disabled");
    }

    if !minimum.is_allowed_when_current_is(entry.status) {
        return Err("driver does not meet required runtime status");
    }

    Ok(())
}

impl RuntimeStatus {
    fn is_allowed_when_current_is(self, current: RuntimeStatus) -> bool {
        match current {
            RuntimeStatus::Stable => {
                matches!(
                    self,
                    RuntimeStatus::Stable
                        | RuntimeStatus::Preview
                        | RuntimeStatus::Planned
                        | RuntimeStatus::Disabled
                )
            }
            RuntimeStatus::Preview => {
                matches!(
                    self,
                    RuntimeStatus::Preview | RuntimeStatus::Planned | RuntimeStatus::Disabled
                )
            }
            RuntimeStatus::Planned => {
                matches!(self, RuntimeStatus::Planned | RuntimeStatus::Disabled)
            }
            RuntimeStatus::Disabled => matches!(self, RuntimeStatus::Disabled),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_table_has_exactly_three_drivers() {
        assert_eq!(RUNTIME_STATUS_TABLE.len(), 3);
    }

    #[test]
    fn driver_ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for entry in RUNTIME_STATUS_TABLE {
            assert!(seen.insert(entry.id), "duplicate driver id");
        }
    }

    #[test]
    fn sqlite_is_stable() {
        let entry = lookup(DriverId::Sqlite).expect("sqlite present");
        assert_eq!(entry.status, RuntimeStatus::Stable);
        assert!(entry.status.is_runnable());
    }

    #[test]
    fn mysql_is_preview() {
        let entry = lookup(DriverId::MySql).expect("mysql present");
        assert_eq!(entry.status, RuntimeStatus::Preview);
        assert!(entry.status.is_runnable());
    }

    #[test]
    fn postgres_is_planned_not_runnable() {
        let entry = lookup(DriverId::Postgres).expect("postgres present");
        assert_eq!(entry.status, RuntimeStatus::Planned);
        assert!(!entry.status.is_runnable());
        assert_ne!(entry.status, RuntimeStatus::Stable);
        assert_ne!(entry.status, RuntimeStatus::Preview);
    }

    #[test]
    fn runtime_status_serializes_lowercase() {
        let value = serde_json::to_string(&RuntimeStatus::Preview).expect("serialize");
        assert_eq!(value, "\"preview\"");
    }

    #[test]
    fn driver_id_tokens_are_lowercase() {
        assert_eq!(DriverId::Sqlite.as_token(), "sqlite");
        assert_eq!(DriverId::MySql.as_token(), "mysql");
        assert_eq!(DriverId::Postgres.as_token(), "postgres");
    }

    #[test]
    fn assert_minimum_allows_any_minimum_for_stable() {
        for m in [
            RuntimeStatus::Stable,
            RuntimeStatus::Preview,
            RuntimeStatus::Planned,
            RuntimeStatus::Disabled,
        ] {
            assert!(
                assert_minimum_status(DriverId::Sqlite, m).is_ok(),
                "stable should allow {m:?}",
            );
        }
    }

    #[test]
    fn assert_minimum_rejects_when_driver_is_planned() {
        assert!(assert_minimum_status(DriverId::Postgres, RuntimeStatus::Stable).is_err());
        assert!(assert_minimum_status(DriverId::Postgres, RuntimeStatus::Preview).is_err());
        assert!(assert_minimum_status(DriverId::Postgres, RuntimeStatus::Planned).is_ok());
        assert!(assert_minimum_status(DriverId::Postgres, RuntimeStatus::Disabled).is_ok());
    }

    #[test]
    fn assert_minimum_rejects_when_minimum_is_stable_but_driver_is_preview() {
        assert!(assert_minimum_status(DriverId::MySql, RuntimeStatus::Stable).is_err());
        assert!(assert_minimum_status(DriverId::MySql, RuntimeStatus::Preview).is_ok());
        assert!(assert_minimum_status(DriverId::MySql, RuntimeStatus::Planned).is_ok());
    }

    #[test]
    fn snapshot_returns_full_table() {
        let entries = snapshot();
        assert_eq!(entries.len(), RUNTIME_STATUS_TABLE.len());
        // 顺序稳定:  sqlite, mysql, postgres
        assert_eq!(entries[0].id, DriverId::Sqlite);
        assert_eq!(entries[1].id, DriverId::MySql);
        assert_eq!(entries[2].id, DriverId::Postgres);
    }
}
