use super::types::SqlCommandError;
use base64::{engine::general_purpose, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use url::Url;

const SIGNED_MANIFEST: &str = include_str!("sql-driver-manifest.json");
const DRIVER_MANIFEST_PUBLIC_KEY: &str = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const DRIVER_PACKAGE_DIRECTORY: &str = "sql-drivers";
const DRIVER_PACKAGE_HOST: &str = "repo.maven.apache.org";
const MAX_DRIVER_PACKAGE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedDriverManifest {
    manifest_version: u32,
    public_key: String,
    signature: String,
    payload: DriverManifestPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverManifestPayload {
    manifest_version: u32,
    packages: Vec<DriverPackageManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverPackageManifest {
    id: String,
    driver_id: String,
    display_name: String,
    version: String,
    file_name: String,
    url: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlDriverPackage {
    pub id: String,
    pub driver_id: String,
    pub display_name: String,
    pub version: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub installed: bool,
}

#[tauri::command]
pub async fn sql_list_driver_packages(
    app: AppHandle,
) -> Result<Vec<SqlDriverPackage>, SqlCommandError> {
    let root = driver_package_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_driver_packages(&root))
        .await
        .map_err(|_| {
            SqlCommandError::new(
                "driver_package",
                "Driver package status task stopped before it could complete",
            )
        })?
}

#[tauri::command]
pub async fn sql_download_driver(
    app: AppHandle,
    package_id: String,
) -> Result<SqlDriverPackage, SqlCommandError> {
    let root = driver_package_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || download_driver(&root, &package_id))
        .await
        .map_err(|_| {
            SqlCommandError::new(
                "driver_package",
                "Driver package download task stopped before it could complete",
            )
        })?
}

fn driver_package_root(app: &AppHandle) -> Result<PathBuf, SqlCommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(DRIVER_PACKAGE_DIRECTORY))
        .map_err(|error| {
            SqlCommandError::new(
                "driver_package",
                format!("Resolve driver package directory: {error}"),
            )
        })
}

fn list_driver_packages(root: &Path) -> Result<Vec<SqlDriverPackage>, SqlCommandError> {
    let manifest = load_manifest()?;
    manifest
        .payload
        .packages
        .iter()
        .map(|package| package_status(root, package))
        .collect()
}

fn download_driver(root: &Path, package_id: &str) -> Result<SqlDriverPackage, SqlCommandError> {
    let manifest = load_manifest()?;
    let package = manifest
        .payload
        .packages
        .iter()
        .find(|package| package.id == package_id)
        .ok_or_else(|| SqlCommandError::new("invalid_input", "Unknown driver package"))?;
    validate_package(package)?;

    let target = package_path(root, package)?;
    if is_valid_cached_package(&target, package) {
        return package_status(root, package);
    }

    let parent = target.parent().ok_or_else(|| {
        SqlCommandError::new(
            "driver_package",
            "Driver package target has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Create driver package directory: {error}"),
        )
    })?;

    // Use a unique name and create_new below so concurrent downloads cannot
    // share a partial file or follow an attacker-controlled symlink.
    let temporary = target.with_file_name(format!(
        "{}.{}.part",
        package.file_name,
        uuid::Uuid::new_v4()
    ));
    let result = download_to_temporary_file(package, &temporary);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;

    if let Err(error) = install_verified_package(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    package_status(root, package)
}

fn install_verified_package(temporary: &Path, target: &Path) -> Result<(), SqlCommandError> {
    let initial_error = match fs::rename(temporary, target) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };

    if !target.exists() {
        return Err(SqlCommandError::new(
            "driver_package",
            format!("Install driver package: {initial_error}"),
        ));
    }

    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("driver-package");
    let backup = target.with_file_name(format!("{file_name}.{}.backup", uuid::Uuid::new_v4()));
    fs::rename(target, &backup).map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Stage cached driver package for replacement: {error}"),
        )
    })?;

    match fs::rename(temporary, target) {
        Ok(()) => {
            let _ = fs::remove_file(backup);
            Ok(())
        }
        Err(install_error) => {
            let restore_error = fs::rename(&backup, target).err();
            let message = restore_error.map_or_else(
                || format!("Install driver package: {install_error}"),
                |error| {
                    format!(
                        "Install driver package: {install_error}; restore cached package: {error}"
                    )
                },
            );
            Err(SqlCommandError::new("driver_package", message))
        }
    }
}

