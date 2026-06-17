# Phase 1：产品化收口 / 去 SideX 品牌

基于当前 `baicie/sql-studio-next@mvp`，Phase 1 的核心不是做 SQL 功能，而是把当前 SideX fork 固化成 **SQL Studio Next** 产品底座。当前代码里仍有明显 SideX 暴露点：`package.json` 仍是 `sidex@0.1.3`，Tauri 配置还是 `productName: SideX`、`identifier: com.siden.sidex`，并且 updater endpoint 指向 `cdn.siden.ai`。

Rust 侧也还有几个需要处理的点：macOS 菜单仍叫 `SideX / About SideX`，本地状态库仍叫 `sidex_storage.db / sidex_state.db`，updater 事件和 user-agent 仍使用 sidex 命名。

---

## 1. Phase 1 目标

```txt
Phase 1 =
  1. 应用展示名改为 SQL Studio / SQL Studio Next
  2. Tauri bundle identifier 改为 com.baicie.sqlstudio
  3. 去掉 upstream Siden updater endpoint
  4. macOS 菜单改成 SQL Studio
  5. 本地 app data DB 文件名改成 sql_studio_*
  6. README 改成 SQL Studio Next 项目说明
  7. 增加品牌回归测试，防止以后又退回 SideX
```

不做：

```txt
1. 不做 SQL command bridge
2. 不做 SQL Editor
3. 不做 SQL Connections View
4. 不删除 Debug / Git / Extension / Terminal 等上游能力
5. 不大规模重命名 crates/sidex-* 内部模块
```

内部 crate 仍可暂时保留 `sidex-*`，因为这些属于上游工程资产，不是用户可见品牌。后面可以单独做 Phase 1.5 或 Phase 8 再清理。

---

## 2. 文件变更清单

```txt
修改：
- package.json
- src-tauri/tauri.conf.json
- src-tauri/Cargo.toml
- README.md
- src-tauri/src/lib.rs
- src-tauri/src/commands/updater.rs

新增：
- src-tauri/src/product.rs
- scripts/verify-branding.mjs

可选小改：
- Cargo.toml workspace metadata
```

---

# 3. 完整代码

## 3.1 `package.json`

完整替换：

```json
{
	"name": "sql-studio-next",
	"version": "0.1.0",
	"type": "module",
	"private": true,
	"packageManager": "pnpm@10.33.4",
	"description": "SQL Studio Next - a VS Code-like SQL workbench built on Tauri.",
	"scripts": {
		"setup": "node scripts/generate-extension-meta.js",
		"setup:full": "bash scripts/setup-extensions.sh && node scripts/generate-extension-meta.js",
		"dev": "pnpm run setup && node --max-old-space-size=8192 node_modules/vite/bin/vite.js",
		"build": "pnpm run setup && node --max-old-space-size=12288 node_modules/vite/bin/vite.js build",
		"postbuild": "node scripts/postbuild.js",
		"preview": "vite preview",
		"tauri": "cross-env tauri",
		"lint": "eslint 'src/**/*.ts'",
		"lint:fix": "eslint --fix 'src/**/*.ts'",
		"format": "prettier --write 'src/**/*.{ts,tsx,js,json}'",
		"format:check": "prettier --check 'src/**/*.{ts,tsx,js,json}'",
		"rust:check": "cd src-tauri && cargo check",
		"rust:clippy": "cd src-tauri && cargo clippy --all-targets -- -D warnings",
		"rust:fmt": "cd src-tauri && cargo fmt --all -- --check",
		"rust:fmt:fix": "cd src-tauri && cargo fmt --all",
		"test:branding": "node scripts/verify-branding.mjs",
		"test:rust": "cd src-tauri && cargo test product --lib",
		"test": "pnpm run test:branding && pnpm run test:rust"
	},
	"dependencies": {
		"@microsoft/1ds-core-js": "^4.4.1",
		"@microsoft/1ds-post-js": "^4.4.1",
		"@tauri-apps/api": "^2",
		"@tauri-apps/plugin-shell": "^2",
		"@vscode/codicons": "^0.0.45",
		"@vscode/iconv-lite-umd": "^0.7.1",
		"@vscode/tree-sitter-wasm": "^0.3.1",
		"@xterm/addon-canvas": "^0.7.0",
		"@xterm/addon-clipboard": "^0.2.0",
		"@xterm/addon-fit": "^0.11.0",
		"@xterm/addon-image": "^0.9.0",
		"@xterm/addon-ligatures": "^0.10.0",
		"@xterm/addon-progress": "^0.2.0",
		"@xterm/addon-search": "^0.16.0",
		"@xterm/addon-serialize": "^0.14.0",
		"@xterm/addon-unicode11": "^0.9.0",
		"@xterm/addon-webgl": "^0.19.0",
		"@xterm/xterm": "^6.0.0",
		"monaco-editor": "^0.55.1",
		"tas-client": "^0.4.1",
		"vscode-oniguruma": "^2.0.1",
		"vscode-textmate": "^9.3.2"
	},
	"devDependencies": {
		"@tauri-apps/cli": "^2.11.2",
		"@tauri-apps/plugin-dialog": "^2.7.1",
		"@types/katex": "^0.16.8",
		"@types/trusted-types": "^2.0.7",
		"@typescript-eslint/eslint-plugin": "^8.61.1",
		"@typescript-eslint/parser": "^8.61.1",
		"@webgpu/types": "^0.1.70",
		"@xterm/headless": "^6.0.0",
		"cross-env": "^10.1.0",
		"eslint": "^10.5.0",
		"jschardet": "^3.1.4",
		"prettier": "^3.8.4",
		"typescript": "~6.0.3",
		"typescript-eslint": "^8.61.1",
		"vite": "^8.0.16",
		"vite-plugin-static-copy": "^4.1.1"
	}
}
```

