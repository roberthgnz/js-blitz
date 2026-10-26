use tauri::http::{header::CONTENT_SECURITY_POLICY, HeaderMap};

/// The opaque preview has its own restrictive meta CSP. All other application
/// assets retain Tauri's shell policy and native IPC restrictions.
pub(crate) fn configure_resource_policy(path: &str, headers: &mut HeaderMap) {
    if path == "/browser-frame.html" {
        headers.remove(CONTENT_SECURITY_POLICY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderValue;

    #[test]
    fn preview_uses_its_policy_without_removing_other_response_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("script-src 'self'"),
        );
        headers.insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
        configure_resource_policy("/browser-frame.html", &mut headers);
        assert!(!headers.contains_key(CONTENT_SECURITY_POLICY));
        assert_eq!(headers["x-content-type-options"], "nosniff");
    }

    #[test]
    fn shell_scripts_and_similarly_named_resources_retain_the_shell_policy() {
        for path in [
            "/",
            "/index.html",
            "/browser-frame.js",
            "/assets/index.js",
            "/other/browser-frame.html",
            "/browser-frame.html.js",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("script-src 'self'"),
            );
            configure_resource_policy(path, &mut headers);
            assert!(headers.contains_key(CONTENT_SECURITY_POLICY), "{path}");
        }
    }
}