fn download_to_temporary_file(
    package: &DriverPackageManifest,
    temporary: &Path,
) -> Result<(), SqlCommandError> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("Nyala-Studio-driver-manager")
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_mins(2))
        .build()
        .map_err(|error| {
            SqlCommandError::new("driver_package", format!("Create download client: {error}"))
        })?;
    let mut response = client.get(&package.url).send().map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Download {}: {error}", package.display_name),
        )
    })?;

    if !response.status().is_success() {
        return Err(SqlCommandError::new(
            "driver_package",
            format!(
                "Download {} returned HTTP {}",
                package.display_name,
                response.status()
            ),
        ));
    }

    if validate_download_url(response.url(), &package.file_name).is_err() {
        return Err(SqlCommandError::new(
            "driver_package",
            format!(
                "Download {} resolved outside the trusted HTTPS source",
                package.display_name
            ),
        ));
    }

    if response
        .content_length()
        .is_some_and(|size| size > package.size_bytes)
    {
        return Err(SqlCommandError::new(
            "driver_package",
            format!(
                "Download {} is larger than its signed size",
                package.display_name
            ),
        ));
    }

    let mut file = create_temporary_package_file(temporary).map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Create temporary driver package: {error}"),
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut total = 0_u64;

    loop {
        let read = response.read(&mut buffer).map_err(|error| {
            SqlCommandError::new("driver_package", format!("Read driver package: {error}"))
        })?;
        if read == 0 {
            break;
        }

        total = total.saturating_add(read as u64);
        if total > package.size_bytes {
            return Err(SqlCommandError::new(
                "driver_package",
                format!(
                    "Download {} is larger than its signed size",
                    package.display_name
                ),
            ));
        }
        digest.update(&buffer[..read]);
        file.write_all(&buffer[..read]).map_err(|error| {
            SqlCommandError::new(
                "driver_package",
                format!("Write temporary driver package: {error}"),
            )
        })?;
    }

    file.sync_all().map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Flush temporary driver package: {error}"),
        )
    })?;

    let actual_hash = format!("{:x}", digest.finalize());
    if total != package.size_bytes || actual_hash != package.sha256 {
        return Err(SqlCommandError::new(
            "driver_package",
            format!(
                "Downloaded {} failed the signed size or SHA-256 check",
                package.display_name
            ),
        ));
    }

    Ok(())
}

fn create_temporary_package_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

fn package_status(
    root: &Path,
    package: &DriverPackageManifest,
) -> Result<SqlDriverPackage, SqlCommandError> {
    validate_package(package)?;
    let target = package_path(root, package)?;
    Ok(SqlDriverPackage {
        id: package.id.clone(),
        driver_id: package.driver_id.clone(),
        display_name: package.display_name.clone(),
        version: package.version.clone(),
        file_name: package.file_name.clone(),
        size_bytes: package.size_bytes,
        installed: is_valid_cached_package(&target, package),
    })
}

fn is_valid_cached_package(path: &Path, package: &DriverPackageManifest) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() != package.size_bytes {
        return false;
    }
    hash_file(path).is_ok_and(|hash| hash == package.sha256)
}

fn hash_file(path: &Path) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn package_path(root: &Path, package: &DriverPackageManifest) -> Result<PathBuf, SqlCommandError> {
    validate_package(package)?;
    Ok(root
        .join(&package.id)
        .join(&package.version)
        .join(&package.file_name))
}

fn load_manifest() -> Result<SignedDriverManifest, SqlCommandError> {
    let manifest: SignedDriverManifest =
        serde_json::from_str(SIGNED_MANIFEST).map_err(|error| {
            SqlCommandError::new(
                "driver_package",
                format!("Parse signed driver manifest: {error}"),
            )
        })?;
    verify_manifest(&manifest)?;
    Ok(manifest)
}

