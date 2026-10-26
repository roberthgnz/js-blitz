use std::{
    collections::HashMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::{oneshot, watch, OnceCell};
use zeroize::{Zeroize, Zeroizing};

use crate::{credentials, process_guard::ProcessGuard};

type RpcResult = Result<Value, String>;

#[derive(Clone, Deserialize, Serialize)]
pub struct DesktopEvent {
    pub event: String,
    pub args: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ServiceMessage {
    Event(DesktopEvent),
    Response {
        id: String,
        result: Option<Value>,
        error: Option<String>,
    },
}

#[derive(Default)]
struct Pending {
    requests: HashMap<String, oneshot::Sender<RpcResult>>,
    failure: Option<String>,
}

pub struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    guard: Mutex<Option<ProcessGuard>>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    initialized: AtomicBool,
    terminated: watch::Sender<bool>,
}

#[derive(Default)]
pub struct DesktopHost {
    ready: OnceCell<Result<Arc<Sidecar>, String>>,
    active: Mutex<Option<Arc<Sidecar>>>,
    shutting_down: AtomicBool,
}

impl DesktopHost {
    pub async fn service(&self, app: &AppHandle) -> Result<Arc<Sidecar>, String> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("The desktop service is shutting down.".into());
        }
        let result = self
            .ready
            .get_or_init(|| async {
                let runtime = runtime_directory(app)?;
                let user_data = user_data_directory(app)?;
                let workspace = node_path(&user_data.join("workspace"));
                std::fs::create_dir_all(&workspace)
                    .map_err(|error| format!("Cannot create the desktop workspace: {error}"))?;
                let service = Sidecar::spawn(app, &runtime)?;
                *self.active.lock().unwrap_or_else(|e| e.into_inner()) = Some(service.clone());
                if self.shutting_down.load(Ordering::Acquire) {
                    service.force_stop();
                    return Err("The desktop service is shutting down.".into());
                }
                let key = tauri::async_runtime::spawn_blocking(credentials::credential_key)
                    .await
                    .map_err(|_| "Cannot access the credential store.".to_string())?;
                let mut params = json!({ "userDataPath": user_data, "workspacePath": workspace });
                if let Some(key) = key {
                    params["credentialKey"] = Value::String(key.to_string());
                }
                match service
                    .request("initialize", params, Duration::from_secs(20))
                    .await
                {
                    Ok(_) => {
                        service.initialized.store(true, Ordering::Release);
                        Ok(service)
                    }
                    Err(error) => {
                        service.force_stop();
                        Err(format!("Cannot initialize the desktop service: {error}"))
                    }
                }
            })
            .await
            .clone();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err("The desktop service is shutting down.".into());
        }
        result
    }

    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let service = self.active.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(service) = service {
            // Before initialize completes, the service has no execution children.
            if service.initialized.load(Ordering::Acquire) {
                let mut terminated = service.terminated.subscribe();
                let _ = service
                    .request("shutdown", Value::Null, Duration::from_secs(3))
                    .await;
                if !*terminated.borrow() {
                    let _ =
                        tokio::time::timeout(Duration::from_secs(2), terminated.changed()).await;
                }
            }
            let _ = tauri::async_runtime::spawn_blocking(move || service.force_stop()).await;
        }
    }

    pub fn force_stop(&self) {
        self.shutting_down.store(true, Ordering::Release);
        if let Some(service) = self.active.lock().unwrap_or_else(|e| e.into_inner()).take() {
            service.force_stop();
        }
    }
}

