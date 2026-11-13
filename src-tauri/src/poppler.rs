//! Locates the poppler command-line tools used for every PDF operation.
//!
//! Release builds ship `pdftotext` and `pdftoppm` under the app's resources in `poppler/bin/`,
//! with their libraries in `poppler/lib/`. Without that bundle, as in development, the tools are
//! looked up on `PATH`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Debug, thiserror::Error)]
pub enum PopplerError {
    #[error("{0} not found; install poppler")]
    Missing(String),
    #[error("{0}")]
    Failed(String),
    #[error("{0} produced more output than Concilia reads")]
    TooLarge(&'static str),
}

/// Largest text output accepted from `pdftotext`.
const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;
/// Largest page image accepted from `pdftoppm`.
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// Error output kept from a tool, for the error message.
const MAX_STDERR_BYTES: usize = 16 * 1024;
/// The longest side of a rendered page in pixels: an A4 page at 300 DPI.
pub const MAX_RENDER_PIXELS: u32 = 3508;

static PAGE_SIZE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<page width="([0-9.]+)" height="([0-9.]+)">"#).expect("pattern compiles")
});

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

impl Poppler {
    /// Extracts the text of a PDF with `pdftotext -layout`, keeping column alignment.
    pub async fn text(&self, pdf: &Path) -> Result<String, PopplerError> {
        let pdf = absolute(pdf)?;
        let mut command = tokio::process::Command::new(&self.pdftotext);
        command
            .args(["-layout", "-enc", "UTF-8", "--"])
            .arg(&pdf)
            .arg("-");
        let stdout = run_bounded(command, "pdftotext", MAX_TEXT_BYTES).await?;
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }

    /// The size of a page in points, read from `pdftotext -bbox`.
    async fn page_size(&self, pdf: &Path, page: u32) -> Result<(f64, f64), PopplerError> {
        let page = page.to_string();
        let mut command = tokio::process::Command::new(&self.pdftotext);
        command
            .args(["-bbox", "-f", &page, "-l", &page, "--"])
            .arg(pdf)
            .arg("-");
        let stdout = run_bounded(command, "pdftotext", MAX_TEXT_BYTES).await?;
        parse_page_size(&String::from_utf8_lossy(&stdout))
            .ok_or_else(|| PopplerError::Failed("pdftotext reported no page size".into()))
    }

    /// Renders one page of a PDF to PNG bytes with `pdftoppm`, at `dpi` or lower, so that
    /// neither side exceeds `MAX_RENDER_PIXELS`.
    pub async fn render_page(
        &self,
        pdf: &Path,
        page: u32,
        dpi: u32,
    ) -> Result<Vec<u8>, PopplerError> {
        let pdf = absolute(pdf)?;
        let scale = match self.page_size(&pdf, page).await {
            Ok((width, height)) => Scale::Dpi(capped_dpi(width, height, dpi)),
            Err(PopplerError::Missing(tool)) => return Err(PopplerError::Missing(tool)),
            Err(error) => {
                log::debug!("page size unknown, fitting the render to the pixel cap: {error}");
                Scale::Fit
            }
        };
        let dir = tempfile::tempdir().map_err(|e| PopplerError::Failed(e.to_string()))?;
        let prefix = dir.path().join("page");
        let mut command = tokio::process::Command::new(&self.pdftoppm);
        command.arg("-png");
        match scale {
            Scale::Dpi(dpi) => command.args(["-r", &format!("{dpi:.2}")]),
            Scale::Fit => command.args(["-scale-to", &MAX_RENDER_PIXELS.to_string()]),
        };
        command
            .args(["-f", &page.to_string(), "-l", &page.to_string()])
            .args(["-singlefile", "--"])
            .arg(&pdf)
            .arg(&prefix);
        run_bounded(command, "pdftoppm", MAX_TEXT_BYTES).await?;
        let image = prefix.with_extension("png");
        let size = tokio::fs::metadata(&image)
            .await
            .map_err(|e| PopplerError::Failed(format!("pdftoppm wrote no image: {e}")))?
            .len();
        if size > MAX_IMAGE_BYTES {
            return Err(PopplerError::TooLarge("pdftoppm"));
        }
        tokio::fs::read(&image)
            .await
            .map_err(|e| PopplerError::Failed(format!("pdftoppm wrote no image: {e}")))
    }
}

/// How a page is scaled for rendering.
enum Scale {
    Dpi(f64),
    /// Fit within `MAX_RENDER_PIXELS` on both sides, for a page of unknown size.
    Fit,
}

