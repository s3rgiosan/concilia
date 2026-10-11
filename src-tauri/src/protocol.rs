//! The `receipt://` URI scheme: serves receipt files from the receipts root to the webview.
//!
//! The request path is the percent-encoded period-relative path, such as
//! `2025%2F01%2Freceipts%2Fshop.pdf`. Only files under a period's `receipts/` or
//! `reimbursements/` folder whose real path stays inside that folder and has an allowlisted
//! extension are served. The file opened must be the one checked, and responses carry an
//! `ETag` so an unchanged receipt is not sent again.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "receipt";

/// Keeps an image receipt from running scripts or loading anything.
const IMAGE_CONTENT_SECURITY_POLICY: &str = "sandbox; default-src 'none'";
/// Keeps a PDF receipt from loading anything. WebKit shows no PDF in a sandboxed document, so
/// PDFs go without `sandbox`.
const PDF_CONTENT_SECURITY_POLICY: &str = "default-src 'none'";

fn content_security_policy(content_type: &str) -> &'static str {
    match content_type {
        "application/pdf" => PDF_CONTENT_SECURITY_POLICY,
        _ => IMAGE_CONTENT_SECURITY_POLICY,
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("malformed receipt path")]
    BadRequest,
    #[error("receipt path is outside the period's receipt folders")]
    Forbidden,
    #[error("receipt not found")]
    NotFound,
    #[error("unsupported receipt type")]
    UnsupportedType,
    #[error("receipts folder is not configured")]
    NotConfigured,
    #[error("receipt is larger than 50 MB")]
    TooLarge,
}

impl ProtocolError {
    fn status(&self) -> StatusCode {
        match self {
            ProtocolError::BadRequest | ProtocolError::UnsupportedType => StatusCode::BAD_REQUEST,
            ProtocolError::Forbidden => StatusCode::FORBIDDEN,
            ProtocolError::NotFound => StatusCode::NOT_FOUND,
            ProtocolError::NotConfigured => StatusCode::SERVICE_UNAVAILABLE,
            ProtocolError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        }
    }
}

/// Which file a path led to when it was checked, to compare with the file later opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    device: u64,
    inode: u64,
}

impl FileIdentity {
    #[cfg(unix)]
    fn of(metadata: &std::fs::Metadata) -> FileIdentity {
        use std::os::unix::fs::MetadataExt;
        FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }

    /// Platforms without inode numbers compare nothing.
    #[cfg(not(unix))]
    fn of(_metadata: &std::fs::Metadata) -> FileIdentity {
        FileIdentity {
            device: 0,
            inode: 0,
        }
    }
}

/// A receipt file that passed every check, with the content type to serve it as.
#[derive(Debug, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    pub content_type: &'static str,
    pub identity: FileIdentity,
}

/// What to answer a request for a resolved receipt with.
#[derive(Debug, PartialEq, Eq)]
pub enum Served {
    /// The file, with its content type and validator.
    File {
        content_type: &'static str,
        etag: String,
        body: Vec<u8>,
    },
    /// The copy the webview holds is current.
    NotModified {
        content_type: &'static str,
        etag: String,
    },
}

