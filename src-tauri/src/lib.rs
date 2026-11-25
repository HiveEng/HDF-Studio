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

/// Find Ghostscript (used for PDF/A conversion). Newest installed version first on Windows.
fn find_gs() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("GS") {
        let p = std::path::PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let mut candidates: Vec<std::path::PathBuf> = vec![];
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(dir) = std::env::var(var) {
            let root = std::path::Path::new(&dir).join("gs");
            if let Ok(entries) = std::fs::read_dir(&root) {
                let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
                versions.sort();
                versions.reverse();
                for v in versions {
                    candidates.push(v.join("bin").join("gswin64c.exe"));
                    candidates.push(v.join("bin").join("gswin32c.exe"));
                }
            }
        }
    }
    for p in ["/opt/homebrew/bin/gs", "/usr/local/bin/gs", "/usr/bin/gs"] {
        candidates.push(p.into());
    }
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
fn ghostscript_available() -> bool {
    find_gs().is_some()
}

/// Convert a PDF to PDF/A-2b with Ghostscript. The app then adds the colour profile and properties.
#[tauri::command]
async fn pdfa_convert(data: Vec<u8>) -> Result<Vec<u8>, String> {
    let gs = find_gs().ok_or("PDF/A conversion needs Ghostscript. Install it from ghostscript.com, then try again.")?;
    let dir = std::env::temp_dir().join(format!("hdfstudio-pdfa-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let input = dir.join("in.pdf");
    let output = dir.join("out.pdf");
    std::fs::write(&input, &data).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(gs);
    cmd.args(["-q", "-dPDFA=2", "-dBATCH", "-dNOPAUSE", "-dNOOUTERSAVE", "-sColorConversionStrategy=RGB", "-sDEVICE=pdfwrite", "-dPDFACompatibilityPolicy=1"])
        .arg(format!("-sOutputFile={}", output.display()))
        .arg(&input);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW: no console flashing up
    }
    let status = cmd.status().map_err(|e| e.to_string())?;
    let result = if status.success() && output.exists() { std::fs::read(&output).map_err(|e| e.to_string()) } else { Err("Ghostscript could not convert this file".into()) };
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// Send an RFC 3161 timestamp request to a timestamp authority and return its answer.
/// Done here rather than in the webview because TSAs don't allow browser (CORS) requests.
#[tauri::command]
async fn tsa_request(url: String, body: Vec<u8>) -> Result<Vec<u8>, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("The timestamp server address must start with http:// or https://".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let resp = ureq::post(&url)
            .timeout(std::time::Duration::from_secs(20))
            .set("Content-Type", "application/timestamp-query")
            .send_bytes(&body)
            .map_err(|e| format!("Could not reach the timestamp server: {e}"))?;
        let mut out = Vec::new();
        use std::io::Read;
        resp.into_reader().take(1 << 20).read_to_end(&mut out).map_err(|e| e.to_string())?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![startup_files, office_available, office_to_pdf, ghostscript_available, pdfa_convert, tsa_request])
        .run(tauri::generate_context!())
        .expect("error while running HDF Studio");
}