impl Sidecar {
    fn spawn(app: &AppHandle, runtime: &Path) -> Result<Arc<Self>, String> {
        let (mut output, child) = app
            .shell()
            .sidecar("jsblitz-node")
            .map_err(|error| format!("Cannot locate the bundled Node runtime: {error}"))?
            .arg(node_path(&runtime.join("service.cjs")))
            .current_dir(node_path(runtime))
            // The native shell API has no env_remove. Rebuild the inherited
            // environment without preload/module overrides, including Windows
            // spellings that differ only in case.
            .env_clear()
            .envs(std::env::vars_os().filter(|(key, _)| allowed_environment_key(key)))
            .set_process_group(true)
            .spawn()
            .map_err(|error| format!("Cannot start the bundled Node runtime: {error}"))?;
        // No requests are written until the crash guard is attached. Node cannot
        // start execution workers before its initialize request.
        let guard = match ProcessGuard::attach(child.pid()) {
            Ok(guard) => guard,
            Err(error) => {
                let _ = child.kill();
                return Err(format!("Cannot protect the desktop process tree: {error}"));
            }
        };
        eprintln!(
            "[jsblitz-native] Started guarded desktop service pid={}",
            child.pid()
        );
        let (terminated, _) = watch::channel(false);
        let service = Arc::new(Self {
            child: Mutex::new(Some(child)),
            guard: Mutex::new(Some(guard)),
            pending: Mutex::new(Pending::default()),
            next_id: AtomicU64::new(1),
            initialized: AtomicBool::new(false),
            terminated,
        });
        let reader = service.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut failure = "The desktop service stopped unexpectedly.".to_string();
            while let Some(event) = output.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        match serde_json::from_slice::<ServiceMessage>(&line) {
                            Ok(ServiceMessage::Event(event)) => {
                                let _ = app.emit("desktop-event", event);
                            }
                            Ok(ServiceMessage::Response { id, result, error }) => {
                                let sender = reader
                                    .pending
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .requests
                                    .remove(&id);
                                if let Some(sender) = sender {
                                    let _ = sender.send(match error {
                                        Some(error) => Err(error),
                                        None => Ok(result.unwrap_or(Value::Null)),
                                    });
                                }
                            }
                            Err(_) => {
                                // Do not include wire content: it may contain secrets.
                                failure = "The desktop service sent an invalid response.".into();
                                break;
                            }
                        }
                    }
                    CommandEvent::Stderr(line) => {
                        // Only report fixed error classes, never paths, stderr
                        // content, user code, or credential-bearing frames.
                        #[cfg(debug_assertions)]
                        if !reader.initialized.load(Ordering::Acquire) {
                            if let Some(class) = startup_error_class(&line) {
                                eprintln!("[jsblitz-native] Desktop bootstrap error class={class}");
                            }
                        }
                        #[cfg(not(debug_assertions))]
                        let _ = line;
                    }
                    CommandEvent::Terminated(status) => {
                        failure = termination_message(status.code, status.signal);
                        eprintln!("[jsblitz-native] {failure}");
                        break;
                    }
                    CommandEvent::Error(_) => {
                        failure = "The desktop service transport failed.".into();
                        eprintln!("[jsblitz-native] {failure}");
                        break;
                    }
                    _ => {}
                }
            }
            reader.fail_pending(&failure);
            reader.terminated.send_replace(true);
            let _ = tauri::async_runtime::spawn_blocking(move || reader.force_stop()).await;
        });
        Ok(service)
    }

    async fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> RpcResult {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let mut message = json!({ "id": id, "method": method, "params": params });
        let encoded = serde_json::to_vec(&message)
            .map_err(|_| "Cannot encode a desktop request.".to_string());
        // The initialization key has exactly one destination: this stdin frame.
        if method == "initialize" {
            if let Some(Value::String(key)) = message
                .get_mut("params")
                .and_then(|params| params.get_mut("credentialKey"))
            {
                key.zeroize();
            }
        }
        let mut bytes = Zeroizing::new(encoded?);
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("The desktop request is too large.".into());
        }
        bytes.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(error) = &pending.failure {
                return Err(error.clone());
            }
            pending.requests.insert(id.clone(), sender);
        }
        let _pending = PendingRequest {
            service: self.clone(),
            id,
        };
        let writer = self.clone();
        let operation = async move {
            tauri::async_runtime::spawn_blocking(move || {
                let mut child = writer.child.lock().unwrap_or_else(|e| e.into_inner());
                let child = child
                    .as_mut()
                    .ok_or_else(|| "The desktop service is not running.".to_string())?;
                child
                    .write(&bytes)
                    .map_err(|_| "Cannot write to the desktop service.".to_string())
            })
            .await
            .map_err(|_| "Cannot send a desktop request.".to_string())??;
            receiver
                .await
                .map_err(|_| "The desktop service disconnected.".to_string())?
        };
        tokio::time::timeout(timeout, operation)
            .await
            .map_err(|_| "The desktop service request timed out.".to_string())?
    }

    fn fail_pending(&self, error: &str) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        // Preserve the original exit/protocol failure when cleanup also runs.
        // Otherwise an early bootstrap error becomes only "not running".
        let error = pending.failure.get_or_insert_with(|| error.into()).clone();
        for (_, sender) in pending.requests.drain() {
            let _ = sender.send(Err(error.clone()));
        }
    }

    fn force_stop(&self) {
        // Closing the crash guard first also unblocks a stuck stdin writer on
        // Windows, before acquiring the child lock for explicit group cleanup.
        self.guard.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(child) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = child.kill();
        }
        self.fail_pending("The desktop service is not running.");
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.force_stop();
    }
}