---

## 3.2 `src-tauri/tauri.conf.json`

完整替换：

```json
{
	"$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
	"productName": "SQL Studio Next",
	"version": "0.1.0",
	"identifier": "com.baicie.sqlstudio",
	"build": {
		"frontendDist": "../dist",
		"devUrl": "http://localhost:1420",
		"beforeDevCommand": "pnpm run dev",
		"beforeBuildCommand": "pnpm run build"
	},
	"app": {
		"windows": [
			{
				"title": "SQL Studio",
				"width": 1280,
				"height": 800,
				"minWidth": 800,
				"minHeight": 600,
				"resizable": true,
				"fullscreen": false,
				"decorations": false,
				"shadow": true,
				"visible": false,
				"dragDropEnabled": false,
				"useHttpsScheme": true,
				"titleBarStyle": "Overlay",
				"hiddenTitle": true
			}
		],
		"security": {
			"csp": null,
			"assetProtocol": {
				"enable": true,
				"scope": ["$HOME/**", "/tmp/**"]
			}
		}
	},
	"plugins": {},
	"bundle": {
		"active": true,
		"targets": "all",
		"copyright": "Copyright © 2026 baicie. All rights reserved.",
		"category": "DeveloperTool",
		"shortDescription": "A VS Code-like SQL workbench.",
		"longDescription": "SQL Studio Next is a fast, local-first SQL workbench built on a Tauri-based VS Code-style workbench.",
		"resources": ["extension-host/*", "shell-integration/*"],
		"icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
		"macOS": {
			"entitlements": "entitlements.plist",
			"minimumSystemVersion": "10.15"
		},
		"windows": {
			"webviewInstallMode": {
				"type": "downloadBootstrapper"
			}
		},
		"linux": {
			"deb": {
				"depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"]
			},
			"rpm": {
				"depends": ["webkit2gtk4.1", "gtk3"]
			}
		}
	}
}
```

关键点：

```txt
1. 删除 upstream updater endpoint。
2. 删除 upstream macOS signingIdentity。
3. beforeDevCommand / beforeBuildCommand 改成 pnpm。
4. app title 改成 SQL Studio。
```

---

## 3.3 `src-tauri/Cargo.toml`

完整替换：

