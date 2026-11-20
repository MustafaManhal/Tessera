//! Secret redaction for logs and error reports (M12.4, FR-74, NFR-08). Applied before a log line is written and again
//! when a report is built from older log files. It removes what looks like a credential and leaves everything else
//! alone: tokens of GitHub, Linear and OpenAI/Anthropic-style keys, bearer and basic credentials, authorization
//! headers, passwords in URLs, and `password=`, `token: "…"`, `api_key=` style pairs.
use regex::{Captures, Regex};
use std::{borrow::Cow, sync::OnceLock};

pub const MASK: &str = "[REDACTED]";

type Replacer = dyn Fn(&Captures) -> String;

struct Rules {
    tokens: Regex,
    bearer: Regex,
    url_credentials: Regex,
    named: Regex,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| Rules {
        // Token shapes with a recognisable prefix.
        tokens: Regex::new(
            r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_(?:api|oauth)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b",
        )
        .expect("token pattern"),
        // `Bearer abc`, `Basic abc`, `token abc` after an authorization header or in a command line.
        bearer: Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}").expect("bearer pattern"),
        // scheme://user:password@host
        url_credentials: Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^@\s/]+@").expect("url pattern"),
        // name=value, name: value, "name":"value" for secret-looking names.
        named: Regex::new(
            r#"(?i)\b([A-Za-z0-9_-]*(?:authorization|pass(?:word|wd|phrase)|secret(?:[_-]?key)?|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+|token\s+)?[^\s"',;&})\]]+"#,
        )
        .expect("named pattern"),
    })
}

/// The text with credentials replaced by [`MASK`]. Borrowed when nothing matched.
pub fn redact(text: &str) -> Cow<'_, str> {
    let rules = rules();
    let mut current: Cow<'_, str> = Cow::Borrowed(text);
    let steps: [(&Regex, &Replacer); 4] = [
        (&rules.url_credentials, &|c| format!("{}{MASK}@", &c[1])),
        (&rules.named, &|c| format!("{}{MASK}", &c[1])),
        (&rules.bearer, &|c| format!("{} {MASK}", &c[1])),
        (&rules.tokens, &|_| MASK.to_owned()),
    ];
    for (regex, replace) in steps {
        if regex.is_match(&current) {
            current = Cow::Owned(regex.replace_all(&current, |c: &Captures| replace(c)).into_owned());
        }
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(text: &str) -> String {
        redact(text).into_owned()
    }

    #[test]
    fn prefixed_tokens_are_masked() {
        for secret in [
            "ghp_0123456789abcdefghijABCDEFGHIJ012345", // scan:allow
            "gho_0123456789abcdefghijABCDEFGHIJ012345",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", // scan:allow
            "lin_api_0123456789abcdefABCDEF",
            "sk-ant-api03-0123456789abcdefghij",
            "sk-0123456789abcdefghijklmn", // scan:allow
            "xoxb-1234567890-abcdef",      // scan:allow
            "AKIAABCDEFGHIJKLMNOP",        // scan:allow
        ] {
            let line = format!("failed with {secret} in header");
            let out = clean(&line);
            assert!(!out.contains(secret), "{secret} leaked: {out}");
            assert!(out.contains(MASK));
        }
    }

    #[test]
    fn authorization_and_bearer_credentials_are_masked() {
        assert_eq!(
            clean("Authorization: Bearer abcdef123456"),
            format!("Authorization: {MASK}")
        );
        assert_eq!(
            clean("curl -H 'authorization: token ghx12345678'"),
            format!("curl -H 'authorization: {MASK}'")
        );
        assert_eq!(
            clean("sent Bearer abcdef123456 to server"),
            format!("sent Bearer {MASK} to server")
        );
        assert_eq!(clean("Basic dXNlcjpwYXNz"), format!("Basic {MASK}"));
    }

    #[test]
    fn passwords_in_urls_are_masked_but_plain_urls_stay() {
        assert_eq!(
            clean("clone https://me:hunter2@github.com/o/r.git"),
            format!("clone https://{MASK}@github.com/o/r.git")
        );
        assert_eq!(clean("ssh://git:pw@host:22/x"), format!("ssh://{MASK}@host:22/x"));
        let plain = "fetch https://github.com/o/r.git and git@github.com:o/r.git";
        assert_eq!(clean(plain), plain);
    }

    #[test]
    fn named_pairs_are_masked_in_every_common_shape() {
        assert_eq!(clean("password=hunter2 next"), format!("password={MASK} next"));
        assert_eq!(clean("PASSWORD: hunter2"), format!("PASSWORD: {MASK}"));
        assert_eq!(
            clean(r#"{"api_key":"abc123","x":1}"#),
            format!(r#"{{"api_key":"{MASK}","x":1}}"#)
        );
        assert_eq!(
            clean("access_token=abcdef&other=1"),
            format!("access_token={MASK}&other=1")
        );
        assert_eq!(clean("client_secret = 'xyz'"), format!("client_secret = '{MASK}'"));
        assert_eq!(clean("TESSERA_TOKEN=abc"), format!("TESSERA_TOKEN={MASK}"));
        assert_eq!(clean("AWS_SECRET_KEY=abc"), format!("AWS_SECRET_KEY={MASK}"));
        assert_eq!(clean("GITHUB_TOKEN: x1"), format!("GITHUB_TOKEN: {MASK}"));
    }

    #[test]
    fn ordinary_text_is_untouched_and_borrowed() {
        for text in [
            "tokens used: 1200 (max_tokens=4096)",
            "the password prompt was shown",
            "key bindings loaded; secret santa",
            "Started task Fix login on branch tessera/fix-login",
            "ssh user@host:22 connected",
            "",
        ] {
            assert!(matches!(redact(text), Cow::Borrowed(_)), "{text}");
        }
    }

    #[test]
    fn several_secrets_in_one_line_all_go() {
        let out = clean("a ghp_0123456789abcdefghijABCDEFGHIJ012345 b password=x c https://u:p@h/ d"); // scan:allow
        assert_eq!(out.matches(MASK).count(), 3, "{out}");
    }

    #[test]
    fn unicode_text_survives() {
        assert_eq!(clean("ملف تم password=سر ✓"), format!("ملف تم password={MASK} ✓"));
    }
}
