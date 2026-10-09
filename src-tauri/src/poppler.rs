//! Locates the poppler command-line tools used for every PDF operation.
//!
//! Release builds ship `pdftotext` and `pdftoppm` under the app's resources in `poppler/bin/`,
//! with their libraries in `poppler/lib/`. Without that bundle, as in development, the tools are
//! looked up on `PATH`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum PopplerError {
    #[error("{0} not found; install poppler")]
    Missing(String),
    #[error("{0}")]
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Poppler {
    pub pdftotext: PathBuf,
    pub pdftoppm: PathBuf,
    pub bundled: bool,
}

/// What the Settings window shows about the PDF tools.
#[derive(Debug, Clone, Serialize)]
pub struct PopplerStatus {
    pub version: String,
    pub bundled: bool,
}

impl Poppler {
    /// Picks the bundled tools when both exist under `resource_dir`, otherwise the ones on `PATH`.
    pub fn resolve(resource_dir: Option<&Path>) -> Poppler {
        if let Some(dir) = resource_dir {
            let bin = dir.join("poppler").join("bin");
            let pdftotext = bin.join(executable("pdftotext"));
            let pdftoppm = bin.join(executable("pdftoppm"));
            if pdftotext.is_file() && pdftoppm.is_file() {
                return Poppler {
                    pdftotext,
                    pdftoppm,
                    bundled: true,
                };
            }
        }
        Poppler {
            pdftotext: PathBuf::from(executable("pdftotext")),
            pdftoppm: PathBuf::from(executable("pdftoppm")),
            bundled: false,
        }
    }

    /// Runs `pdftotext -v`, which prints the poppler version on stderr.
    pub fn status(&self) -> Result<PopplerStatus, PopplerError> {
        let output =
            Command::new(&self.pdftotext)
                .arg("-v")
                .output()
                .map_err(|error| match error.kind() {
                    std::io::ErrorKind::NotFound => PopplerError::Missing("pdftotext".into()),
                    _ => PopplerError::Failed(error.to_string()),
                })?;
        let text = String::from_utf8_lossy(&output.stderr);
        let version = text
            .lines()
            .find_map(|line| line.strip_prefix("pdftotext version "))
            .ok_or_else(|| {
                PopplerError::Failed(format!("unexpected pdftotext output: {}", text.trim()))
            })?;
        Ok(PopplerStatus {
            version: version.trim().to_string(),
            bundled: self.bundled,
        })
    }
}

fn executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn prefers_the_bundled_tools() {
        let resources = tempfile::tempdir().unwrap();
        let bin = resources.path().join("poppler/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join(executable("pdftotext")), b"").unwrap();
        fs::write(bin.join(executable("pdftoppm")), b"").unwrap();

        let poppler = Poppler::resolve(Some(resources.path()));
        assert!(poppler.bundled);
        assert_eq!(poppler.pdftotext, bin.join(executable("pdftotext")));
        assert_eq!(poppler.pdftoppm, bin.join(executable("pdftoppm")));
    }

    #[test]
    fn falls_back_to_path_when_the_bundle_is_incomplete() {
        let resources = tempfile::tempdir().unwrap();
        let bin = resources.path().join("poppler/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join(executable("pdftotext")), b"").unwrap();

        let poppler = Poppler::resolve(Some(resources.path()));
        assert!(!poppler.bundled);
        assert_eq!(poppler.pdftotext, PathBuf::from(executable("pdftotext")));
    }

    #[test]
    fn reports_a_missing_binary() {
        let poppler = Poppler {
            pdftotext: PathBuf::from("/nonexistent/pdftotext"),
            pdftoppm: PathBuf::from("/nonexistent/pdftoppm"),
            bundled: false,
        };
        assert!(matches!(poppler.status(), Err(PopplerError::Missing(_))));
    }
}