```toml
[package]
name = "sql-studio-next"
version = "0.1.0"
description = "SQL Studio Next - A VS Code-like SQL workbench built on Tauri"
authors = ["baicie"]
license = "MIT"
repository = "https://github.com/baicie/sql-studio-next"
edition = "2021"
rust-version = "1.91.0"

[[bin]]
name = "sql-studio-next"
path = "src/main.rs"

[lib]
name = "sidex_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2.5.6", features = [] }

[dependencies]
tauri = { version = "2.11", features = [
  "protocol-asset",
  "tray-icon",
  "devtools",
] }
tauri-plugin-log = "2"
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"

serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
log = "0.4"
notify = { version = "7", features = ["macos_fsevent"] }
portable-pty = "0.8"
walkdir = "2"
rusqlite = { version = "0.31", features = ["bundled"] }
tokio = { version = "1", features = ["full"] }
hostname = "0.4"
dirs = "5"
reqwest = { version = "0.12", features = [
  "rustls-tls",
  "blocking",
  "gzip",
  "deflate",
  "brotli",
] }

# Compression & encoding
flate2 = "1"
zip = "2"
base64 = "0.22"

# Crypto
sha2 = "0.10"
md5 = "0.7"
uuid = { version = "1", features = ["v4"] }
rand = "0.8"
chrono = "0.4"

# Path utilities
pathdiff = "0.2"
glob = "0.3"
globset = "0.4"

# Search indexing
dashmap = "6"
rayon = "1.10"
regex = "1"
memchr = "2"

# Process & terminal management
crossbeam = "0.8"
which = "6"

# Extension API helpers
arboard = "3"
open = "5"
url = "2"

# WASM extension runtime
wasmtime = { version = "43", default-features = false, features = [
  "runtime",
  "component-model",
  "cranelift",
  "async",
] }
wasmtime-wasi = "43"
toml = "0.8"
anyhow = "1"
sidex-db = { path = "../crates/sidex-db" }
sidex-dap = { path = "../crates/sidex-dap" }
sidex-remote = { path = "../crates/sidex-remote" }
sidex-settings = { path = "../crates/sidex-settings" }
sidex-theme = { path = "../crates/sidex-theme" }

# SideX upstream crates retained as internal implementation assets.
sidex-git = { path = "../crates/sidex-git" }
sidex-workspace = { path = "../crates/sidex-workspace" }

# Internal crates
sidex-text = { path = "../crates/sidex-text" }
sidex-syntax = { path = "../crates/sidex-syntax" }
sidex-tasks = { path = "../crates/sidex-tasks" }
sidex-extensions = { path = "../crates/sidex-extensions" }
sidex-terminal = { path = "../crates/sidex-terminal" }
sidex-lsp = { path = "../crates/sidex-lsp" }
sidex-keymap = { path = "../crates/sidex-keymap" }
sidex-extension-api = { path = "../crates/sidex-extension-api" }
sidex-update = { path = "../crates/sidex-update" }
sidex-profiles = { path = "../crates/sidex-profiles" }
sidex-auth = { path = "../crates/sidex-auth" }
sidex-textmate = { path = "../crates/sidex-textmate" }

tree-sitter = "0.24"
tree-sitter-rust = "0.23"
urlencoding = "2.1.3"

[target.'cfg(windows)'.dependencies]
dunce = "1"

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[lints.rust]
unsafe_code = "deny"

[lints.clippy]
correctness = { level = "deny", priority = -1 }
complexity = { level = "warn", priority = -1 }
perf = { level = "warn", priority = -1 }
style = { level = "warn", priority = -1 }
suspicious = { level = "warn", priority = -1 }
pedantic = { level = "warn", priority = -1 }
must_use_candidate = "allow"
missing_errors_doc = "allow"
missing_panics_doc = "allow"
module_name_repetitions = "allow"
dbg_macro = "warn"
todo = "warn"
unimplemented = "warn"

[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
strip = true
panic = "abort"
```

这里故意保留：

```toml
[lib]
name = "sidex_lib"
```

原因是 `src-tauri/src/main.rs` 当前调用的是：

```rust
sidex_lib::run();
```

为了 Phase 1 不扩大改动面，先不改 lib crate 名。等 SQL MVP 闭环稳定后，再单独做内部 crate 命名清理。

---

## 3.4 `src-tauri/src/product.rs`

新增完整文件：

```rust
//! Product constants for SQL Studio Next.
 //!
//! Keep user-visible branding in one place so future refactors do not
//! accidentally regress back to upstream SideX names.

pub(crate) const PRODUCT_NAME: &str = "SQL Studio Next";
pub(crate) const APP_TITLE: &str = "SQL Studio";
pub(crate) const APP_IDENTIFIER: &str = "com.baicie.sqlstudio";

pub(crate) const APP_MENU_ID: &str = "sql_studio_menu";
pub(crate) const APP_MENU_LABEL: &str = "SQL Studio";
pub(crate) const ABOUT_MENU_LABEL: &str = "About SQL Studio";

pub(crate) const STORAGE_DB_FILE_NAME: &str = "sql_studio_storage.db";
pub(crate) const STATE_DB_FILE_NAME: &str = "sql_studio_state.db";

pub(crate) const NATIVE_MENU_EVENT: &str = "sql-studio-native-menu";

/// Transitional compatibility event for existing frontend listeners.
///
/// This is intentionally not user-visible. Remove this once all frontend
/// listeners have migrated to [`NATIVE_MENU_EVENT`].
pub(crate) const LEGACY_NATIVE_MENU_EVENT: &str = "sidex-native-menu";

pub(crate) const UPDATE_STATE_EVENT: &str = "sql-studio://update/state-change";
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
```

