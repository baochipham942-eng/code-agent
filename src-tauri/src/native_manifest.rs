//! ADR-086：原生依赖位置由构建期清单 `dist/native/manifest.json` 声明（唯一 writer
//! 是 scripts/gen-native-dep-manifest.mjs），运行期不再按 platform-arch 拼路径。
//! 本模块是 Rust 壳首启预检（main.rs `desktop_shell_resource_preflight`）的读取方；
//! TS 侧镜像在 src/host/diagnostics/desktopShellDiagnostics.ts
//! （checkManifestNativeResource）与 src/host/runtime/nativeDepManifest.ts，
//! 失败文案保持同构。平台比对不在读取方（发版门持有，ADR-086 §4.6）。

use std::fmt;
use std::path::{Path, PathBuf};

use crate::path_to_string;
use crate::{
    resource_check, DesktopShellResourceCheck, DesktopShellResourceKind, DesktopShellResourceStatus,
};

/// 清单在资源根下的固定位置（ADR-086 §4.1）。
pub const MANIFEST_RELATIVE_PATH: &str = "dist/native/manifest.json";

const MANIFEST_KIND: &str = "agent_neo_native_dep_manifest";
const MANIFEST_SCHEMA_VERSION: i64 = 1;

/// 清单读取/校验失败的三种形态。Display 文案会进首启失败弹窗（release Layer 3）
/// 与桌面诊断，必须点名清单完整路径，且三种形态互可区分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeManifestError {
    /// 清单缺席或读不出来（IO 错误 / 非 UTF-8 / JSON 解析失败）。
    Unreadable { manifest: PathBuf, cause: String },
    /// 清单在，但不是本仓的 agent_neo_native_dep_manifest（kind / schemaVersion /
    /// modules 形状不对，或目标模块没有非空 `native` 字符串）。
    Invalid { manifest: PathBuf, detail: String },
    /// 清单声明了 modules[id].native，但该文件不在盘上（装配不一致的包）。
    DeclaredNativeMissing { manifest: PathBuf, native: PathBuf },
}

impl NativeManifestError {
    /// 预检条目失败时展示的 path：前两类指向清单本身，第三类指向被声明的 native
    /// 文件（与 TS 镜像 checkManifestNativeResource 的 path 取值一致）。
    pub fn report_path(&self) -> &Path {
        match self {
            NativeManifestError::Unreadable { manifest, .. }
            | NativeManifestError::Invalid { manifest, .. } => manifest,
            NativeManifestError::DeclaredNativeMissing { native, .. } => native,
        }
    }
}

impl fmt::Display for NativeManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NativeManifestError::Unreadable { manifest, cause } => write!(
                f,
                "native manifest {} unusable: unreadable ({cause})",
                manifest.display()
            ),
            NativeManifestError::Invalid { manifest, detail } => write!(
                f,
                "native manifest {} unusable: {detail}",
                manifest.display()
            ),
            NativeManifestError::DeclaredNativeMissing { manifest, native } => write!(
                f,
                "native file {} declared by native manifest {} is missing from the bundle",
                native.display(),
                manifest.display()
            ),
        }
    }
}

/// 清单在资源根下的路径。
pub fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_RELATIVE_PATH)
}

