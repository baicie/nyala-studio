use std::env;
use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

#[cfg(all(feature = "webdriver", debug_assertions))]
const WEBDRIVER_APP_DATA_DIR_ENV: &str = "NYALA_WEBDRIVER_APP_DATA_DIR";

#[derive(Debug, Serialize)]
pub struct OsInfo {
    pub platform: String,
    pub arch: String,
    pub hostname: String,
    pub homedir: String,
    pub tmpdir: String,
}

#[tauri::command]
pub fn get_os_info() -> OsInfo {
    OsInfo {
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        hostname: hostname::get().map_or_else(
            |_| "unknown".to_string(),
            |h| h.to_string_lossy().to_string(),
        ),
        homedir: dirs::home_dir().map_or_else(
            || "unknown".to_string(),
            |p| p.to_string_lossy().to_string(),
        ),
        tmpdir: env::temp_dir().to_string_lossy().to_string(),
    }
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn get_env(key: String) -> Option<String> {
    env::var(&key).ok()
}

const SENSITIVE_ENV_PATTERNS: &[&str] = &[
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "PRIVATE_KEY",
    "API_KEY",
    "APIKEY",
    "AUTH",
    "AWS_",
    "AZURE_",
    "GCP_",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "DOCKER_PASSWORD",
    "SSH_",
    "GPG_",
];

#[tauri::command]
pub fn get_all_env() -> std::collections::HashMap<String, String> {
    env::vars()
        .filter(|(key, _)| {
            let upper = key.to_uppercase();
            !SENSITIVE_ENV_PATTERNS.iter().any(|p| upper.contains(p))
        })
        .collect()
}

#[tauri::command]
pub fn get_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            super::terminal::resolve_windows_shell()
        } else {
            "/bin/sh".to_string()
        }
    })
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn get_user_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let user_dir = resolve_user_data_dir(&app)?;
    std::fs::create_dir_all(&user_dir)
        .map_err(|e| format!("failed to create UserData dir: {e}"))?;
    Ok(user_dir.to_string_lossy().to_string())
}

pub(crate) fn resolve_user_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = webdriver_app_data_dir_override()? {
        return Ok(data_dir.join("UserData"));
    }

    #[cfg(target_os = "linux")]
    if let Some(config_dir) = dirs::config_dir() {
        return Ok(config_dir.join("SideX").join("UserData"));
    }

    Ok(resolve_app_data_dir(app)?.join("UserData"))
}

pub(crate) fn resolve_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = webdriver_app_data_dir_override()? {
        return Ok(data_dir);
    }

    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

#[cfg(all(feature = "webdriver", debug_assertions))]
fn webdriver_app_data_dir_override() -> Result<Option<PathBuf>, String> {
    let Some(value) = std::env::var_os(WEBDRIVER_APP_DATA_DIR_ENV) else {
        return Ok(None);
    };
    let path = validate_webdriver_app_data_dir(PathBuf::from(value))?;
    Ok(Some(path))
}

#[cfg(all(feature = "webdriver", debug_assertions))]
fn validate_webdriver_app_data_dir(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.parent().is_none() {
        return Err(format!(
            "{WEBDRIVER_APP_DATA_DIR_ENV} must be an absolute non-root path"
        ));
    }
    Ok(path)
}

#[cfg(not(all(feature = "webdriver", debug_assertions)))]
#[allow(
    clippy::unnecessary_wraps,
    reason = "keep the feature-disabled helper compatible with the fallible WebDriver implementation"
)]
fn webdriver_app_data_dir_override() -> Result<Option<PathBuf>, String> {
    Ok(None)
}

#[cfg(all(test, feature = "webdriver"))]
mod tests {
    use super::validate_webdriver_app_data_dir;
    use std::path::PathBuf;

    #[test]
    fn webdriver_app_data_override_requires_an_absolute_non_root_path() {
        assert!(validate_webdriver_app_data_dir(PathBuf::from("relative")).is_err());
        assert!(
            validate_webdriver_app_data_dir(std::env::temp_dir().join("nyala-webdriver")).is_ok()
        );
    }
}
