//! Finding receipt files and judging whether a PDF's text layer is usable.

use std::path::Path;

use crate::text::{is_js_whitespace, js_len, js_trim};

/// File extensions treated as receipts, compared case-insensitively.
const RECEIPT_EXTENSIONS: &[&str] = &["pdf", "jpg", "jpeg", "png"];

/// Folders Finalize sorts receipts into; the walk skips them at the top level only.
pub const STATUS_FOLDERS: &[&str] = &["_matched", "_review", "_unmatched"];

/// Whether a file name has a receipt extension.
pub fn is_receipt_name(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| RECEIPT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Every receipt file under `root`, sorted. Symlinks and the status folders directly under
/// `root` are skipped; a missing `root` yields nothing.
pub fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if file_type.is_dir() {
                if dir == root && STATUS_FOLDERS.contains(&name.as_ref()) {
                    continue;
                }
                stack.push(entry.path());
            } else if file_type.is_file() && is_receipt_name(&name) {
                out.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    out.sort();
    out
}

/// Whether text from a PDF's text layer is worth sending to Gemini: more than ten characters, at least one digit, and, past fifty letters, no single letter making up
/// more than 60% of them (a sign of a broken font encoding).
pub fn is_usable_pdf_text(text: &str) -> bool {
    let length = js_len(js_trim(text));
    if length <= 10 {
        return false;
    }
    let stripped: String = text.chars().filter(|c| !is_js_whitespace(*c)).collect();
    if stripped.is_empty() || !stripped.bytes().any(|b| b.is_ascii_digit()) {
        return false;
    }
    let letters: Vec<u8> = stripped
        .bytes()
        .filter(u8::is_ascii_alphabetic)
        .map(|b| b.to_ascii_lowercase())
        .collect();
    if letters.len() > 50 {
        let mut counts = [0usize; 26];
        for b in &letters {
            counts[usize::from(b - b'a')] += 1;
        }
        let max = counts.iter().copied().max().unwrap_or(0);
        if max as f64 / letters.len() as f64 > 0.6 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn walks_receipts_skipping_top_level_status_folders() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        for dir in ["_matched", "nested/_matched", "sub"] {
            fs::create_dir_all(r.join(dir)).unwrap();
        }
        for file in [
            "b.PDF",
            "a.jpg",
            "notes.txt",
            "_matched/skip.pdf",
            "nested/_matched/keep.png",
            "sub/c.jpeg",
            "noext",
        ] {
            fs::write(r.join(file), b"x").unwrap();
        }

        let found: Vec<String> = walk(r)
            .into_iter()
            .map(|p| {
                p.strip_prefix(&format!("{}/", r.display()))
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            found,
            ["a.jpg", "b.PDF", "nested/_matched/keep.png", "sub/c.jpeg"]
        );
    }

    #[test]
    fn walking_a_missing_folder_finds_nothing() {
        assert!(walk(Path::new("/nonexistent/concilia/receipts")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("real.pdf"), b"x").unwrap();
        std::os::unix::fs::symlink(root.path().join("real.pdf"), root.path().join("link.pdf"))
            .unwrap();
        assert_eq!(walk(root.path()).len(), 1);
    }

    #[test]
    fn accepts_receipt_like_text() {
        assert!(is_usable_pdf_text("ACME CORP\nTOTAL 10,00 EUR\n"));
    }

    #[test]
    fn rejects_short_or_digitless_text() {
        assert!(!is_usable_pdf_text("  10,00  "));
        assert!(!is_usable_pdf_text("ACME CORP RECEIPT WITHOUT NUMBERS"));
    }

    #[test]
    fn rejects_text_dominated_by_one_letter() {
        let garbled = format!("{} 10", "x".repeat(60));
        assert!(!is_usable_pdf_text(&garbled));
        let fifty = format!("{} 10", "x".repeat(50));
        assert!(is_usable_pdf_text(&fifty));
    }
}