/// `dpi`, lowered when the page's longest side would exceed `MAX_RENDER_PIXELS`.
pub fn capped_dpi(width_pt: f64, height_pt: f64, dpi: u32) -> f64 {
    let longest = width_pt.max(height_pt);
    let wanted = f64::from(dpi);
    if longest <= 0.0 || !longest.is_finite() {
        return wanted;
    }
    let cap = f64::from(MAX_RENDER_PIXELS) * 72.0 / longest;
    // Two decimals reach pdftoppm; rounding down keeps the image inside the cap.
    (wanted.min(cap) * 100.0).floor() / 100.0
}

/// The first page size in `pdftotext -bbox` output, in points.
fn parse_page_size(bbox: &str) -> Option<(f64, f64)> {
    let captures = PAGE_SIZE.captures(bbox)?;
    let width = captures[1].parse().ok()?;
    let height = captures[2].parse().ok()?;
    Some((width, height))
}

/// The path made absolute, so the tools never read it as an option.
fn absolute(path: &Path) -> Result<PathBuf, PopplerError> {
    std::path::absolute(path).map_err(|e| PopplerError::Failed(format!("{}: {e}", path.display())))
}

/// Reads at most `limit` bytes from `reader`, plus one to tell an overflow apart.
async fn read_capped(reader: impl AsyncRead + Unpin, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut buffer = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut buffer)
        .await?;
    Ok(buffer)
}

/// Reads all of `reader`, keeping the first `keep` bytes, so the writer never blocks.
async fn drain(mut reader: impl AsyncRead + Unpin, keep: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 8192];
    while let Ok(read @ 1..) = reader.read(&mut chunk).await {
        let room = keep.saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..read.min(room)]);
    }
    kept
}

/// Runs a tool and returns its standard output, stopping it once the output passes `limit`
/// bytes.
async fn run_bounded(
    mut command: tokio::process::Command,
    tool: &'static str,
    limit: usize,
) -> Result<Vec<u8>, PopplerError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| spawn_error(tool, e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| PopplerError::Failed(format!("{tool} stdout unavailable")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| PopplerError::Failed(format!("{tool} stderr unavailable")))?;
    let errors = tokio::spawn(drain(stderr, MAX_STDERR_BYTES));
    let output = read_capped(stdout, limit).await;
    let too_large = output.as_ref().is_ok_and(|out| out.len() > limit);
    if too_large {
        let _ = child.kill().await;
    }
    let status = child
        .wait()
        .await
        .map_err(|e| PopplerError::Failed(e.to_string()))?;
    let stderr = errors.await.unwrap_or_default();
    if too_large {
        return Err(PopplerError::TooLarge(tool));
    }
    let output = output.map_err(|e| PopplerError::Failed(e.to_string()))?;
    if !status.success() {
        return Err(PopplerError::Failed(format!(
            "{tool} exited with {status}: {}",
            String::from_utf8_lossy(&stderr).trim()
        )));
    }
    Ok(output)
}

fn spawn_error(tool: &str, error: std::io::Error) -> PopplerError {
    match error.kind() {
        std::io::ErrorKind::NotFound => PopplerError::Missing(tool.into()),
        _ => PopplerError::Failed(error.to_string()),
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
    fn caps_the_render_resolution_by_the_longest_side() {
        // A4 at 300 DPI is the cap itself.
        let a4 = capped_dpi(595.0, 842.0, 300);
        assert!((299.0..=300.0).contains(&a4), "{a4}");
        assert!(842.0 * a4 / 72.0 <= f64::from(MAX_RENDER_PIXELS));
        // A small receipt keeps its resolution.
        assert_eq!(capped_dpi(227.0, 567.0, 300), 300.0);
        // A poster is rendered at a lower resolution.
        let poster = capped_dpi(2000.0, 3000.0, 300);
        assert!(3000.0 * poster / 72.0 <= f64::from(MAX_RENDER_PIXELS));
        assert!(poster > 80.0);
        // A landscape page is capped by its width.
        assert_eq!(capped_dpi(3000.0, 2000.0, 300), poster);
        assert_eq!(capped_dpi(0.0, 0.0, 300), 300.0);
    }

    #[test]
    fn reads_the_page_size_from_bbox_output() {
        let bbox = r#"<doc>
  <page width="595.276000" height="841.890000">
    <word xMin="1" yMin="2" xMax="3" yMax="4">ACME</word>
  </page>
</doc>"#;
        assert_eq!(parse_page_size(bbox), Some((595.276, 841.89)));
        assert_eq!(parse_page_size("<doc></doc>"), None);
    }

    #[test]
    fn passes_file_names_as_absolute_paths() {
        let path = absolute(Path::new("-v.pdf")).unwrap();
        assert!(path.is_absolute());
        assert!(!path.to_string_lossy().starts_with('-'));
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