/// Maps a request path to a receipt file under `root`, enforcing the sandbox rules.
pub fn resolve(root: &Path, uri_path: &str) -> Result<Resolved, ProtocolError> {
    let encoded = uri_path.strip_prefix('/').unwrap_or(uri_path);
    let decoded = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| ProtocolError::BadRequest)?;
    let relative = Path::new(decoded.as_ref());

    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str().ok_or(ProtocolError::BadRequest)?),
            _ => return Err(ProtocolError::BadRequest),
        }
    }
    let [year, month, folder, rest @ ..] = parts.as_slice() else {
        return Err(ProtocolError::BadRequest);
    };
    if !is_year(year) || !is_month(month) || rest.is_empty() {
        return Err(ProtocolError::BadRequest);
    }
    match *folder {
        "receipts" | "reimbursements" => {}
        _ => return Err(ProtocolError::Forbidden),
    }

    let period = root.join(year).join(month);
    let folder_real = period
        .join(folder)
        .canonicalize()
        .map_err(|_| ProtocolError::NotFound)?;
    let file_real = period
        .join(
            relative
                .strip_prefix(Path::new(year).join(month))
                .map_err(|_| ProtocolError::BadRequest)?,
        )
        .canonicalize()
        .map_err(|_| ProtocolError::NotFound)?;
    if !file_real.starts_with(&folder_real) {
        return Err(ProtocolError::Forbidden);
    }
    let metadata = std::fs::metadata(&file_real).map_err(|_| ProtocolError::NotFound)?;
    if !metadata.is_file() {
        return Err(ProtocolError::Forbidden);
    }

    let content_type = content_type(&file_real).ok_or(ProtocolError::UnsupportedType)?;
    Ok(Resolved {
        path: file_real,
        content_type,
        identity: FileIdentity::of(&metadata),
    })
}

/// Opens the resolved file, checks it is still the file `resolve` checked, and reads it,
/// unless `if_none_match` already names its current version.
pub fn serve(resolved: &Resolved, if_none_match: Option<&str>) -> Result<Served, ProtocolError> {
    let file = std::fs::File::open(&resolved.path).map_err(|_| ProtocolError::NotFound)?;
    let metadata = file.metadata().map_err(|_| ProtocolError::NotFound)?;
    if !metadata.is_file() || FileIdentity::of(&metadata) != resolved.identity {
        return Err(ProtocolError::Forbidden);
    }
    if metadata.len() > crate::filecheck::MAX_INPUT_BYTES {
        return Err(ProtocolError::TooLarge);
    }
    let etag = etag(&metadata);
    if if_none_match.is_some_and(|header| etag_matches(header, &etag)) {
        return Ok(Served::NotModified {
            content_type: resolved.content_type,
            etag,
        });
    }
    let mut body = Vec::with_capacity(metadata.len() as usize);
    file.take(crate::filecheck::MAX_INPUT_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| ProtocolError::NotFound)?;
    if body.len() as u64 > crate::filecheck::MAX_INPUT_BYTES {
        return Err(ProtocolError::TooLarge);
    }
    Ok(Served::File {
        content_type: resolved.content_type,
        etag,
        body,
    })
}

/// A validator from the file's size and modification time.
fn etag(metadata: &std::fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("\"{:x}-{modified:x}\"", metadata.len())
}

/// Whether an `If-None-Match` header lists `etag`, or is `*`.
fn etag_matches(header: &str, etag: &str) -> bool {
    header.split(',').map(str::trim).any(|tag| {
        let tag = tag.strip_prefix("W/").unwrap_or(tag);
        tag == "*" || tag == etag
    })
}

/// Serves one `receipt://` request off the main thread.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let root = ctx
        .app_handle()
        .try_state::<Arc<crate::app::AppState>>()
        .and_then(|state| state.receipts_root());
    let path = request.uri().path().to_string();
    let if_none_match = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    tauri::async_runtime::spawn_blocking(move || {
        let result = root
            .ok_or(ProtocolError::NotConfigured)
            .and_then(|root| resolve(&root, &path))
            .and_then(|resolved| serve(&resolved, if_none_match.as_deref()));
        responder.respond(response(result));
    });
}

