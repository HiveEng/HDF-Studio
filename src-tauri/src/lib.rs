use tauri::{Emitter, Manager};

/// Document paths passed on the command line (e.g. Windows "Open with" / double-click).
fn doc_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.skip(1).filter(|a| !a.starts_with('-')).collect()
}

#[tauri::command]
fn startup_files() -> Vec<String> {
    doc_args(std::env::args())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (double-clicking another PDF) opens it in the running window as a new tab.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = doc_args(argv.into_iter());
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
                let _ = w.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![startup_files])
        .run(tauri::generate_context!())
        .expect("error while running HDF Studio");
}