/// 读 `<root>/dist/native/manifest.json`，返回 `modules[module_id].native` 声明的
/// 文件（root 下的绝对路径）。声明文件缺席即 DeclaredNativeMissing——不把存在性
/// 判断留给调用方，保证「清单本身不可用」与「清单声明了但包里没有」文案可区分。
pub fn declared_native(root: &Path, module_id: &str) -> Result<PathBuf, NativeManifestError> {
    let manifest = manifest_path(root);
    let raw =
        std::fs::read_to_string(&manifest).map_err(|error| NativeManifestError::Unreadable {
            manifest: manifest.clone(),
            cause: error.to_string(),
        })?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|error| NativeManifestError::Unreadable {
            manifest: manifest.clone(),
            cause: error.to_string(),
        })?;

    let shape_ok = parsed.get("kind").and_then(|value| value.as_str()) == Some(MANIFEST_KIND)
        && parsed.get("schemaVersion").and_then(|value| value.as_i64())
            == Some(MANIFEST_SCHEMA_VERSION)
        && parsed
            .get("modules")
            .and_then(|value| value.as_object())
            .is_some();
    if !shape_ok {
        return Err(NativeManifestError::Invalid {
            manifest,
            detail: describe_invalid(&parsed),
        });
    }

    let native = parsed
        .get("modules")
        .and_then(|modules| modules.get(module_id))
        .and_then(|entry| entry.get("native"))
        .and_then(|value| value.as_str())
        .filter(|native| !native.is_empty());
    let Some(native) = native else {
        return Err(NativeManifestError::Invalid {
            manifest,
            detail: format!("declares no native file for '{module_id}'"),
        });
    };
    let native = root.join(native);
    if !native.is_file() {
        return Err(NativeManifestError::DeclaredNativeMissing { manifest, native });
    }
    Ok(native)
}

/// 无效清单的失败描述，与 TS 侧 describeInvalidManifest 同构。
fn describe_invalid(parsed: &serde_json::Value) -> String {
    if !parsed.is_object() {
        return format!("invalid manifest: not a JSON object ({parsed})");
    }
    let kind = parsed
        .get("kind")
        .map(|value| value.to_string())
        .unwrap_or_else(|| "n/a".to_string());
    let schema_version = parsed
        .get("schemaVersion")
        .map(|value| value.to_string())
        .unwrap_or_else(|| "n/a".to_string());
    format!("invalid manifest: kind={kind} schemaVersion={schema_version}")
}