/// The response for a served receipt or a refusal. Receipts carry headers that keep the
/// webview from sniffing another type or running anything inside them.
pub fn response(result: Result<Served, ProtocolError>) -> Response<Vec<u8>> {
    let receipt = |status: StatusCode, content_type: &str, etag: &str| {
        Response::builder()
            .status(status)
            .header(header::CACHE_CONTROL, "private, max-age=300")
            .header(header::ETAG, etag)
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(
                header::CONTENT_SECURITY_POLICY,
                content_security_policy(content_type),
            )
    };
    let built = match result {
        Ok(Served::File {
            content_type,
            etag,
            body,
        }) => receipt(StatusCode::OK, content_type, &etag)
            .header(header::CONTENT_TYPE, content_type)
            .body(body),
        Ok(Served::NotModified { content_type, etag }) => {
            receipt(StatusCode::NOT_MODIFIED, content_type, &etag).body(Vec::new())
        }
        Err(error) => {
            log::debug!("receipt request refused: {error}");
            Response::builder()
                .status(error.status())
                .header(header::CONTENT_TYPE, "text/plain")
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .body(error.to_string().into_bytes())
        }
    };
    built.unwrap_or_else(|_| Response::new(Vec::new()))
}

fn is_year(value: &str) -> bool {
    value.len() == 4 && value.bytes().all(|b| b.is_ascii_digit())
}

fn is_month(value: &str) -> bool {
    matches!(value.parse::<u8>(), Ok(1..=12)) && value.len() == 2
}

