//! A reconciliation period (one month) and where its files live under the receipts root.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("invalid period {year}/{month}")]
pub struct InvalidPeriod {
    pub year: String,
    pub month: String,
}

/// A year (`YYYY`) and month (`01`–`12`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Period {
    year: String,
    month: String,
}

impl Period {
    pub fn parse(year: &str, month: &str) -> Result<Period, InvalidPeriod> {
        let year_ok = year.len() == 4 && year.bytes().all(|b| b.is_ascii_digit());
        let month_ok = month.len() == 2
            && month.bytes().all(|b| b.is_ascii_digit())
            && matches!(month.parse::<u8>(), Ok(1..=12));
        if year_ok && month_ok {
            Ok(Period {
                year: year.to_string(),
                month: month.to_string(),
            })
        } else {
            Err(InvalidPeriod {
                year: year.to_string(),
                month: month.to_string(),
            })
        }
    }

    pub fn year(&self) -> &str {
        &self.year
    }

    pub fn month(&self) -> &str {
        &self.month
    }

    /// The period's folders under the receipts root.
    pub fn paths(&self, root: &Path) -> PeriodPaths {
        PeriodPaths::new(root.join(&self.year).join(&self.month))
    }
}

impl fmt::Display for Period {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{}", self.year, self.month)
    }
}

/// Folders and files of one period.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeriodPaths {
    pub dir: PathBuf,
    pub receipts: PathBuf,
    pub reimbursements: PathBuf,
    pub docs: PathBuf,
    /// `YYYY/MM`, the period folder relative to the receipts root.
    pub prefix: String,
}

impl PeriodPaths {
    pub fn new(dir: PathBuf) -> PeriodPaths {
        let mut parts = dir
            .iter()
            .rev()
            .take(2)
            .map(|p| p.to_string_lossy().into_owned());
        let month = parts.next().unwrap_or_default();
        let year = parts.next().unwrap_or_default();
        PeriodPaths {
            prefix: format!("{year}/{month}"),
            receipts: dir.join("receipts"),
            reimbursements: dir.join("reimbursements"),
            docs: dir.join("docs"),
            dir,
        }
    }

    /// A file's path relative to the receipts root (`YYYY/MM/...`), or none outside the period.
    pub fn relative(&self, file: &str) -> Option<String> {
        let rest = std::path::Path::new(file).strip_prefix(&self.dir).ok()?;
        let parts: Vec<String> = rest
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        (!parts.is_empty()).then(|| format!("{}/{}", self.prefix, parts.join("/")))
    }

    pub fn transactions(&self) -> PathBuf {
        self.docs.join("transactions.json")
    }

    /// The statements whose transactions `transactions.json` holds.
    pub fn statements(&self) -> PathBuf {
        self.docs.join("statements.json")
    }

    /// The receipt extraction cache.
    pub fn receipts_cache(&self) -> PathBuf {
        self.docs.join("receipts.json")
    }

    pub fn reimbursements_cache(&self) -> PathBuf {
        self.docs.join("reimbursements.json")
    }

    pub fn match_result(&self) -> PathBuf {
        self.docs.join("match-result.json")
    }

    pub fn draft(&self) -> PathBuf {
        self.docs.join("review-draft.json")
    }

    pub fn report(&self) -> PathBuf {
        self.docs.join("report.xlsx")
    }

    /// The receipt moves of a Finalize, Reopen or reset that is not done yet.
    pub fn moves_journal(&self) -> PathBuf {
        self.docs.join("moves.json")
    }

    /// Present once the period has been finalized; holds the ISO timestamp.
    pub fn applied_marker(&self) -> PathBuf {
        self.docs.join(".applied")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_periods() {
        let period = Period::parse("2030", "03").unwrap();
        assert_eq!(period.to_string(), "2030-03");
        assert_eq!(period.year(), "2030");
        assert_eq!(period.month(), "03");
    }

    #[test]
    fn rejects_invalid_periods() {
        for (year, month) in [
            ("30", "03"),
            ("2030", "3"),
            ("2030", "00"),
            ("2030", "13"),
            ("abcd", "01"),
            ("2030", "+1"),
        ] {
            assert!(Period::parse(year, month).is_err(), "{year}/{month}");
        }
    }

    #[test]
    fn lays_out_period_files() {
        let paths = Period::parse("2030", "03")
            .unwrap()
            .paths(Path::new("/root"));
        assert_eq!(paths.dir, Path::new("/root/2030/03"));
        assert_eq!(paths.receipts, Path::new("/root/2030/03/receipts"));
        assert_eq!(
            paths.match_result(),
            Path::new("/root/2030/03/docs/match-result.json")
        );
        assert_eq!(
            paths.applied_marker(),
            Path::new("/root/2030/03/docs/.applied")
        );
        assert_eq!(paths.prefix, "2030/03");
        assert_eq!(
            paths
                .relative("/root/2030/03/receipts/sub/acme.pdf")
                .as_deref(),
            Some("2030/03/receipts/sub/acme.pdf")
        );
        assert_eq!(paths.relative("/root/2030/04/receipts/acme.pdf"), None);
    }
}