struct PendingRequest {
    service: Arc<Sidecar>,
    id: String,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.service
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .requests
            .remove(&self.id);
    }
}

fn runtime_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("desktop");
    if directory.join("service.cjs").is_file() {
        return Ok(node_path(&directory));
    }
    #[cfg(debug_assertions)]
    {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/desktop");
        if directory.join("service.cjs").is_file() {
            return Ok(node_path(&directory));
        }
    }
    Err("The bundled desktop service is missing. Prepare the desktop runtime before building JSBlitz.".into())
}

fn node_path(path: &Path) -> PathBuf {
    // Tauri canonicalizes resource paths on Windows. Node 22's main-module
    // resolver rejects the resulting \\?\ disk prefix with EISDIR. Simplify
    // compatible disk paths without blindly stripping UNC/device prefixes.
    dunce::simplified(path).to_path_buf()
}

fn has_legacy_data(directory: &Path) -> bool {
    directory.join("desktop-settings.json").is_file() || directory.join("workspace").is_dir()
}

fn termination_message(code: Option<i32>, signal: Option<i32>) -> String {
    match (code, signal) {
        (Some(code), _) => format!("The desktop service exited (code {code})."),
        (_, Some(signal)) => format!("The desktop service exited (signal {signal})."),
        _ => "The desktop service stopped unexpectedly.".into(),
    }
}

#[cfg(any(debug_assertions, test))]
fn startup_error_class(line: &[u8]) -> Option<&'static str> {
    [
        "ERR_MODULE_NOT_FOUND",
        "MODULE_NOT_FOUND",
        "ERR_REQUIRE_ESM",
        "ERR_DLOPEN_FAILED",
        "ERR_UNKNOWN_FILE_EXTENSION",
        "ERR_INVALID_ARG_VALUE",
        "ERR_INVALID_ARG_TYPE",
        "SyntaxError",
        "ReferenceError",
        "TypeError",
        "RangeError",
        "ENOENT",
        "EISDIR",
        "EACCES",
        "EPERM",
    ]
    .into_iter()
    .find(|class| {
        line.windows(class.len())
            .any(|window| window == class.as_bytes())
    })
}

fn allowed_environment_key(key: &OsStr) -> bool {
    let key = key.to_string_lossy();
    !["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"]
        .iter()
        .any(|blocked| key.eq_ignore_ascii_case(blocked))
}

fn user_data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let legacy = app
        .path()
        .config_dir()
        .map_err(|error| error.to_string())?
        .join("js-blitz");
    if has_legacy_data(&legacy) {
        return Ok(node_path(&legacy));
    }
    app.path()
        .app_data_dir()
        .map(|path| node_path(&path))
        .map_err(|error| error.to_string())
}

