#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "A1.1 adapter is consumed by later Agent runtime slices"
    )
)]
pub mod agent;
mod connection;
pub mod connection_manager;
mod connection_v2;
pub(crate) mod demo_seed;
mod dialect;
pub mod driver;
pub mod driver_packages;
pub mod driver_registry;
mod metadata;
pub mod metadata_v2;
mod mysql_runtime;
pub mod mysql_validation;
mod persistence;
pub mod persistence_v2;
mod product;
mod query;
mod runtime_status_export;
pub mod sql_analysis;
mod sql_lexer;
pub mod state;
pub mod types;

pub use connection::*;
pub use connection_v2::*;
pub use dialect::SqlDialect;
pub use driver_packages::*;
pub use metadata::*;
pub use metadata_v2::*;
pub use mysql_validation::*;
pub use product::*;
pub use query::*;
pub use runtime_status_export::*;
pub use state::SqlConnectionStore;
#[allow(unused_imports)]
pub use types::*;
