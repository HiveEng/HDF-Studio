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

/// Scan pages with Windows Image Acquisition. Returns the saved image paths, in order.
#[tauri::command]
async fn scan_pages(dpi: u32, mode: u32, feeder: bool, dialog: bool) -> Result<Vec<String>, String> {
    #[cfg(not(windows))]
    {
        let _ = (dpi, mode, feeder, dialog);
        Err("Scanning works in the Windows app.".into())
    }
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use std::os::windows::process::CommandExt;
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("hdfstudio-scan-{}-{stamp}", std::process::id()));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let script = dir.join("scan.ps1");
            let dpi_s = dpi.clamp(75, 1200).to_string();
            let mode_s = (if [1, 2, 4].contains(&mode) { mode } else { 1 }).to_string();
            std::fs::write(&script, include_str!("../scripts/scan.ps1")).map_err(|e| e.to_string())?;
            let out = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&script)
                .arg("-Out").arg(&dir)
                .args(["-Dpi", dpi_s.as_str(), "-Mode", mode_s.as_str()])
                .args(["-Feeder", if feeder { "1" } else { "0" }, "-Dialog", if dialog { "1" } else { "0" }])
                .creation_flags(0x0800_0000) // no console window
                .output()
                .map_err(|e| format!("Could not start Windows scanning: {e}"))?;
            let paths: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty() && std::path::Path::new(l).is_file())
                .collect();
            if out.status.success() {
                return Ok(paths);
            }
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            let msg = if err.contains("0x80210015") {
                "No scanner found. Check that it is on, connected and shows in Windows Settings › Printers & scanners.".to_string()
            } else if err.contains("0x80210064") {
                return Ok(paths); // cancelled
            } else if err.contains("0x80210003") {
                "The document feeder is empty. Load the pages and try again, or scan from the glass.".to_string()
            } else if err.contains("0x80210006") || err.contains("0x8021000A") {
                "The scanner is busy or offline. Wait a moment and try again.".to_string()
            } else if err.contains("0x80210002") {
                "The scanner has a paper jam.".to_string()
            } else if err.contains("0x80210001") || err.contains("0x80210005") {
                "The scanner reported a problem. Check it is on and the lid is closed.".to_string()
            } else {
                format!("Scanning failed: {}", err.trim())
            };
            if paths.is_empty() { Err(msg) } else { Ok(paths) }
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// A one-shot web server on 127.0.0.1 that receives the Microsoft sign-in redirect.
/// The system browser does the sign-in (so passwords, MFA and passkeys never touch the app).
static OAUTH_LISTENER: std::sync::Mutex<Option<std::net::TcpListener>> = std::sync::Mutex::new(None);

#[tauri::command]
fn oauth_listen() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    *OAUTH_LISTENER.lock().unwrap() = Some(l);
    Ok(port)
}

/// Wait for the browser to come back to http://localhost:{port}/?code=… and return the query string.
#[tauri::command]
async fn oauth_wait(timeout_secs: u64) -> Result<String, String> {
    let l = OAUTH_LISTENER.lock().unwrap().take().ok_or("Sign-in was not started")?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Write};
        l.set_nonblocking(true).map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs.max(10));
        loop {
            match l.accept() {
                Ok((mut s, _)) => {
                    let _ = s.set_nonblocking(false);
                    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    let mut buf = [0u8; 8192];
                    let n = s.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let target = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let query = target.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
                    // Browsers also ask for /favicon.ico; only the redirect carries code= or error=.
                    if !(query.contains("code=") || query.contains("error=")) {
                        let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        continue;
                    }
                    let ok = query.contains("code=");
                    let body = format!(
                        "<!doctype html><meta charset=\"utf-8\"><title>HDF Studio</title><body style=\"font:16px system-ui;text-align:center;margin-top:80px;color:#0D0D0D\"><h2>{}</h2><p>You can close this tab and go back to HDF Studio.</p></body>",
                        if ok { "You're signed in" } else { "Sign-in didn't finish" }
                    );
                    let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes());
                    return Ok(query);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        return Err("Sign-in timed out. Try again.".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// POST a form and return the response body (Microsoft's token endpoint refuses browser-origin requests
/// from desktop app registrations, so the exchange is done here).
#[tauri::command]
async fn http_post_form(url: String, body: String) -> Result<String, String> {
    if !url.starts_with("https://login.microsoftonline.com/") {
        return Err("Unexpected sign-in address".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let r = ureq::post(&url)
            .timeout(std::time::Duration::from_secs(30))
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send_string(&body);
        let resp = match r {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(format!("Could not reach Microsoft sign-in: {e}")),
        };
        resp.into_string().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Microsoft Graph (OneDrive and SharePoint) request with raw bytes both ways.
/// Headers carry the request: x-method, x-url, x-token (optional), x-content-type, x-extra (one "Name: value").
/// Only Graph and SharePoint upload addresses are allowed.
#[tauri::command]
async fn graph_fetch(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let h = request.headers();
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let (method, url, token, ctype, extra) = (get("x-method"), get("x-url"), get("x-token"), get("x-content-type"), get("x-extra"));
    let host_ok = url.starts_with("https://graph.microsoft.com/")
        || url
            .strip_prefix("https://")
            .and_then(|rest| rest.split('/').next())
            .map(|host| host.ends_with(".sharepoint.com"))
            .unwrap_or(false);
    if !host_ok {
        return Err("Unexpected OneDrive/SharePoint address".into());
    }
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => Vec::new(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut req = ureq::request(if method.is_empty() { "GET" } else { &method }, &url).timeout(std::time::Duration::from_secs(600));
        if !token.is_empty() {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        if !ctype.is_empty() {
            req = req.set("Content-Type", &ctype);
        }
        if let Some((k, v)) = extra.split_once(": ") {
            req = req.set(k, v);
        }
        let r = if body.is_empty() && (method.is_empty() || method == "GET" || method == "DELETE") { req.call() } else { req.send_bytes(&body) };
        let (ok, resp) = match r {
            Ok(r) => (true, r),
            Err(ureq::Error::Status(_, r)) => (false, r),
            Err(e) => return Err(format!("Could not reach OneDrive/SharePoint: {e}")),
        };
        let status = resp.status();
        let mut out = Vec::new();
        use std::io::Read;
        resp.into_reader().take(2_000_000_000).read_to_end(&mut out).map_err(|e| e.to_string())?;
        if ok {
            Ok(tauri::ipc::Response::new(out))
        } else {
            Err(format!("HTTP {status}: {}", String::from_utf8_lossy(&out)))
        }
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
        .invoke_handler(tauri::generate_handler![startup_files, office_available, office_to_pdf, ghostscript_available, pdfa_convert, tsa_request, scan_pages, oauth_listen, oauth_wait, http_post_form, graph_fetch])
        .run(tauri::generate_context!())
        .expect("error while running HDF Studio");
}