/// 预检里走清单的 native 条目（ADR-086 §4.6 T4）：.node 位置由清单声明，不再按
/// platform-arch 拼 prebuilds 路径。清单缺席/不可用/声明文件缺失都算 Missing，
/// 文案互可区分且点名清单完整路径，会进 release 包的首启失败弹窗（与桌面诊断
/// 镜像 checkManifestNativeResource 同构）。
pub fn manifest_native_resource_check(
    root: &Path,
    module_id: &str,
    id: &str,
    label: &str,
) -> DesktopShellResourceCheck {
    match declared_native(root, module_id) {
        Ok(native) => resource_check(
            id,
            label,
            DesktopShellResourceKind::NativeModule,
            native,
            true,
            false,
        ),
        Err(error) => DesktopShellResourceCheck {
            id: id.to_string(),
            label: label.to_string(),
            kind: DesktopShellResourceKind::NativeModule,
            path: path_to_string(error.report_path()),
            required: true,
            status: DesktopShellResourceStatus::Missing,
            message: Some(error.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        declared_native, manifest_path, path_to_string, DesktopShellResourceStatus,
        NativeManifestError,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(prefix: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("{prefix}-{id}"));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, content).expect("write test file");
    }

    /// 写一份声明 better-sqlite3 native 的合法清单。
    fn write_manifest(root: &Path, native: &str) {
        write_file(
            &manifest_path(root),
            &format!(
                "{{\"kind\":\"agent_neo_native_dep_manifest\",\"schemaVersion\":1,\
                 \"platform\":\"test\",\"generatedAt\":\"2026-11-04T00:00:00.000Z\",\
                 \"modules\":{{\"better-sqlite3\":{{\"kind\":\"node-module\",\
                 \"entry\":\"dist/native/better-sqlite3\",\"native\":\"{native}\"}}}}}}"
            ),
        );
    }

    fn write_native(root: &Path, native: &str) -> PathBuf {
        let path = root.join(native);
        write_file(&path, "native");
        path
    }

    #[test]
    fn declared_native_resolves_manifest_native_path() {
        let root = temp_root("native-manifest-ok");
        let native = write_native(&root, "dist/native/better-sqlite3/darwin-arm64.node");
        write_manifest(&root, "dist/native/better-sqlite3/darwin-arm64.node");

        let resolved = declared_native(&root, "better-sqlite3").expect("declared native");
        assert_eq!(resolved, native);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn declared_native_accepts_custom_file_name() {
        // 文件名与 platform-arch 拼名不同也照常通过：位置真源是清单，不是本机拼名。
        let root = temp_root("native-manifest-custom-name");
        let native = write_native(&root, "dist/native/better-sqlite3/custom-name.node");
        write_manifest(&root, "dist/native/better-sqlite3/custom-name.node");

        let resolved = declared_native(&root, "better-sqlite3").expect("declared native");
        assert_eq!(resolved, native);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn declared_native_errors_when_manifest_missing() {
        let root = temp_root("native-manifest-missing");
        let error = declared_native(&root, "better-sqlite3").expect_err("manifest missing");
        match &error {
            NativeManifestError::Unreadable { manifest, cause } => {
                assert_eq!(manifest, &manifest_path(&root));
                assert!(cause.contains("No such file"), "{cause}");
            }
            other => panic!("expected Unreadable, got {other:?}"),
        }
        let message = error.to_string();
        assert!(
            message.contains("dist/native/manifest.json") && message.contains("unreadable"),
            "{message}"
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn declared_native_errors_when_manifest_invalid() {
        // 三个无效变体都归 Invalid：kind 不对 / 缺 modules 对象 / 模块没有 native 字符串。
        let root = temp_root("native-manifest-bad-kind");
        write_file(
            &manifest_path(&root),
            "{\"kind\":\"something-else\",\"schemaVersion\":1,\"modules\":{}}",
        );
        let error = declared_native(&root, "better-sqlite3").expect_err("invalid kind");
        assert_eq!(
            error,
            NativeManifestError::Invalid {
                manifest: manifest_path(&root),
                detail: "invalid manifest: kind=\"something-else\" schemaVersion=1".to_string(),
            }
        );
        fs::remove_dir_all(root).ok();

        let root = temp_root("native-manifest-no-modules");
        write_file(
            &manifest_path(&root),
            "{\"kind\":\"agent_neo_native_dep_manifest\",\"schemaVersion\":1}",
        );
        let error = declared_native(&root, "better-sqlite3").expect_err("no modules");
        assert!(
            matches!(error, NativeManifestError::Invalid { .. }),
            "{error}"
        );
        fs::remove_dir_all(root).ok();

        let root = temp_root("native-manifest-no-native");
        write_manifest(&root, "dist/native/better-sqlite3/darwin-arm64.node");
        write_file(
            &manifest_path(&root),
            "{\"kind\":\"agent_neo_native_dep_manifest\",\"schemaVersion\":1,\
             \"platform\":\"test\",\"modules\":{\"better-sqlite3\":{\"kind\":\"node-module\"}}}",
        );
        let error = declared_native(&root, "better-sqlite3").expect_err("no native field");
        assert_eq!(
            error,
            NativeManifestError::Invalid {
                manifest: manifest_path(&root),
                detail: "declares no native file for 'better-sqlite3'".to_string(),
            }
        );
        let message = error.to_string();
        assert!(message.contains("dist/native/manifest.json"), "{message}");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn declared_native_errors_when_declared_file_missing() {
        let root = temp_root("native-manifest-file-missing");
        let native = "dist/native/better-sqlite3/darwin-arm64.node";
        write_manifest(&root, native);
        // 声明了文件但不落盘。

        let error = declared_native(&root, "better-sqlite3").expect_err("file missing");
        assert_eq!(
            error,
            NativeManifestError::DeclaredNativeMissing {
                manifest: manifest_path(&root),
                native: root.join(native),
            }
        );
        let message = error.to_string();
        assert!(
            message.contains("dist/native/manifest.json")
                && message.contains("is missing from the bundle"),
            "{message}"
        );

        fs::remove_dir_all(root).ok();
    }

    use crate::{desktop_shell_resource_preflight, DesktopShellResourceCheck};

    fn preflight_native_check(root: &Path) -> DesktopShellResourceCheck {
        desktop_shell_resource_preflight(root, None)
            .into_iter()
            .find(|resource| resource.id == "better-sqlite3-native")
            .expect("better-sqlite3-native entry")
    }

    /// 清单三态失败（缺席 / 无效 / 声明的文件不在盘上）各自给出**不同**的 message，
    /// 且都点名清单路径 dist/native/manifest.json（进首启失败弹窗的可定位性）。
    #[test]
    fn desktop_shell_preflight_reports_distinct_manifest_failures() {
        // 1) 清单缺席：path 指向清单本身。
        let root = temp_root("agent-shell-preflight-no-manifest");
        let missing = preflight_native_check(&root);
        assert_eq!(missing.status, DesktopShellResourceStatus::Missing);
        assert!(missing.required);
        assert_eq!(missing.path, path_to_string(&manifest_path(&root)));
        let missing_message = missing.message.as_deref().expect("missing message");
        assert!(
            missing_message.contains("dist/native/manifest.json")
                && missing_message.contains("unreadable"),
            "{missing_message}"
        );
        fs::remove_dir_all(root).ok();

        // 2) 清单无效（kind 不对）：同样指向清单本身，但文案不同。
        let root = temp_root("agent-shell-preflight-bad-manifest");
        write_file(
            &manifest_path(&root),
            "{\"kind\":\"something-else\",\"schemaVersion\":9,\"modules\":{}}",
        );
        let invalid = preflight_native_check(&root);
        assert_eq!(invalid.status, DesktopShellResourceStatus::Missing);
        assert_eq!(invalid.path, path_to_string(&manifest_path(&root)));
        let invalid_message = invalid.message.as_deref().expect("invalid message");
        assert!(
            invalid_message.contains("dist/native/manifest.json")
                && invalid_message.contains("invalid manifest"),
            "{invalid_message}"
        );
        fs::remove_dir_all(root).ok();

        // 3) 清单声明了 native 但文件不在盘上：path 指向被声明的文件。
        let root = temp_root("agent-shell-preflight-native-missing");
        write_manifest(&root, "dist/native/better-sqlite3/darwin-arm64.node");
        let declared_missing = preflight_native_check(&root);
        assert_eq!(declared_missing.status, DesktopShellResourceStatus::Missing);
        assert_eq!(
            declared_missing.path,
            path_to_string(&root.join("dist/native/better-sqlite3/darwin-arm64.node"))
        );
        let declared_message = declared_missing
            .message
            .as_deref()
            .expect("declared-missing message");
        assert!(
            declared_message.contains("dist/native/manifest.json")
                && declared_message.contains("is missing from the bundle"),
            "{declared_message}"
        );
        fs::remove_dir_all(root).ok();

        // 三条 message 互不相同。
        assert_ne!(missing_message, invalid_message);
        assert_ne!(missing_message, declared_message);
        assert_ne!(invalid_message, declared_message);
    }

    /// 清单声明的文件名与 platform-arch 拼名不同（custom-name.node）也照常通过：
    /// 位置的真源是清单，不是运行期拼名。反向变异（重拼 prebuilds 路径）必红这条。
    #[test]
    fn desktop_shell_preflight_native_name_differing_from_platform_arch_passes() {
        let root = temp_root("agent-shell-preflight-custom-native-name");
        write_manifest(&root, "dist/native/better-sqlite3/custom-name.node");
        write_file(
            &root.join("dist/native/better-sqlite3/custom-name.node"),
            "native",
        );

        let check = preflight_native_check(&root);
        assert_eq!(check.status, DesktopShellResourceStatus::Present);
        assert!(check.message.is_none());
        assert_eq!(
            check.path,
            path_to_string(&root.join("dist/native/better-sqlite3/custom-name.node"))
        );

        fs::remove_dir_all(root).ok();
    }
}
