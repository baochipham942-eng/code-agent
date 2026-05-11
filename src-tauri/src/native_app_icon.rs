// macOS-only：通过 NSWorkspace 提取 app 图标，输出 base64 PNG（dataURL）。
// 非 macOS 平台返回 unsupported 错误，前端 fallback 到 emoji。

#[cfg(target_os = "macos")]
use base64::{engine::general_purpose::STANDARD, Engine as _};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIconResult {
    /// data:image/png;base64,...
    pub data_url: String,
    /// resolved app bundle path
    pub app_path: String,
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn desktop_get_app_icon(_query: String, _size: Option<u32>) -> Result<AppIconResult, String> {
    Err("desktop_get_app_icon: only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn desktop_get_app_icon(query: String, size: Option<u32>) -> Result<AppIconResult, String> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSSize, NSString, NSURL};

    let target_size = size.unwrap_or(64).max(16).min(512) as f64;

    // 子线程跑（NSWorkspace 阻塞调用），避免阻塞 Tauri 主 runtime
    let query_clone = query.clone();
    tokio::task::spawn_blocking(move || -> Result<AppIconResult, String> {
        autoreleasepool(|pool| {
            let workspace = NSWorkspace::sharedWorkspace();
            let query_ns = NSString::from_str(&query_clone);

            // 1) 先按 bundle identifier 查
            let mut app_url = workspace.URLForApplicationWithBundleIdentifier(&query_ns);

            // 2) 失败则按显示名扫 /Applications + ~/Applications
            if app_url.is_none() {
                if let Some(found) = find_app_by_display_name(&query_clone) {
                    let path_ns = NSString::from_str(&found);
                    app_url = Some(NSURL::fileURLWithPath(&path_ns));
                }
            }

            let app_url = app_url.ok_or_else(|| format!("App not found for query: {}", query_clone))?;

            // 拿 NSImage
            let path = app_url.path().ok_or_else(|| "URL has no path".to_string())?;
            let icon = workspace.iconForFile(&path);

            // 调整 logical size，让 PNG 输出按目标 size 渲染
            let target = NSSize {
                width: target_size,
                height: target_size,
            };
            icon.setSize(target);

            // NSImage -> TIFF data -> NSBitmapImageRep -> PNG data
            let tiff = icon
                .TIFFRepresentation()
                .ok_or_else(|| "TIFFRepresentation returned nil".to_string())?;
            let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
                .ok_or_else(|| "imageRepWithData returned nil".to_string())?;
            // properties 用空 dict
            let empty_props: objc2::rc::Retained<
                NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>,
            > = NSDictionary::dictionary();
            let png_data = unsafe {
                bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty_props)
            }
            .ok_or_else(|| "PNG representation failed".to_string())?;

            let slice = unsafe { png_data.as_bytes_unchecked() };
            let b64 = STANDARD.encode(slice);

            // 拿到 path string for return
            let app_path = unsafe { path.to_str(pool) }.to_owned();

            Ok(AppIconResult {
                data_url: format!("data:image/png;base64,{}", b64),
                app_path,
            })
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking join failed: {}", e))?
}

#[cfg(target_os = "macos")]
fn find_app_by_display_name(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let candidates = [
        "/Applications".to_string(),
        format!("{}/Applications", std::env::var("HOME").ok()?),
    ];
    for dir in &candidates {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("app") {
                    continue;
                }
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if stem.to_lowercase() == lower
                        || stem.to_lowercase().contains(&lower)
                    {
                        return Some(path.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    None
}
