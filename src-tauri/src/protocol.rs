//! The `receipt://` URI scheme: serves receipt files from the receipts root to the webview.
//!
//! The request path is the percent-encoded period-relative path, such as
//! `2025%2F01%2Freceipts%2Fshop.pdf`. Only files under a period's `receipts/` or
//! `reimbursements/` folder, with an allowlisted extension, whose real path stays inside the
//! period folder, are served.

use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "receipt";

/// The folder holding the `<year>/<month>/` period folders, or none until it is configured.
#[derive(Default)]
pub struct ReceiptsRoot(pub RwLock<Option<PathBuf>>);

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
}

impl ProtocolError {
    fn status(&self) -> StatusCode {
        match self {
            ProtocolError::BadRequest | ProtocolError::UnsupportedType => StatusCode::BAD_REQUEST,
            ProtocolError::Forbidden => StatusCode::FORBIDDEN,
            ProtocolError::NotFound => StatusCode::NOT_FOUND,
            ProtocolError::NotConfigured => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

/// A receipt file that passed every check, with the content type to serve it as.
#[derive(Debug, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    pub content_type: &'static str,
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
    let period_real = period.canonicalize().map_err(|_| ProtocolError::NotFound)?;
    let file_real = period
        .join(
            relative
                .strip_prefix(Path::new(year).join(month))
                .map_err(|_| ProtocolError::BadRequest)?,
        )
        .canonicalize()
        .map_err(|_| ProtocolError::NotFound)?;
    if !file_real.starts_with(&period_real) || !file_real.is_file() {
        return Err(ProtocolError::Forbidden);
    }

    let content_type = content_type(&file_real).ok_or(ProtocolError::UnsupportedType)?;
    Ok(Resolved {
        path: file_real,
        content_type,
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
        .state::<ReceiptsRoot>()
        .0
        .read()
        .ok()
        .and_then(|guard| guard.clone());
    let path = request.uri().path().to_string();
    std::thread::spawn(move || {
        let result = root
            .ok_or(ProtocolError::NotConfigured)
            .and_then(|root| resolve(&root, &path))
            .and_then(|resolved| {
                std::fs::read(&resolved.path)
                    .map(|body| (resolved.content_type, body))
                    .map_err(|_| ProtocolError::NotFound)
            });
        responder.respond(response(result));
    });
}

fn response(result: Result<(&'static str, Vec<u8>), ProtocolError>) -> Response<Vec<u8>> {
    let built = match result {
        Ok((content_type, body)) => Response::builder()
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "private, max-age=300")
            .body(body),
        Err(error) => {
            log::debug!("receipt request refused: {error}");
            Response::builder()
                .status(error.status())
                .header(header::CONTENT_TYPE, "text/plain")
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
