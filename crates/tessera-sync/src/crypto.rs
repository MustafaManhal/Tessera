//! End-to-end encryption for sync (FR-71): the server stores opaque blobs and never sees a key.
//!
//! The user's recovery key is 120 random bits shown once as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` (Crockford base32, no
//! ambiguous letters). The document key is Argon2id(recovery key, salt = SHA-256("tessera-sync:" + user id)), 32
//! bytes, kept in the OS keychain on each signed-in device. Every document is sealed with XChaCha20-Poly1305 under a
//! fresh 24-byte nonce, with the document name as associated data so a blob cannot be replayed as another document.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};

/// Crockford base32 without I, L, O, U.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Crypto errors.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    /// The recovery key is not 24 base32 characters.
    #[error("That recovery key is not valid. It has 24 letters and digits in groups of four.")]
    BadRecoveryKey,
    /// Randomness was unavailable.
    #[error("The system random generator is unavailable.")]
    Random,
    /// Key derivation failed.
    #[error("The key could not be derived.")]
    Derive,
    /// Wrong key or a damaged or swapped blob.
    #[error("The synced data could not be decrypted with this recovery key.")]
    Decrypt,
}

/// A 32-byte document key.
#[derive(Clone, PartialEq, Eq)]
pub struct SyncKey(pub [u8; 32]);

impl std::fmt::Debug for SyncKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyncKey(…)")
    }
}

/// A sealed document as the server stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// Base64 ciphertext with its tag.
    pub ciphertext: String,
    /// Base64 24-byte nonce.
    pub nonce: String,
}

/// A new random recovery key, formatted for display.
///
/// # Errors
/// [`CryptoError::Random`].
pub fn new_recovery_key() -> Result<String, CryptoError> {
    let mut bytes = [0u8; 15];
    getrandom::fill(&mut bytes).map_err(|_| CryptoError::Random)?;
    Ok(format_key(&encode(&bytes)))
}

fn encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn format_key(raw: &str) -> String {
    raw.as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// Normalises what the user typed: case, spaces and dashes do not matter; O→0, I/L→1 as Crockford allows.
///
/// # Errors
/// [`CryptoError::BadRecoveryKey`].
pub fn normalize_recovery_key(input: &str) -> Result<String, CryptoError> {
    let raw: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect();
    if raw.len() != 24 || !raw.bytes().all(|b| ALPHABET.contains(&b)) {
        return Err(CryptoError::BadRecoveryKey);
    }
    Ok(format_key(&raw))
}

/// Argon2id key for this user. Deterministic, so every device with the recovery key derives the same key.
///
/// # Errors
/// [`CryptoError::BadRecoveryKey`], [`CryptoError::Derive`].
pub fn derive_key(recovery_key: &str, user_id: &str) -> Result<SyncKey, CryptoError> {
    let normalized = normalize_recovery_key(recovery_key)?;
    let salt = Sha256::digest(format!("tessera-sync:{user_id}").as_bytes());
    // 64 MiB, 3 passes: the key is already random, this only slows down guessing a leaked blob's key.
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(|_| CryptoError::Derive)?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(normalized.as_bytes(), &salt, &mut key)
        .map_err(|_| CryptoError::Derive)?;
    Ok(SyncKey(key))
}

/// Seals a document.
///
/// # Errors
/// [`CryptoError::Random`].
pub fn seal(key: &SyncKey, doc: &str, plaintext: &[u8]) -> Result<Sealed, CryptoError> {
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| CryptoError::Random)?;
    let cipher = XChaCha20Poly1305::new((&key.0).into());
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: plaintext,
                aad: doc.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Random)?;
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(Sealed {
        ciphertext: b64.encode(ciphertext),
        nonce: b64.encode(nonce),
    })
}

/// Opens a sealed document.
///
/// # Errors
/// [`CryptoError::Decrypt`] for a wrong key, a damaged blob or a blob of another document.
pub fn open(key: &SyncKey, doc: &str, sealed: &Sealed) -> Result<Vec<u8>, CryptoError> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let nonce = b64.decode(&sealed.nonce).map_err(|_| CryptoError::Decrypt)?;
    let ciphertext = b64.decode(&sealed.ciphertext).map_err(|_| CryptoError::Decrypt)?;
    let nonce = XNonce::try_from(nonce.as_slice()).map_err(|_| CryptoError::Decrypt)?;
    XChaCha20Poly1305::new((&key.0).into())
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad: doc.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_keys_are_random_formatted_and_forgiving_to_type() {
        let a = new_recovery_key().unwrap();
        let b = new_recovery_key().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 29);
        assert_eq!(a.matches('-').count(), 5);
        let typed = a.to_lowercase().replace('-', " ").replace('0', "o");
        assert_eq!(normalize_recovery_key(&typed).unwrap(), a);
        assert_eq!(normalize_recovery_key("ABCD"), Err(CryptoError::BadRecoveryKey));
        assert_eq!(
            normalize_recovery_key(&format!("{}U", &a[..28])),
            Err(CryptoError::BadRecoveryKey)
        );
    }

    #[test]
    fn the_same_recovery_key_and_user_give_the_same_key_and_round_trip() {
        let recovery = new_recovery_key().unwrap();
        let key = derive_key(&recovery, "42").unwrap();
        assert_eq!(key, derive_key(&recovery.to_lowercase(), "42").unwrap());
        assert_ne!(
            key,
            derive_key(&recovery, "43").unwrap(),
            "the salt binds the key to the account"
        );
        let sealed = seal(&key, "settings", b"theme = \"dark\"").unwrap();
        assert_eq!(open(&key, "settings", &sealed).unwrap(), b"theme = \"dark\"");
        assert_ne!(
            seal(&key, "settings", b"x").unwrap().nonce,
            seal(&key, "settings", b"x").unwrap().nonce
        );
    }

    #[test]
    fn a_wrong_key_another_document_or_a_damaged_blob_never_opens() {
        let key = derive_key(&new_recovery_key().unwrap(), "1").unwrap();
        let other = derive_key(&new_recovery_key().unwrap(), "1").unwrap();
        let sealed = seal(&key, "settings", b"secret-free settings").unwrap();
        assert_eq!(open(&other, "settings", &sealed), Err(CryptoError::Decrypt));
        assert_eq!(open(&key, "agent-profiles", &sealed), Err(CryptoError::Decrypt));
        let mut damaged = sealed.clone();
        damaged.ciphertext.replace_range(0..4, "AAAA");
        assert_eq!(open(&key, "settings", &damaged), Err(CryptoError::Decrypt));
    }
}
