use base64::{engine::general_purpose::STANDARD, Engine};
use zeroize::Zeroizing;

// This key encrypts provider credentials in the Node service. It is never sent
// to a webview or put in the sidecar's environment or command line.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub fn credential_key() -> Option<Zeroizing<String>> {
    let entry = keyring::Entry::new("com.jsblitz.desktop", "credential-encryption-key-v1").ok()?;
    match entry.get_password() {
        Ok(encoded) => valid_key(encoded),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = Zeroizing::new([0_u8; 32]);
            getrandom::getrandom(&mut *bytes).ok()?;
            let encoded = Zeroizing::new(STANDARD.encode(&*bytes));
            entry.set_password(&encoded).ok()?;
            // Read back the persistent entry before making credential saving
            // available. A failing/locked keyring must not use a transient key.
            valid_key(entry.get_password().ok()?)
        }
        Err(_) => None,
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn credential_key() -> Option<Zeroizing<String>> {
    None
}

fn valid_key(encoded: String) -> Option<Zeroizing<String>> {
    let encoded = Zeroizing::new(encoded);
    let bytes = Zeroizing::new(STANDARD.decode(encoded.as_bytes()).ok()?);
    (bytes.len() == 32).then_some(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_base64_encoded_256_bit_keys() {
        assert!(valid_key(STANDARD.encode([7_u8; 32])).is_some());
        assert!(valid_key(STANDARD.encode([7_u8; 31])).is_none());
        assert!(valid_key("invalid-key".into()).is_none());
    }
}