fn verify_manifest(manifest: &SignedDriverManifest) -> Result<(), SqlCommandError> {
    if manifest.manifest_version != 1 || manifest.payload.manifest_version != 1 {
        return Err(SqlCommandError::new(
            "driver_package",
            "Unsupported driver manifest version",
        ));
    }
    if manifest.public_key != DRIVER_MANIFEST_PUBLIC_KEY {
        return Err(SqlCommandError::new(
            "driver_package",
            "Driver manifest public key is not trusted",
        ));
    }

    let public_key_bytes = general_purpose::STANDARD
        .decode(DRIVER_MANIFEST_PUBLIC_KEY)
        .map_err(|error| {
            SqlCommandError::new(
                "driver_package",
                format!("Decode driver manifest key: {error}"),
            )
        })?;
    let public_key: [u8; 32] = public_key_bytes.try_into().map_err(|_| {
        SqlCommandError::new(
            "driver_package",
            "Driver manifest key has an invalid length",
        )
    })?;
    let verifying_key = VerifyingKey::from_bytes(&public_key).map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Parse driver manifest key: {error}"),
        )
    })?;
    let signature_bytes = general_purpose::STANDARD
        .decode(&manifest.signature)
        .map_err(|error| {
            SqlCommandError::new(
                "driver_package",
                format!("Decode driver manifest signature: {error}"),
            )
        })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Parse driver manifest signature: {error}"),
        )
    })?;
    let payload = serde_json::to_vec(&manifest.payload).map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Serialize driver manifest payload: {error}"),
        )
    })?;

    verifying_key.verify(&payload, &signature).map_err(|_| {
        SqlCommandError::new(
            "driver_package",
            "Driver manifest signature verification failed",
        )
    })
}

fn validate_package(package: &DriverPackageManifest) -> Result<(), SqlCommandError> {
    for (field, value) in [
        ("package id", package.id.as_str()),
        ("driver id", package.driver_id.as_str()),
        ("version", package.version.as_str()),
        ("file name", package.file_name.as_str()),
    ] {
        if !is_safe_path_component(value) {
            return Err(SqlCommandError::new(
                "driver_package",
                format!("Signed driver package has an invalid {field}"),
            ));
        }
    }
    if !matches!(package.driver_id.as_str(), "mysql" | "postgres") {
        return Err(SqlCommandError::new(
            "driver_package",
            "Signed driver package references an unsupported driver",
        ));
    }

    if package.size_bytes == 0 || package.size_bytes > MAX_DRIVER_PACKAGE_BYTES {
        return Err(SqlCommandError::new(
            "driver_package",
            "Signed driver package has an invalid size",
        ));
    }
    if package.sha256.len() != 64 || !package.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SqlCommandError::new(
            "driver_package",
            "Signed driver package has an invalid SHA-256 digest",
        ));
    }

    let url = Url::parse(&package.url).map_err(|error| {
        SqlCommandError::new(
            "driver_package",
            format!("Signed driver package has an invalid URL: {error}"),
        )
    })?;
    validate_download_url(&url, &package.file_name)
}

fn validate_download_url(url: &Url, file_name: &str) -> Result<(), SqlCommandError> {
    if url.scheme() != "https"
        || url.host_str() != Some(DRIVER_PACKAGE_HOST)
        || url.port().is_some()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(SqlCommandError::new(
            "driver_package",
            "Driver package URL is outside the trusted HTTPS source",
        ));
    }

    let path_segments = url.path_segments().ok_or_else(|| {
        SqlCommandError::new("driver_package", "Signed driver package URL has no path")
    })?;
    let path_segments: Vec<_> = path_segments.collect();
    if path_segments.is_empty()
        || path_segments
            .iter()
            .any(|segment| !is_safe_path_component(segment))
        || path_segments.last().copied() != Some(file_name)
    {
        return Err(SqlCommandError::new(
            "driver_package",
            "Driver package URL has an invalid path",
        ));
    }

    Ok(())
}