fn content_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "pdf" => Some("application/pdf"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn period(root: &Path) -> PathBuf {
        let dir = root.join("2030").join("03");
        fs::create_dir_all(dir.join("receipts").join("nested")).unwrap();
        fs::create_dir_all(dir.join("reimbursements")).unwrap();
        fs::create_dir_all(dir.join("docs")).unwrap();
        dir
    }

    #[test]
    fn serves_a_receipt_with_its_content_type() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        fs::write(dir.join("receipts/nested/acme.PDF"), b"%PDF").unwrap();

        let resolved = resolve(root.path(), "/2030%2F03%2Freceipts%2Fnested%2Facme.PDF").unwrap();
        assert_eq!(resolved.content_type, "application/pdf");
        assert!(resolved.path.ends_with("receipts/nested/acme.PDF"));
    }

    #[test]
    fn serves_reimbursement_images() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        fs::write(dir.join("reimbursements/taxi.jpeg"), b"jpg").unwrap();

        let resolved = resolve(root.path(), "/2030/03/reimbursements/taxi.jpeg").unwrap();
        assert_eq!(resolved.content_type, "image/jpeg");
    }

    #[test]
    fn refuses_other_period_folders() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        fs::write(dir.join("docs/match-result.json"), b"{}").unwrap();

        let error = resolve(root.path(), "/2030/03/docs/match-result.json").unwrap_err();
        assert_eq!(error, ProtocolError::Forbidden);
    }

    #[test]
    fn refuses_parent_components() {
        let root = tempfile::tempdir().unwrap();
        period(root.path());

        let error = resolve(root.path(), "/2030%2F03%2Freceipts%2F..%2Fdocs%2Fx.pdf").unwrap_err();
        assert_eq!(error, ProtocolError::BadRequest);
    }

    #[test]
    fn refuses_malformed_periods() {
        let root = tempfile::tempdir().unwrap();
        period(root.path());

        for path in [
            "/30/03/receipts/a.pdf",
            "/2030/13/receipts/a.pdf",
            "/2030/3/receipts/a.pdf",
            "/2030/03/receipts",
        ] {
            assert_eq!(
                resolve(root.path(), path).unwrap_err(),
                ProtocolError::BadRequest,
                "{path}"
            );
        }
    }

    #[test]
    fn refuses_unsupported_extensions() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        fs::write(dir.join("receipts/notes.txt"), b"text").unwrap();

        let error = resolve(root.path(), "/2030/03/receipts/notes.txt").unwrap_err();
        assert_eq!(error, ProtocolError::UnsupportedType);
    }

    #[test]
    fn reports_missing_files() {
        let root = tempfile::tempdir().unwrap();
        period(root.path());

        let error = resolve(root.path(), "/2030/03/receipts/missing.pdf").unwrap_err();
        assert_eq!(error, ProtocolError::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_receipt_named_symlink_to_another_type() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        fs::write(dir.join("receipts/run.command"), b"#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink(dir.join("receipts/run.command"), dir.join("receipts/a.pdf"))
            .unwrap();

        let error = resolve(root.path(), "/2030/03/receipts/a.pdf").unwrap_err();
        assert_eq!(error, ProtocolError::UnsupportedType);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_into_other_period_folders() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        fs::write(dir.join("docs/report.pdf"), b"%PDF").unwrap();
        std::os::unix::fs::symlink(dir.join("docs/report.pdf"), dir.join("receipts/a.pdf"))
            .unwrap();

        let error = resolve(root.path(), "/2030/03/receipts/a.pdf").unwrap_err();
        assert_eq!(error, ProtocolError::Forbidden);
    }

    #[test]
    fn serves_the_file_with_an_etag_and_honours_if_none_match() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        fs::write(dir.join("receipts/acme.pdf"), b"%PDF-1.4").unwrap();
        let resolved = resolve(root.path(), "/2030/03/receipts/acme.pdf").unwrap();

        let Served::File { body, etag, .. } = serve(&resolved, None).unwrap() else {
            panic!("expected the file");
        };
        assert_eq!(body, b"%PDF-1.4");
        assert!(etag.starts_with("\"8-"), "{etag}");
        let not_modified = Served::NotModified {
            content_type: "application/pdf",
            etag: etag.clone(),
        };
        assert_eq!(
            serve(&resolved, Some(&format!("\"other\", {etag}"))).unwrap(),
            not_modified
        );
        assert_eq!(
            serve(&resolved, Some(&format!("W/{etag}"))).unwrap(),
            not_modified
        );
        assert!(matches!(
            serve(&resolved, Some("\"stale\"")).unwrap(),
            Served::File { .. }
        ));
    }

    #[test]
    fn refuses_a_file_replaced_after_the_check() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        let file = dir.join("receipts/acme.pdf");
        fs::write(&file, b"%PDF-1.4").unwrap();
        let resolved = resolve(root.path(), "/2030/03/receipts/acme.pdf").unwrap();
        fs::remove_file(&file).unwrap();
        fs::write(dir.join("receipts/other.pdf"), b"%PDF-1.4 other").unwrap();
        fs::rename(dir.join("receipts/other.pdf"), &file).unwrap();

        if cfg!(unix) {
            assert_eq!(serve(&resolved, None), Err(ProtocolError::Forbidden));
        }
    }

    #[test]
    fn receipt_responses_carry_security_headers() {
        let ok = response(Ok(Served::File {
            content_type: "application/pdf",
            etag: "\"8-1\"".into(),
            body: b"%PDF".to_vec(),
        }));
        assert_eq!(ok.status(), StatusCode::OK);
        let headers = ok.headers();
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'"
        );
        assert_eq!(headers[header::ETAG], "\"8-1\"");
        assert_eq!(headers[header::CONTENT_TYPE], "application/pdf");

        let image = response(Ok(Served::File {
            content_type: "image/png",
            etag: "\"8-1\"".into(),
            body: b"png".to_vec(),
        }));
        assert_eq!(
            image.headers()[header::CONTENT_SECURITY_POLICY],
            "sandbox; default-src 'none'"
        );

        let cached = response(Ok(Served::NotModified {
            content_type: "image/jpeg",
            etag: "\"8-1\"".into(),
        }));
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        assert!(cached.body().is_empty());

        let refused = response(Err(ProtocolError::Forbidden));
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_eq!(refused.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_escape_the_period() {
        let root = tempfile::tempdir().unwrap();
        let dir = period(root.path());
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.pdf"), b"%PDF").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.pdf"),
            dir.join("receipts/link.pdf"),
        )
        .unwrap();

        let error = resolve(root.path(), "/2030/03/receipts/link.pdf").unwrap_err();
        assert_eq!(error, ProtocolError::Forbidden);
    }
}