---

## 3.5 `src-tauri/src/lib.rs`

不要整文件大改，只做下面这些精确替换。

### 3.5.1 文件顶部新增 product 模块

把：

```rust
mod commands;
```

替换为：

```rust
mod commands;
pub(crate) mod product;
```

---

### 3.5.2 完整替换 `build_menu` 函数

用下面完整函数替换当前 `#[cfg(target_os = "macos")] fn build_menu(...)`：

```rust
#[cfg(target_os = "macos")]
#[allow(clippy::too_many_lines)]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let file_menu = SubmenuBuilder::with_id(app, "file_menu", "File")
        .item(
            &MenuItemBuilder::with_id("new_file", "New SQL Query")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("new_window", "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("open_file", "Open Database File...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("open_folder", "Open Workspace Folder...").build(app)?)
        .item(&MenuItemBuilder::with_id("open_recent", "Open Recent").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_as", "Save As...")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_all", "Save All")
                .accelerator("CmdOrCtrl+Alt+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close_editor", "Close Editor")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("close_window", "Close Window")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(app)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::with_id(app, "edit_menu", "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", "Find")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("replace", "Replace")
                .accelerator("CmdOrCtrl+H")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("find_in_files", "Find in Files")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("replace_in_files", "Replace in Files")
                .accelerator("CmdOrCtrl+Shift+H")
                .build(app)?,
        )
        .build()?;

    let selection_menu = SubmenuBuilder::with_id(app, "selection_menu", "Selection")
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .item(
            &MenuItemBuilder::with_id("expand_selection", "Expand Selection")
                .accelerator("CmdOrCtrl+Shift+Right")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("shrink_selection", "Shrink Selection")
                .accelerator("CmdOrCtrl+Shift+Left")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("copy_line_up", "Copy Line Up")
                .accelerator("Alt+Shift+Up")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("copy_line_down", "Copy Line Down")
                .accelerator("Alt+Shift+Down")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("move_line_up", "Move Line Up")
                .accelerator("Alt+Up")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("move_line_down", "Move Line Down")
                .accelerator("Alt+Down")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("add_cursor_above", "Add Cursor Above")
                .accelerator("CmdOrCtrl+Alt+Up")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("add_cursor_below", "Add Cursor Below")
                .accelerator("CmdOrCtrl+Alt+Down")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("select_all_occurrences", "Select All Occurrences")
                .accelerator("CmdOrCtrl+Shift+L")
                .build(app)?,
        )
        .build()?;

    let view_menu = SubmenuBuilder::with_id(app, "view_menu", "View")
        .item(
            &MenuItemBuilder::with_id("command_palette", "Command Palette...")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("open_view", "Open View...").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("explorer", "Explorer")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("search", "Search")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("source_control", "Source Control")
                .accelerator("CmdOrCtrl+Shift+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("extensions", "Extensions")
                .accelerator("CmdOrCtrl+Shift+X")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("problems", "Problems")
                .accelerator("CmdOrCtrl+Shift+M")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("output", "Output")
                .accelerator("CmdOrCtrl+Shift+U")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("terminal", "Terminal")
                .accelerator("CmdOrCtrl+`")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle_fullscreen", "Toggle Full Screen")
                .accelerator("F11")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("reset_zoom", "Reset Zoom")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .build()?;

    let go_menu = SubmenuBuilder::with_id(app, "go_menu", "Go")
        .item(
            &MenuItemBuilder::with_id("back", "Back")
                .accelerator("CmdOrCtrl+Alt+Left")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("forward", "Forward")
                .accelerator("CmdOrCtrl+Alt+Right")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("go_to_file", "Go to File...")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("go_to_line", "Go to Line/Column...")
                .accelerator("CmdOrCtrl+G")
                .build(app)?,
        )
        .build()?;

    let terminal_menu = SubmenuBuilder::with_id(app, "terminal_menu", "Terminal")
        .item(
            &MenuItemBuilder::with_id("new_terminal", "New Terminal")
                .accelerator("CmdOrCtrl+Shift+`")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("split_terminal", "Split Terminal").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("run_task", "Run Task...").build(app)?)
        .item(
            &MenuItemBuilder::with_id("run_build_task", "Run Build Task...")
                .accelerator("CmdOrCtrl+Shift+B")
                .build(app)?,
        )
        .build()?;

    let window_menu = SubmenuBuilder::with_id(app, "window_menu", "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;

    let help_menu = SubmenuBuilder::with_id(app, "help_menu", "Help")
        .item(&MenuItemBuilder::with_id("welcome", "Welcome").build(app)?)
        .item(&MenuItemBuilder::with_id("documentation", "Documentation").build(app)?)
        .item(&MenuItemBuilder::with_id("release_notes", "Release Notes").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("keyboard_shortcuts", "Keyboard Shortcuts Reference")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("report_issue", "Report Issue").build(app)?)
        .separator()
        .build()?;

    let app_menu =
        SubmenuBuilder::with_id(app, product::APP_MENU_ID, product::APP_MENU_LABEL)
            .item(&PredefinedMenuItem::about(
                app,
                Some(product::ABOUT_MENU_LABEL),
                None,
            )?)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;

    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &selection_menu,
            &view_menu,
            &go_menu,
            &terminal_menu,
            &window_menu,
            &help_menu,
        ],
    )?;

    Ok(menu)
}
```

这里刻意先移除了 macOS 顶层 `Run` 菜单，因为 Phase 1 的产品是 SQL Workbench，不应该默认强调 Debug。Debug contribution 代码仍保留，后续再统一隐藏/删除。

---

### 3.5.3 替换本地 DB 文件名

把：

```rust
let db_path = app_data.join("sidex_storage.db");
```

替换为：

```rust
let db_path = app_data.join(product::STORAGE_DB_FILE_NAME);
```

把：

```rust
let sidex_db_path = app_data.join("sidex_state.db");
let sidex_db = sidex_db::Database::open(&sidex_db_path)
    .expect("failed to initialize sidex-db state database");