fn is_safe_path_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temporary_root() -> PathBuf {
        std::env::temp_dir().join(format!("nyala-driver-packages-{}", Uuid::new_v4()))
    }

    #[test]
    fn signed_manifest_is_verified_before_use() {
        let manifest = load_manifest().expect("repository manifest should verify");
        assert_eq!(manifest.payload.packages.len(), 2);
        assert_eq!(manifest.payload.packages[0].driver_id, "mysql");
    }

    #[test]
    fn manifest_public_key_is_pinned_in_the_application() {
        let mut manifest = load_manifest().expect("repository manifest should verify");
        manifest.public_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_string();

        let error = verify_manifest(&manifest).expect_err("untrusted key should be rejected");
        assert!(matches!(error, SqlCommandError::DriverPackage { .. }));
    }

    #[test]
    fn list_reports_packages_as_not_installed_without_cache() {
        let root = temporary_root();
        let packages = list_driver_packages(&root).expect("manifest should be listable");

        assert_eq!(packages.len(), 2);
        assert!(packages.iter().all(|package| !package.installed));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_reports_only_a_matching_verified_cache_as_installed() {
        let root = temporary_root();
        let manifest = load_manifest().expect("repository manifest should verify");
        let package = &manifest.payload.packages[0];
        let target = package_path(&root, package).expect("package path should be safe");
        fs::create_dir_all(target.parent().expect("package parent"))
            .expect("create package parent");
        fs::write(&target, b"not the signed package").expect("write invalid package");

        let packages = list_driver_packages(&root).expect("manifest should be listable");
        assert!(!packages[0].installed);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_package_id_is_rejected_before_download() {
        let error =
            download_driver(&temporary_root(), "not-a-package").expect_err("unknown package");
        assert!(matches!(error, SqlCommandError::InvalidInput { .. }));
    }

    #[test]
    fn package_validation_rejects_untrusted_sources_and_traversal() {
        let mut package = load_manifest()
            .expect("repository manifest should verify")
            .payload
            .packages[0]
            .clone();
        package.url = "http://evil.example/driver.jar".to_string();
        assert!(validate_package(&package).is_err());

        package.url = "https://repo.maven.apache.org/maven2/../driver.jar".to_string();
        assert!(validate_package(&package).is_err());

        package.url = "https://repo.maven.apache.org/maven2/mysql.jar".to_string();
        package.file_name = "../mysql.jar".to_string();
        assert!(validate_package(&package).is_err());
    }

    #[test]
    fn download_url_validation_rejects_redirected_hosts() {
        let manifest = load_manifest().expect("repository manifest should verify");
        let package = &manifest.payload.packages[0];
        let trusted = Url::parse(&package.url).expect("manifest URL should parse");
        let redirected = Url::parse("https://evil.example/mysql-connector-j-9.3.0.jar")
            .expect("redirect URL should parse");

        assert!(validate_download_url(&trusted, &package.file_name).is_ok());
        assert!(validate_download_url(&redirected, &package.file_name).is_err());
    }

    #[test]
    fn temporary_package_file_is_exclusive() {
        let root = temporary_root();
        fs::create_dir_all(&root).expect("create temporary root");
        let path = root.join("driver.jar.part");
        let _file = create_temporary_package_file(&path).expect("create first temporary file");

        let error = create_temporary_package_file(&path).expect_err("existing partial file");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn install_failure_preserves_existing_cached_package() {
        let root = temporary_root();
        fs::create_dir_all(&root).expect("create temporary root");
        let target = root.join("driver.jar");
        let missing_temporary = root.join("missing.part");
        fs::write(&target, b"existing package").expect("write existing package");

        install_verified_package(&missing_temporary, &target)
            .expect_err("missing package must fail");

        assert_eq!(
            fs::read(&target).expect("existing package should remain readable"),
            b"existing package"
        );
        let _ = fs::remove_dir_all(root);
    }
}
