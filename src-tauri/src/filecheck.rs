//! Checks a statement or receipt file before it is parsed or sent: its size, and that its first
//! bytes are those of a PDF, PNG or JPEG file.

use std::path::Path;

use tokio::io::AsyncReadExt;

/// Largest statement or receipt file read.
pub const MAX_INPUT_BYTES: u64 = 50 * 1024 * 1024;

/// How far into a file the PDF header may start.
const HEADER_BYTES: usize = 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const JPEG_SIGNATURE: &[u8] = b"\xFF\xD8\xFF";
const PDF_SIGNATURE: &[u8] = b"%PDF-";

/// What a file's first bytes say it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Pdf,
    Png,
    Jpeg,
}

impl FileKind {
    pub fn mime_type(self) -> &'static str {
        match self {
            FileKind::Pdf => "application/pdf",
            FileKind::Png => "image/png",
            FileKind::Jpeg => "image/jpeg",
        }
    }

    pub fn is_image(self) -> bool {
        matches!(self, FileKind::Png | FileKind::Jpeg)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FileCheckError {
    #[error("{0} is larger than 50 MB")]
    TooLarge(String),
    #[error("{0} is not a PDF, PNG or JPEG file")]
    Unrecognized(String),
    #[error("{0}: {1}")]
    Io(String, String),
}

impl FileCheckError {
    /// The code the frontend words this case by; none for a read failure.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            FileCheckError::TooLarge(_) => Some("file_too_large"),
            FileCheckError::Unrecognized(_) => Some("unrecognized_file"),
            FileCheckError::Io(..) => None,
        }
    }
}

/// The kind of file `header` starts, judged by its signature. A PDF header may follow up to
/// 1 KB of other bytes, as PDF readers allow.
pub fn sniff(header: &[u8]) -> Option<FileKind> {
    if header.starts_with(PNG_SIGNATURE) {
        return Some(FileKind::Png);
    }
    if header.starts_with(JPEG_SIGNATURE) {
        return Some(FileKind::Jpeg);
    }
    let window = &header[..header.len().min(HEADER_BYTES)];
    window
        .windows(PDF_SIGNATURE.len())
        .any(|w| w == PDF_SIGNATURE)
        .then_some(FileKind::Pdf)
}

/// Opens `path`, checks it is at most `MAX_INPUT_BYTES`, and returns its kind.
pub async fn inspect(path: &Path) -> Result<FileKind, FileCheckError> {
    let name = path.display().to_string();
    let io = |e: std::io::Error| FileCheckError::Io(name.clone(), e.to_string());
    let file = tokio::fs::File::open(path).await.map_err(io)?;
    let size = file.metadata().await.map_err(io)?.len();
    if size > MAX_INPUT_BYTES {
        return Err(FileCheckError::TooLarge(name));
    }
    let mut header = Vec::with_capacity(HEADER_BYTES);
    file.take(HEADER_BYTES as u64)
        .read_to_end(&mut header)
        .await
        .map_err(io)?;
    sniff(&header).ok_or(FileCheckError::Unrecognized(name))
}

/// Reads a whole file of at most `MAX_INPUT_BYTES`.
pub async fn read_capped(path: &Path) -> Result<Vec<u8>, FileCheckError> {
    let name = path.display().to_string();
    let io = |e: std::io::Error| FileCheckError::Io(name.clone(), e.to_string());
    let file = tokio::fs::File::open(path).await.map_err(io)?;
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(io)?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(FileCheckError::TooLarge(name));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_signatures() {
        assert_eq!(sniff(b"%PDF-1.7\n"), Some(FileKind::Pdf));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest"), Some(FileKind::Png));
        assert_eq!(sniff(b"\xFF\xD8\xFF\xE0rest"), Some(FileKind::Jpeg));
        let mut late = vec![b' '; 1000];
        late.extend_from_slice(b"%PDF-1.4");
        assert_eq!(sniff(&late), Some(FileKind::Pdf));
        let mut too_late = vec![b' '; 1020];
        too_late.extend_from_slice(b"%PDF-1.4");
        assert_eq!(sniff(&too_late), None);
        assert_eq!(sniff(b"#!/bin/sh\necho"), None);
        assert_eq!(sniff(b""), None);
    }

    #[tokio::test]
    async fn inspects_files() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("acme.pdf");
        std::fs::write(&pdf, b"%PDF-1.4\n").unwrap();
        assert_eq!(inspect(&pdf).await, Ok(FileKind::Pdf));

        let script = dir.path().join("fake.pdf");
        std::fs::write(&script, b"#!/bin/sh\n").unwrap();
        let error = inspect(&script).await.unwrap_err();
        assert_eq!(error.code(), Some("unrecognized_file"));

        let missing = inspect(&dir.path().join("missing.pdf")).await.unwrap_err();
        assert_eq!(missing.code(), None);
    }

    #[tokio::test]
    async fn refuses_files_over_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.pdf");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_INPUT_BYTES + 1).unwrap();
        assert_eq!(
            inspect(&big).await,
            Err(FileCheckError::TooLarge(big.display().to_string()))
        );
        assert_eq!(
            read_capped(&big).await,
            Err(FileCheckError::TooLarge(big.display().to_string()))
        );
        file.set_len(MAX_INPUT_BYTES).unwrap();
        assert_eq!(
            read_capped(&big).await.map(|b| b.len() as u64),
            Ok(MAX_INPUT_BYTES)
        );
    }
}