app.manage(Arc::new(SidexDbState::new(sidex_db)));
```

替换为：

```rust
let state_db_path = app_data.join(product::STATE_DB_FILE_NAME);
let state_db = sidex_db::Database::open(&state_db_path)
    .expect("failed to initialize SQL Studio state database");
app.manage(Arc::new(SidexDbState::new(state_db)));
```

---

### 3.5.4 替换菜单事件派发

把当前：

```rust
.on_menu_event(|app, event| {
    let id = event.id().0.as_str();
    if let Some(window) = app.get_webview_window("main") {
        let escaped = id.replace('\\', "\\\\").replace('\'', "\\'");
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('sidex-native-menu', {{ detail: '{escaped}' }}))"
        ));
    }
})
```

替换为：

```rust
.on_menu_event(|app, event| {
    let id = event.id().0.as_str();

    if let Some(window) = app.get_webview_window("main") {
        let escaped = id.replace('\\', "\\\\").replace('\'', "\\'");

        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('{}', {{ detail: '{escaped}' }}));\
             window.dispatchEvent(new CustomEvent('{}', {{ detail: '{escaped}' }}));",
            product::NATIVE_MENU_EVENT,
            product::LEGACY_NATIVE_MENU_EVENT
        ));
    }
})
```

这里同时派发新旧事件，原因是当前前端可能仍有旧监听。新事件作为正式事件，旧事件只是兼容层，后续 Phase 1.5 可以删除。

---

## 3.6 `src-tauri/src/commands/updater.rs`

完整替换：

```rust
//! Tauri command bindings for the native update manager.
//!
//! The TypeScript update service invokes these commands and listens to the
//! product-scoped update state event.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use sidex_update::{State, UpdateConfig, UpdateManager, UpdateObserver, UpdateResult, UpdateType};
use tauri::{AppHandle, Emitter, Manager};

use crate::product;

/// Tauri event name carrying the latest [`State`] payload.
pub const STATE_EVENT: &str = product::UPDATE_STATE_EVENT;

/// App-state wrapper so Tauri can hold a single [`UpdateManager`] instance.
pub struct UpdateManagerState {
    manager: OnceLock<UpdateManager>,
}

