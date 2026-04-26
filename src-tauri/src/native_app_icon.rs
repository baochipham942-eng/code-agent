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
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSSize, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    let target_size = size.unwrap_or(64).max(16).min(512) as f64;

    // 子线程跑（NSWorkspace 阻塞调用），避免阻塞 Tauri 主 runtime
    let query_clone = query.clone();
    tokio::task::spawn_blocking(move || -> Result<AppIconResult, String> {
        unsafe {
            let workspace_cls = class!(NSWorkspace);
            let workspace: id = msg_send![workspace_cls, sharedWorkspace];
            if workspace == nil {
                return Err("NSWorkspace.sharedWorkspace returned nil".into());
            }

            let query_ns = NSString::alloc(nil).init_str(&query_clone);

            // 1) 先按 bundle identifier 查
            let mut app_url: id = msg_send![workspace, URLForApplicationWithBundleIdentifier: query_ns];

            // 2) 失败则按显示名扫 /Applications + ~/Applications
            if app_url == nil {
                if let Some(found) = find_app_by_display_name(&query_clone) {
                    let path_ns = NSString::alloc(nil).init_str(&found);
                    let file_url_cls = class!(NSURL);
                    app_url = msg_send![file_url_cls, fileURLWithPath: path_ns];
                }
            }

            if app_url == nil {
                return Err(format!("App not found for query: {}", query_clone));
            }

            // 拿 NSImage
            let path: id = msg_send![app_url, path];
            if path == nil {
                return Err("URL has no path".into());
            }
            let icon: id = msg_send![workspace, iconForFile: path];
            if icon == nil {
                return Err("iconForFile returned nil".into());
            }

            // 调整 logical size，让 PNG 输出按目标 size 渲染
            let target = NSSize::new(target_size, target_size);
            let _: () = msg_send![icon, setSize: target];

            // NSImage -> TIFF data -> NSBitmapImageRep -> PNG data
            let tiff: id = msg_send![icon, TIFFRepresentation];
            if tiff == nil {
                return Err("TIFFRepresentation returned nil".into());
            }
            let bitmap_cls = class!(NSBitmapImageRep);
            let bitmap: id = msg_send![bitmap_cls, imageRepWithData: tiff];
            if bitmap == nil {
                return Err("imageRepWithData returned nil".into());
            }
            // PNG = 4
            const NS_BITMAP_IMAGE_FILE_TYPE_PNG: u64 = 4;
            // properties 用空 dict
            let dict_cls = class!(NSDictionary);
            let empty_props: id = msg_send![dict_cls, dictionary];
            let png_data: id = msg_send![
                bitmap,
                representationUsingType: NS_BITMAP_IMAGE_FILE_TYPE_PNG
                properties: empty_props
            ];
            if png_data == nil {
                return Err("PNG representation failed".into());
            }

            let len: usize = msg_send![png_data, length];
            let bytes: *const u8 = msg_send![png_data, bytes];
            let slice = std::slice::from_raw_parts(bytes, len);
            let b64 = STANDARD.encode(slice);

            // 拿到 path string for return
            let utf8: *const std::os::raw::c_char = msg_send![path, UTF8String];
            let app_path = if utf8.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
            };

            Ok(AppIconResult {
                data_url: format!("data:image/png;base64,{}", b64),
                app_path,
            })
        }
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
