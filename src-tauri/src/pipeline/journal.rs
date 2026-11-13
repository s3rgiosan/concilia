//! The move journal: the receipt moves of a Finalize, Reopen or reset, written before the first
//! move and deleted when the job is done. It also names the JSON files that the job replaces,
//! each with a backup copy in `docs/`. A journal that a stopped app left behind is undone
//! before the next job on the period, or before the review loads.

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use super::{create_dir, io, PipelineError};
use crate::finalize::{relative_text, Move};
use crate::fsutil::{read_json_opt, remove_if_exists, rename_no_replace, write_atomic, write_json};
use crate::period::PeriodPaths;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Journal {
    /// Whether the period is finalized when the job is done. A period already in this state
    /// finished its job, so its moves stay.
    finalized: bool,
    /// The files of `docs/` that the job replaces, with a backup of each.
    replaced: Vec<Replaced>,
    moves: Vec<JournalMove>,
}

/// A file of `docs/` that a job replaces. Its backup is `<file>.bak`, kept only when the file
/// existed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Replaced {
    file: String,
    existed: bool,
}

fn backup_path(paths: &PeriodPaths, file: &str) -> std::path::PathBuf {
    paths.docs.join(format!("{file}.bak"))
}

/// One move, both paths relative to the period's `receipts/` folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct JournalMove {
    from: String,
    to: String,
}

/// Writes the journal for `moves`, whose paths are under the real `receipts/` folder.
/// `finalized` is the state the job leaves the period in. `replaced` are the files of `docs/`
/// that the job replaces; each gets a backup copy before the journal is written.
pub(super) fn write(
    paths: &PeriodPaths,
    moves: &[Move],
    finalized: bool,
    replaced: &[std::path::PathBuf],
) -> Result<(), PipelineError> {
    let receipts_real = paths
        .receipts
        .canonicalize()
        .map_err(|e| io(&paths.receipts, e))?;
    let relative = |path: &Path| {
        relative_text(path, &receipts_real).ok_or_else(|| {
            PipelineError::InvalidInput(format!(
                "{} is not inside the receipts folder",
                path.display()
            ))
        })
    };
    let moves = moves
        .iter()
        .map(|step| {
            Ok(JournalMove {
                from: relative(&step.from)?,
                to: relative(&step.to)?,
            })
        })
        .collect::<Result<Vec<_>, PipelineError>>()?;
    create_dir(&paths.docs)?;
    let replaced = replaced
        .iter()
        .map(|path| back_up(paths, path))
        .collect::<Result<Vec<_>, PipelineError>>()?;
    let journal = Journal {
        finalized,
        replaced,
        moves,
    };
    Ok(write_json(&paths.moves_journal(), &journal)?)
}