impl Default for UpdateManagerState {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateManagerState {
    pub const fn new() -> Self {
        Self {
            manager: OnceLock::new(),
        }
    }

    pub fn set(&self, manager: UpdateManager) {
        let _ = self.manager.set(manager);
    }

    pub fn get(&self) -> Option<&UpdateManager> {
        self.manager.get()
    }
}

struct EventEmitter {
    app: AppHandle,
}

impl UpdateObserver for EventEmitter {
    fn on_state_change(&self, state: &State) {
        if let Err(err) = self.app.emit(STATE_EVENT, state) {
            log::warn!("failed to emit update state event: {err}");
        }
    }
}

/// Initializes the [`UpdateManager`] during Tauri setup.
///
/// Pulls feed endpoints and the Minisign public key from the bundled
/// `tauri.conf.json`. SQL Studio Next currently ships without an updater
/// endpoint, so this can safely initialize into a disabled/no-endpoint state.
pub fn initialize(app: &AppHandle) -> UpdateResult<()> {
    let config = read_config(app);
    let manager = UpdateManager::new(config)?;
    manager.set_observer(Arc::new(EventEmitter { app: app.clone() }));

    app.state::<UpdateManagerState>().set(manager);
    Ok(())
}

fn read_config(app: &AppHandle) -> UpdateConfig {
    let raw_pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let endpoints = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("endpoints"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    UpdateConfig {
        endpoints,
        pubkey: raw_pubkey,
        current_version: app.package_info().version.to_string(),
        cache_dir: cache_dir(app),
        update_type: default_update_type(),
        user_agent: product::update_user_agent(
            &app.package_info().version.to_string(),
            std::env::consts::OS,
        ),
    }
}

fn cache_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("updates")
}

const fn default_update_type() -> UpdateType {
    if cfg!(target_os = "windows") {
        UpdateType::Setup
    } else {
        UpdateType::Archive
    }
}

fn require_manager(state: &UpdateManagerState) -> Result<&UpdateManager, String> {
    state
        .get()
        .ok_or_else(|| "update manager not initialized".to_string())
}

#[tauri::command]
pub async fn update_check(
    state: tauri::State<'_, UpdateManagerState>,
    explicit: bool,
) -> Result<State, String> {
    let manager = require_manager(&state)?.clone();

    manager
        .check_for_updates(explicit)
        .await
        .map_err(|e| e.to_string())?;

    Ok(manager.state())
}

#[tauri::command]
pub async fn update_download(
    state: tauri::State<'_, UpdateManagerState>,
    explicit: bool,
) -> Result<State, String> {
    let manager = require_manager(&state)?.clone();

    manager
        .download_update(explicit)
        .await
        .map_err(|e| e.to_string())?;

    Ok(manager.state())
}

#[tauri::command]
pub async fn update_apply(state: tauri::State<'_, UpdateManagerState>) -> Result<State, String> {
    let manager = require_manager(&state)?.clone();

    manager.apply_update().await.map_err(|e| e.to_string())?;

    Ok(manager.state())
}

#[tauri::command]
pub async fn update_cancel(state: tauri::State<'_, UpdateManagerState>) -> Result<(), String> {
    require_manager(&state)?.cancel();

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn update_state(state: tauri::State<'_, UpdateManagerState>) -> Result<State, String> {
    Ok(require_manager(&state)?.state())
}

#[tauri::command]
pub async fn update_cleanup(state: tauri::State<'_, UpdateManagerState>) -> Result<(), String> {
    let manager = require_manager(&state)?.clone();

    manager.cleanup_cache().await.map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn update_quit_and_install(app: AppHandle) -> Result<(), String> {
    let install_root = std::env::current_exe().map_err(|e| e.to_string())?;

    sidex_update::install::relaunch(&install_root).map_err(|e| e.to_string())?;

    app.exit(0);

    Ok(())
}
```

---

## 3.7 `scripts/verify-branding.mjs`

新增完整文件：

```js
import { readFile } from 'node:fs/promises';

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function assertStringDoesNotContain(value, forbidden, message) {
	assert(!String(value).toLowerCase().includes(forbidden.toLowerCase()), message);
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

const packageJson = await readJson('package.json');
const tauriConfig = await readJson('src-tauri/tauri.conf.json');
const srcTauriCargo = await readFile('src-tauri/Cargo.toml', 'utf8');

assert(packageJson.name === 'sql-studio-next', `package.json name must be sql-studio-next, got ${packageJson.name}`);

assert(packageJson.version === '0.1.0', `package.json version must be 0.1.0, got ${packageJson.version}`);

assert(packageJson.packageManager?.startsWith('pnpm@'), 'packageManager must use pnpm');

assert(
	tauriConfig.productName === 'SQL Studio Next',
	`tauri productName must be SQL Studio Next, got ${tauriConfig.productName}`
);

assert(
	tauriConfig.identifier === 'com.baicie.sqlstudio',
	`tauri identifier must be com.baicie.sqlstudio, got ${tauriConfig.identifier}`
);

assert(
	tauriConfig.app?.windows?.[0]?.title === 'SQL Studio',
	`main window title must be SQL Studio, got ${tauriConfig.app?.windows?.[0]?.title}`
);

const updaterEndpoints = tauriConfig.plugins?.updater?.endpoints ?? [];

assert(
	updaterEndpoints.length === 0,
	`updater endpoints must be empty in Phase 1, got ${JSON.stringify(updaterEndpoints)}`
);

for (const endpoint of updaterEndpoints) {
	assertStringDoesNotContain(
		endpoint,
		'siden.ai',
		`updater endpoint must not point to upstream Siden infrastructure: ${endpoint}`
	);
}

const tauriConfigText = JSON.stringify(tauriConfig, null, 2);

assertStringDoesNotContain(tauriConfigText, 'SideX', 'tauri.conf.json must not expose SideX branding');

assertStringDoesNotContain(
	tauriConfigText,
	'Siden Technologies',
	'tauri.conf.json must not expose upstream Siden company branding'
);

assertStringDoesNotContain(tauriConfigText, 'cdn.siden.ai', 'tauri.conf.json must not use upstream updater endpoint');

const cargoPackageSection = srcTauriCargo.split('[dependencies]')[0];

assert(
	cargoPackageSection.includes('name = "sql-studio-next"'),
	'src-tauri/Cargo.toml package name must be sql-studio-next'
);

assert(cargoPackageSection.includes('version = "0.1.0"'), 'src-tauri/Cargo.toml package version must be 0.1.0');

assert(
	cargoPackageSection.includes('repository = "https://github.com/baicie/sql-studio-next"'),
	'src-tauri/Cargo.toml repository must point to baicie/sql-studio-next'
);

assert(
	srcTauriCargo.includes('name = "sql-studio-next"'),
	'src-tauri/Cargo.toml bin name must include sql-studio-next'
);

console.log('Branding verification passed.');
```

---

## 3.8 `README.md`

完整替换：

````md
# SQL Studio Next

SQL Studio Next is a VS Code-like SQL workbench built on a Tauri-based workbench shell.

The project is a product hard fork of SideX. The goal is not to build a generic code editor. The goal is to build a local-first database workbench with:

- SQL connections
- SQL editor
- query result panel
- database metadata explorer
- future SQL extension system
- future AI-assisted diagnosis and query workflow

## Current Status

This repository is currently in the fork stabilization phase.

The immediate MVP target is:

```txt
Launch app
  -> show SQL Studio branded workbench
  -> add/open SQLite connection
  -> list database tables
  -> open SQL editor
  -> execute SELECT query
  -> show result in panel
```
````

## Roadmap

### Phase 1 — Product Branding

- Rename app metadata to SQL Studio Next
- Replace Tauri product name and bundle identifier
- Remove upstream updater endpoint
- Replace visible SideX menu labels
- Replace local app data database filenames
- Add branding regression tests

### Phase 2 — SQL Rust Commands

- Add SQLite connection command bridge
- Add query execution command
- Add table and column metadata commands
- Add structured SQL error model

### Phase 3 — SQL Workbench Services

- Add `ISqlConnectionService`
- Add `ISqlMetadataService`
- Add `ISqlQueryService`
- Route all SQL frontend operations through services

### Phase 4 — SQL Connections View

- Add SQL activity bar entry
- Add connection tree
- Add SQLite connection flow
- Add table metadata expansion

### Phase 5 — SQL Editor

- Add SQL editor input
- Add SQL editor pane
- Add execute query command
- Add Cmd/Ctrl + Enter shortcut

### Phase 6 — Query Result Panel

- Add result panel
- Add simple result grid
- Add messages and error display
- Add elapsed time and row count

## Development

Install dependencies:

```bash
pnpm install
```

Run the app in development:

```bash
pnpm tauri dev
```

Build frontend:

```bash
pnpm run build
```

Build desktop app:

```bash
pnpm tauri build
```

Run checks:

```bash
pnpm run lint
pnpm run build
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
pnpm run test
```

## Project Layout

```txt
sql-studio-next/
├── src/
│   └── vs/
│       ├── base/
│       ├── platform/
│       ├── editor/
│       └── workbench/
├── src-tauri/
│   └── src/
│       ├── commands/
│       ├── product.rs
│       ├── lib.rs
│       └── main.rs
├── crates/
├── scripts/
├── index.html
├── vite.config.ts
└── package.json
```

## Architecture Direction

SQL-specific frontend code should live under:

```txt
src/vs/workbench/contrib/sql*
src/vs/workbench/services/sql*
```

SQL-specific Rust code should live under:

```txt
src-tauri/src/commands/sql/
```

Do not build SQL Studio as a React Router-style SPA. This project should keep the VS Code-style Workbench model:

```txt
Activity Bar
Side Bar
Editor Area
Panel
Status Bar
Commands
Services
Contributions
```

## Upstream Attribution

SQL Studio Next is based on SideX, which is a Tauri port of Code - OSS / VS Code workbench concepts.

The upstream project and Code - OSS are MIT licensed. See `LICENSE` for details.

````

---

# 4. 可选：根目录 `Cargo.toml` workspace metadata

如果你希望 workspace metadata 也去上游仓库地址，把根目录 `Cargo.toml` 里的：

```toml
[workspace.package]
version = "0.2.0"
edition = "2021"
rust-version = "1.91.0"
license = "MIT"
repository = "https://github.com/sidenai/sidex"
````

替换为：

```toml
[workspace.package]
version = "0.1.0"
edition = "2021"
rust-version = "1.91.0"
license = "MIT"
repository = "https://github.com/baicie/sql-studio-next"
```

不要在 Phase 1 重命名 workspace members 里的 `crates/sidex-*`，否则改动会爆炸。

---

# 5. 单元测试设计

Phase 1 没有 SQL 业务逻辑，所以单测重点是 **品牌常量防回归**。

## Rust 单测覆盖

文件：

```txt
src-tauri/src/product.rs
```

覆盖：

```txt
1. PRODUCT_NAME / APP_TITLE / APP_IDENTIFIER 不含 sidex / siden
2. DB 文件名为 sql_studio_storage.db / sql_studio_state.db
3. native menu event 使用 sql-studio 命名空间
4. updater user-agent 使用 sql-studio-next
5. 旧 native menu event 只作为兼容常量存在
```

运行：

```bash
cd src-tauri
cargo test product --lib
```

## Branding 静态测试覆盖

文件：

```txt
scripts/verify-branding.mjs
```

覆盖：

```txt
1. package.json name/version 正确
2. tauri productName/identifier/window title 正确
3. updater endpoint 为空
4. tauri.conf.json 不含 SideX/Siden/cdn.siden.ai
5. src-tauri/Cargo.toml package metadata 正确
```

运行：

```bash
pnpm run test:branding
```

总测试：

```bash
pnpm run test
```

---

# 6. 验证命令

完成 Phase 1 后建议执行：

```bash
pnpm install
pnpm run test
pnpm run rust:fmt
pnpm run rust:check
pnpm run rust:clippy
pnpm run lint
pnpm run build
pnpm tauri dev
```

如果 `Cargo.lock` 因为 `src-tauri/Cargo.toml` package name/version 变化发生变更，这是正常的，应一并提交。

---

# 7. 推荐提交信息

```txt
chore: brand fork as SQL Studio Next
```

或者拆成两个 commit：

```txt
chore: replace product branding with SQL Studio Next
test: add branding regression checks
```

---

# 8. Phase 1 验收标准

```txt
1. package.json 不再是 sidex。
2. Tauri app productName 是 SQL Studio Next。
3. Bundle identifier 是 com.baicie.sqlstudio。
4. Window title 是 SQL Studio。
5. tauri.conf.json 不再包含 cdn.siden.ai。
6. macOS 顶部菜单显示 SQL Studio / About SQL Studio。
7. 新 app data DB 文件名为 sql_studio_storage.db / sql_studio_state.db。
8. pnpm run test 通过。
9. pnpm run build 通过。
10. pnpm run rust:check 通过。
```

这个 Phase 做完后，再进入 Phase 2：`src-tauri/src/commands/sql`，开始打 SQLite 查询闭环。
