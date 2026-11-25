use tauri::{Emitter, Manager};

/// Document paths passed on the command line (e.g. Windows "Open with" / double-click).
fn doc_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.skip(1).filter(|a| !a.starts_with('-')).collect()
}

#[tauri::command]
fn startup_files() -> Vec<String> {
    doc_args(std::env::args())
}

/// Find LibreOffice's soffice executable (used to convert Word/Excel/PowerPoint files to PDF).
fn find_soffice() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = vec![];
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(dir) = std::env::var(var) {
            candidates.push(std::path::Path::new(&dir).join("LibreOffice").join("program").join("soffice.exe"));
        }
    }
    candidates.push("/Applications/LibreOffice.app/Contents/MacOS/soffice".into());
    candidates.push("/usr/bin/soffice".into());
    candidates.push("/usr/local/bin/soffice".into());
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
fn office_available() -> bool {
    find_soffice().is_some()
}

/// Convert an Office document to PDF with LibreOffice and return the PDF bytes.
#[tauri::command]
async fn office_to_pdf(name: String, data: Vec<u8>) -> Result<Vec<u8>, String> {
    let soffice = find_soffice().ok_or("LibreOffice is not installed. Install it from libreoffice.org to convert Office files.")?;
    let dir = std::env::temp_dir().join(format!("hdfstudio-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    let input = dir.join(&safe);
    std::fs::write(&input, &data).map_err(|e| e.to_string())?;
    let status = std::process::Command::new(soffice)
        .args(["--headless", "--norestore", "--convert-to", "pdf", "--outdir"])
        .arg(&dir)
        .arg(&input)
        .status()
        .map_err(|e| e.to_string())?;
    let out = input.with_extension("pdf");
    let result = if status.success() && out.exists() { std::fs::read(&out).map_err(|e| e.to_string()) } else { Err("LibreOffice could not convert this file".into()) };
    let _ = std::fs::remove_file(&input);
    let _ = std::fs::remove_file(&out);
    result
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
        .invoke_handler(tauri::generate_handler![startup_files, office_available, office_to_pdf])
        .run(tauri::generate_context!())
        .expect("error while running HDF Studio");
}
