// 独立验证 NSWorkspace bridge：不依赖 Tauri webview，直接调 native_app_icon
// 内部实现拉取 Safari/Slack/WeChat 图标，输出 PNG 字节数到 stdout。
//
// 用法：cd src-tauri && cargo run --release --example test_app_icon

#[cfg(target_os = "macos")]
mod inner {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSSize, NSString};

    pub fn fetch_app_icon(query: &str, target_size: f64) -> Result<(String, usize), String> {
        autoreleasepool(|pool| {
            let workspace = NSWorkspace::sharedWorkspace();
            let query_ns = NSString::from_str(query);
            let app_url = workspace
                .URLForApplicationWithBundleIdentifier(&query_ns)
                .ok_or_else(|| format!("App not found: {}", query))?;
            let path = app_url.path().ok_or_else(|| "URL has no path".to_string())?;
            let icon = workspace.iconForFile(&path);
            let target = NSSize {
                width: target_size,
                height: target_size,
            };
            icon.setSize(target);
            let tiff = icon
                .TIFFRepresentation()
                .ok_or_else(|| "TIFFRepresentation returned nil".to_string())?;
            let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
                .ok_or_else(|| "imageRepWithData returned nil".to_string())?;
            let empty_props: objc2::rc::Retained<
                NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>,
            > = NSDictionary::dictionary();
            let png_data = unsafe {
                bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty_props)
            }
            .ok_or_else(|| "PNG representation failed".to_string())?;
            let slice = unsafe { png_data.as_bytes_unchecked() };
            let b64 = STANDARD.encode(slice);
            let app_path = unsafe { path.to_str(pool) }.to_owned();
            Ok((
                format!("{} → {} bytes PNG, b64 头: {}", app_path, slice.len(), &b64[..32]),
                slice.len(),
            ))
        })
    }
}

#[cfg(target_os = "macos")]
fn main() {
    let queries = ["com.apple.Safari", "com.tinyspeck.slackmacgap", "com.tencent.xinWeChat", "com.apple.finder"];
    let mut ok = 0;
    let mut fail = 0;
    for q in &queries {
        match inner::fetch_app_icon(q, 64.0) {
            Ok((info, _)) => {
                println!("✓ {} → {}", q, info);
                ok += 1;
            }
            Err(e) => {
                println!("✗ {} → {}", q, e);
                fail += 1;
            }
        }
    }
    println!("\n{}/{} OK", ok, ok + fail);
    std::process::exit(if fail == 0 { 0 } else { 1 });
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("test_app_icon: only runs on macOS");
    std::process::exit(1);
}