fn validate_request(method: &str, params: &Value) -> Result<(), String> {
    let valid = match method {
        "executeCode" | "saveDesktopSettings" | "askAssistant" => params.is_object(),
        "cancelExecution" | "installPackage" | "cancelAssistant" => params.is_string(),
        "listPackages" | "getTypeDefinitions" | "getDesktopSettings" | "shutdown" => {
            params.is_null()
        }
        _ => return Err("Unsupported desktop method.".into()),
    };
    if valid {
        Ok(())
    } else {
        Err("Invalid desktop request parameters.".into())
    }
}

#[tauri::command]
pub async fn desktop_invoke(
    method: String,
    params: Value,
    window: WebviewWindow,
    app: AppHandle,
    host: State<'_, Arc<DesktopHost>>,
) -> RpcResult {
    if window.label() != "main" {
        return Err("This command is only available in the main window.".into());
    }
    validate_request(&method, &params)?;
    if method == "shutdown" {
        host.shutdown().await;
        return Ok(Value::Null);
    }
    host.service(&app)
        .await?
        // The runner permits up to ten minutes, including installation. Allow
        // its own timeout/cancellation response to arrive before the RPC limit.
        .request(&method, params, Duration::from_secs(660))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn node_paths_simplify_verbatim_disk_paths_and_preserve_unc_paths() {
        assert_eq!(
            node_path(Path::new(
                r"\\?\C:\Program Files\JSBlitz\desktop\service.cjs"
            )),
            PathBuf::from(r"C:\Program Files\JSBlitz\desktop\service.cjs")
        );
        assert_eq!(
            node_path(Path::new(r"\\?\C:\Users\example\AppData\Roaming\js-blitz")),
            PathBuf::from(r"C:\Users\example\AppData\Roaming\js-blitz")
        );
        for path in [
            r"\\server\share\desktop\service.cjs",
            r"\\?\UNC\server\share\desktop\service.cjs",
        ] {
            assert_eq!(node_path(Path::new(path)), PathBuf::from(path));
        }
    }

    #[cfg(all(windows, target_arch = "x86_64", target_env = "msvc"))]
    #[test]
    fn packaged_node_initializes_from_a_normalized_canonical_resource_path() {
        use std::{
            io::{Read, Write},
            process::{Command, Stdio},
        };

        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime = root.join("resources/desktop").canonicalize().unwrap();
        let directory = std::env::temp_dir().join(format!(
            "jsblitz-native-path-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let directory = node_path(&directory.canonicalize().unwrap());
        let mut child = Command::new(root.join("binaries/jsblitz-node-x86_64-pc-windows-msvc.exe"))
            .arg(node_path(&runtime.join("service.cjs")))
            .current_dir(node_path(&runtime))
            .env_clear()
            .envs(std::env::vars_os().filter(|(key, _)| allowed_environment_key(key)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let initialize = json!({
            "id": "fixture-initialize", "method": "initialize",
            "params": { "userDataPath": directory, "workspacePath": directory.join("workspace"), "credentialKey": "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=" }
        });
        // Keep the pipe open until the explicit shutdown response: dropping it
        // early would exercise the service's EOF exit instead of initialization.
        let mut stdin = child.stdin.take().unwrap();
        writeln!(stdin, "{initialize}").unwrap();
        writeln!(
            stdin,
            "{{\"id\":\"fixture-shutdown\",\"method\":\"shutdown\",\"params\":null}}"
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("The fixture service did not shut down.");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut stdout = String::new();
        let mut stderr = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut stdout)
            .unwrap();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        drop(stdin);
        assert!(status.success(), "Fixture Node failed: {stderr}");
        let responses: Vec<Value> = stdout
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(
            responses.contains(&json!({"id":"fixture-initialize", "result":null})),
            "Fixture response: {stdout}; stderr: {stderr}"
        );
        assert!(
            responses.contains(&json!({"id":"fixture-shutdown", "result":null})),
            "Fixture response: {stdout}; stderr: {stderr}"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn exit_diagnostics_include_only_numeric_status() {
        assert_eq!(
            termination_message(Some(1), None),
            "The desktop service exited (code 1)."
        );
        assert_eq!(
            termination_message(None, Some(9)),
            "The desktop service exited (signal 9)."
        );
        assert_eq!(
            termination_message(None, None),
            "The desktop service stopped unexpectedly."
        );
    }

    #[test]
    fn bootstrap_diagnostics_report_fixed_classes_without_wire_content() {
        assert_eq!(
            startup_error_class(b"Error: MODULE_NOT_FOUND at C:/private/path secret-123"),
            Some("MODULE_NOT_FOUND")
        );
        assert_eq!(
            startup_error_class(b"TypeError: secret-123"),
            Some("TypeError")
        );
        assert_eq!(
            startup_error_class(b"secret-123 with no known error code"),
            None
        );
    }

    #[test]
    fn excludes_inherited_node_bootstrap_overrides_case_insensitively() {
        for key in [
            "NODE_OPTIONS",
            "Node_Options",
            "NODE_PATH",
            "node_path",
            "ELECTRON_RUN_AS_NODE",
        ] {
            assert!(!allowed_environment_key(OsStr::new(key)));
        }
        for key in ["PATH", "Path", "HOME", "SystemRoot", "HTTPS_PROXY"] {
            assert!(allowed_environment_key(OsStr::new(key)));
        }
    }

    #[test]
    fn whitelists_exact_methods_and_direct_parameter_shapes() {
        for method in ["executeCode", "saveDesktopSettings", "askAssistant"] {
            assert!(validate_request(method, &json!({})).is_ok());
            assert!(validate_request(method, &json!([{}])).is_err());
        }
        for method in ["cancelExecution", "installPackage", "cancelAssistant"] {
            assert!(validate_request(method, &json!("value")).is_ok());
            assert!(validate_request(method, &json!(["value"])).is_err());
        }
        for method in [
            "listPackages",
            "getTypeDefinitions",
            "getDesktopSettings",
            "shutdown",
        ] {
            assert!(validate_request(method, &Value::Null).is_ok());
            assert!(validate_request(method, &json!([])).is_err());
        }
        for method in [
            "initialize",
            "execute-code",
            "shell",
            "spawn",
            "__proto__",
            "",
        ] {
            assert!(validate_request(method, &Value::Null).is_err());
        }
    }

    #[test]
    fn parses_responses_and_preserves_event_arguments() {
        assert!(
            matches!(serde_json::from_str::<ServiceMessage>(r#"{"id":"12","result":{"success":true}}"#).unwrap(), ServiceMessage::Response { id, result: Some(_), error: None } if id == "12")
        );
        assert!(
            matches!(serde_json::from_str::<ServiceMessage>(r#"{"id":"13","error":"cancelled"}"#).unwrap(), ServiceMessage::Response { error: Some(error), .. } if error == "cancelled")
        );
        match serde_json::from_str::<ServiceMessage>(
            r#"{"event":"execution-output","args":[{"runId":"r1","output":"hello"}]}"#,
        )
        .unwrap()
        {
            ServiceMessage::Event(event) => {
                assert_eq!(event.event, "execution-output");
                assert_eq!(event.args, vec![json!({"runId":"r1", "output":"hello"})]);
            }
            _ => panic!("expected event"),
        }
        for message in [
            "not json",
            r#"{"id":42,"result":null}"#,
            r#"{"event":"oops","args":{}}"#,
        ] {
            assert!(serde_json::from_str::<ServiceMessage>(message).is_err());
        }
    }

    #[test]
    fn detects_existing_settings_or_workspace_without_copying() {
        let directory = std::env::temp_dir().join(format!(
            "jsblitz-legacy-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(!has_legacy_data(&directory));
        std::fs::write(directory.join("desktop-settings.json"), "{}").unwrap();
        assert!(has_legacy_data(&directory));
        std::fs::remove_file(directory.join("desktop-settings.json")).unwrap();
        std::fs::create_dir(directory.join("workspace")).unwrap();
        assert!(has_legacy_data(&directory));
        std::fs::remove_dir(directory.join("workspace")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