/// Copies `path`, a file of `docs/`, to its backup. A file that does not exist has none.
fn back_up(paths: &PeriodPaths, path: &Path) -> Result<Replaced, PipelineError> {
    let file = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|_| path.parent() == Some(paths.docs.as_path()))
        .ok_or_else(|| {
            PipelineError::InvalidInput(format!("{} is not inside the docs folder", path.display()))
        })?
        .to_string();
    let backup = backup_path(paths, &file);
    match std::fs::read(path) {
        Ok(bytes) => {
            write_atomic(&backup, &bytes)?;
            Ok(Replaced {
                file,
                existed: true,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            remove_if_exists(&backup).map_err(|e| io(&backup, e))?;
            Ok(Replaced {
                file,
                existed: false,
            })
        }
        Err(error) => Err(io(path, error)),
    }
}

/// Puts a replaced file back from its backup, or deletes it when it did not exist before.
fn restore(paths: &PeriodPaths, replaced: &Replaced) -> Result<(), String> {
    let target = paths.docs.join(&replaced.file);
    if replaced.existed {
        let bytes = std::fs::read(backup_path(paths, &replaced.file))
            .map_err(|e| format!("{}: {e}", replaced.file))?;
        write_atomic(&target, &bytes).map_err(|e| format!("{}: {e}", replaced.file))
    } else {
        remove_if_exists(&target).map_err(|e| format!("{}: {e}", replaced.file))
    }
}

/// Deletes the journal of a job that is done or fully rolled back, and its backups.
pub(super) fn clear(paths: &PeriodPaths) {
    if let Ok(Some(journal)) = read_json_opt::<Journal>(&paths.moves_journal()) {
        for replaced in &journal.replaced {
            let _ = remove_if_exists(&backup_path(paths, &replaced.file));
        }
    }
    if let Err(error) = remove_if_exists(&paths.moves_journal()) {
        log::warn!(
            "could not delete the move journal of {}: {error}",
            paths.prefix
        );
    }
}

/// `relative` inside `receipts/`, when it has only plain parts.
fn inside(paths: &PeriodPaths, relative: &str) -> Option<std::path::PathBuf> {
    let path = Path::new(relative);
    let plain = path.components().all(|c| matches!(c, Component::Normal(_)));
    (plain && path.components().next().is_some()).then(|| paths.receipts.join(path))
}

/// Undoes a job that stopped before it was done, and deletes its journal. Only a move whose
/// target exists and whose source does not is undone. The replaced JSON files return to their
/// backups. Returns the number of files moved back. When a file cannot move or be restored,
/// the journal stays and the error names the file.
pub fn recover(paths: &PeriodPaths) -> Result<usize, PipelineError> {
    let Some(journal) = read_json_opt::<Journal>(&paths.moves_journal())? else {
        return Ok(0);
    };
    if paths.applied_marker().exists() == journal.finalized {
        log::info!(
            "{}: the last job finished before the app stopped; its moves stay",
            paths.prefix
        );
        clear(paths);
        return Ok(0);
    }
    let mut restored = 0;
    let mut stuck = Vec::new();
    for step in journal.moves.iter().rev() {
        let (Some(from), Some(to)) = (inside(paths, &step.from), inside(paths, &step.to)) else {
            log::warn!(
                "{}: skipping a journal move outside the receipts folder",
                paths.prefix
            );
            continue;
        };
        if !to.exists() || from.symlink_metadata().is_ok() {
            continue;
        }
        match rename_no_replace(&to, &from) {
            Ok(()) => {
                log::info!("{}: moved {} back to {}", paths.prefix, step.to, step.from);
                restored += 1;
            }
            Err(error) => stuck.push(format!("{}: {error}", step.to)),
        }
    }
    let unrestored: Vec<String> = journal
        .replaced
        .iter()
        .filter_map(|replaced| restore(paths, replaced).err())
        .collect();
    if !stuck.is_empty() {
        return Err(PipelineError::Io(format!(
            "a job on this month stopped before it was done, and these receipts could not move back: {}",
            stuck.join("; ")
        )));
    }
    if !unrestored.is_empty() {
        return Err(PipelineError::Io(format!(
            "a job on this month stopped before it was done, and these files could not be restored: {}",
            unrestored.join("; ")
        )));
    }
    clear(paths);
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::period::Period;

    fn paths(root: &Path) -> PeriodPaths {
        let paths = Period::parse("2030", "03").unwrap().paths(root);
        std::fs::create_dir_all(paths.receipts.join("_matched")).unwrap();
        std::fs::create_dir_all(&paths.docs).unwrap();
        paths
    }

    fn journal(paths: &PeriodPaths, finalized: bool, moves: &[(&str, &str)]) {
        let journal = Journal {
            finalized,
            replaced: Vec::new(),
            moves: moves
                .iter()
                .map(|(from, to)| JournalMove {
                    from: from.to_string(),
                    to: to.to_string(),
                })
                .collect(),
        };
        write_json(&paths.moves_journal(), &journal).unwrap();
    }

    #[test]
    fn writes_the_moves_relative_to_the_receipts_folder() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        let real = paths.receipts.canonicalize().unwrap();
        let step = Move {
            from: real.join("sub/acme.pdf"),
            to: real.join("_matched/acme.pdf"),
        };
        write(&paths, &[step], true, &[]).unwrap();
        let written: Journal = read_json_opt(&paths.moves_journal()).unwrap().unwrap();
        assert_eq!(
            written.moves,
            [JournalMove {
                from: "sub/acme.pdf".into(),
                to: "_matched/acme.pdf".into()
            }]
        );
        assert!(written.finalized);
    }

    #[test]
    fn undoes_only_the_moves_that_were_made() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        std::fs::write(paths.receipts.join("_matched/acme.pdf"), b"acme").unwrap();
        std::fs::write(paths.receipts.join("globex.pdf"), b"globex").unwrap();
        journal(
            &paths,
            true,
            &[
                ("acme.pdf", "_matched/acme.pdf"),
                ("globex.pdf", "_matched/globex.pdf"),
                ("../outside.pdf", "_matched/acme.pdf"),
            ],
        );

        assert_eq!(recover(&paths).unwrap(), 1);

        assert_eq!(
            std::fs::read(paths.receipts.join("acme.pdf")).unwrap(),
            b"acme"
        );
        assert!(paths.receipts.join("globex.pdf").is_file());
        assert!(!paths.moves_journal().exists());
    }

    #[test]
    fn restores_the_files_a_stopped_publish_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        std::fs::write(paths.receipts.join("_matched/acme.pdf"), b"acme").unwrap();
        std::fs::write(paths.match_result(), b"old result").unwrap();
        let step = Move {
            from: paths.receipts.canonicalize().unwrap().join("acme.pdf"),
            to: paths
                .receipts
                .canonicalize()
                .unwrap()
                .join("_matched/acme.pdf"),
        };
        write(
            &paths,
            &[step],
            true,
            &[paths.match_result(), paths.report()],
        )
        .unwrap();
        std::fs::write(paths.match_result(), b"new result").unwrap();
        std::fs::write(paths.report(), b"new report").unwrap();

        assert_eq!(recover(&paths).unwrap(), 1);

        assert_eq!(std::fs::read(paths.match_result()).unwrap(), b"old result");
        assert!(!paths.report().exists());
        assert!(!paths.docs.join("match-result.json.bak").exists());
        assert!(!paths.moves_journal().exists());
    }

    #[test]
    fn keeps_the_replaced_files_of_a_job_that_finished() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        std::fs::write(paths.match_result(), b"old result").unwrap();
        write(&paths, &[], true, &[paths.match_result()]).unwrap();
        std::fs::write(paths.match_result(), b"new result").unwrap();
        std::fs::write(paths.applied_marker(), b"2030-04-01T00:00:00Z").unwrap();

        assert_eq!(recover(&paths).unwrap(), 0);

        assert_eq!(std::fs::read(paths.match_result()).unwrap(), b"new result");
        assert!(!paths.docs.join("match-result.json.bak").exists());
        assert!(!paths.moves_journal().exists());
    }

    #[test]
    fn keeps_the_moves_of_a_job_that_finished() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        std::fs::write(paths.receipts.join("_matched/acme.pdf"), b"acme").unwrap();
        std::fs::write(paths.applied_marker(), b"2030-04-01T00:00:00Z").unwrap();
        journal(&paths, true, &[("acme.pdf", "_matched/acme.pdf")]);

        assert_eq!(recover(&paths).unwrap(), 0);

        assert!(paths.receipts.join("_matched/acme.pdf").is_file());
        assert!(!paths.moves_journal().exists());
    }

    #[cfg(unix)]
    #[test]
    fn names_a_file_that_cannot_move_back_and_keeps_the_journal() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        std::fs::create_dir(paths.receipts.join("sub")).unwrap();
        std::fs::write(paths.receipts.join("_matched/acme.pdf"), b"acme").unwrap();
        journal(&paths, true, &[("sub/acme.pdf", "_matched/acme.pdf")]);
        let sub = paths.receipts.join("sub");
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o555)).unwrap();

        let outcome = recover(&paths);

        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = outcome.unwrap_err().to_string();
        assert!(error.contains("_matched/acme.pdf"), "{error}");
        assert!(paths.moves_journal().exists());
    }

    #[test]
    fn does_nothing_without_a_journal() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(recover(&paths(dir.path())).unwrap(), 0);
    }
}
