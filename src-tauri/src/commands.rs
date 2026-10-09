//! Tauri commands used by the windows.

use serde::Serialize;
use tauri::State;

use crate::poppler::{Poppler, PopplerError, PopplerStatus};

type CommandResult<T> = Result<T, CommandError>;

/// What kind of failure a command hit, for the frontend to choose its copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    PopplerMissing,
    Internal,
}

impl ErrorKind {
    /// Whether the failure comes from the user's setup or input, as opposed to a fault in the
    /// app or its storage.
    fn is_expected(self) -> bool {
        !matches!(self, ErrorKind::Internal)
    }
}

/// A failed command as the frontend receives it: `{ "kind": ..., "message": ... }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> CommandError {
        CommandError {
            kind,
            message: message.into(),
        }
    }
}

impl From<PopplerError> for CommandError {
    fn from(error: PopplerError) -> CommandError {
        let kind = match &error {
            PopplerError::Missing(_) => ErrorKind::PopplerMissing,
            PopplerError::Failed(_) => ErrorKind::Internal,
        };
        CommandError::new(kind, error.to_string())
    }
}

/// Converts an error for the frontend and logs it: expected failures at debug, faults at warn.
fn fail(error: impl Into<CommandError>) -> CommandError {
    let error = error.into();
    if error.kind.is_expected() {
        log::debug!("command failed ({:?}): {}", error.kind, error.message);
    } else {
        log::warn!("command failed ({:?}): {}", error.kind, error.message);
    }
    error
}

#[tauri::command]
pub async fn poppler_status(poppler: State<'_, Poppler>) -> CommandResult<PopplerStatus> {
    let poppler = poppler.inner().clone();
    tauri::async_runtime::spawn_blocking(move || poppler.status())
        .await
        .map_err(|error| fail(CommandError::new(ErrorKind::Internal, error.to_string())))?
        .map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_with_a_snake_case_kind() {
        let error = CommandError::from(PopplerError::Missing("pdftotext".into()));
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["kind"], "poppler_missing");
        assert_eq!(json["message"], "pdftotext not found; install poppler");
    }
}
