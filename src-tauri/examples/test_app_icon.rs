// 独立验证 NSWorkspace bridge：不依赖 Tauri webview，直接调 native_app_icon
// 内部实现拉取 Safari/Slack/WeChat 图标，输出 PNG 字节数到 stdout。
//
// 用法：cd src-tauri && cargo run --release --example test_app_icon

#[cfg(target_os = "macos")]
mod inner {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSSize, NSString};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use objc::{class, msg_send, sel, sel_impl};

    pub fn fetch_app_icon(query: &str, target_size: f64) -> Result<(String, usize), String> {
        unsafe {
            let workspace_cls = class!(NSWorkspace);
            let workspace: id = msg_send![workspace_cls, sharedWorkspace];
            if workspace == nil {
                return Err("NSWorkspace.sharedWorkspace returned nil".into());
            }
            let query_ns = NSString::alloc(nil).init_str(query);
            let app_url: id = msg_send![workspace, URLForApplicationWithBundleIdentifier: query_ns];
            if app_url == nil {
                return Err(format!("App not found: {}", query));
            }
            let path: id = msg_send![app_url, path];
            if path == nil {
                return Err("URL has no path".into());
            }
            let icon: id = msg_send![workspace, iconForFile: path];
            if icon == nil {
                return Err("iconForFile returned nil".into());
            }
            let target = NSSize::new(target_size, target_size);
            let _: () = msg_send![icon, setSize: target];
            let tiff: id = msg_send![icon, TIFFRepresentation];
            if tiff == nil {
                return Err("TIFFRepresentation returned nil".into());
            }
            let bitmap_cls = class!(NSBitmapImageRep);
            let bitmap: id = msg_send![bitmap_cls, imageRepWithData: tiff];
            if bitmap == nil {
                return Err("imageRepWithData returned nil".into());
            }
            const NS_BITMAP_IMAGE_FILE_TYPE_PNG: u64 = 4;
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
            let utf8: *const std::os::raw::c_char = msg_send![path, UTF8String];
            let app_path = if utf8.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
            };
            Ok((format!("{} → {} bytes PNG, b64 头: {}", app_path, len, &b64[..32]), len))
        }
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
