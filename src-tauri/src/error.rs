//! The error every command returns, with a kind the frontend chooses its copy by.

use serde::Serialize;

use crate::bank::UnknownBank;
use crate::config::{ConfigError, InvalidReason, InvalidRule};
use crate::gemini::client::{GeminiError, InvalidSetting};
use crate::locks::Busy;
use crate::period::InvalidPeriod;
use crate::pipeline::PipelineError;
use crate::poppler::PopplerError;
use crate::secrets::{ImportError, SecretError};
use crate::updates::UpdateError;

pub type CommandResult<T> = Result<T, CommandError>;

/// What kind of failure a command hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    InvalidInput,
    NotFound,
    Busy,
    NotConfigured,
    Keychain,
    Unauthorized,
    Network,
    PopplerMissing,
    Parse,
    Finalized,
    Cancelled,
    Timeout,
    ReadOnly,
    Io,
    Internal,
}

impl ErrorKind {
    /// Whether the failure comes from the user's setup, input or network, as opposed to a
    /// fault in the app or its storage.
    fn is_expected(self) -> bool {
        !matches!(
            self,
            ErrorKind::Keychain | ErrorKind::Io | ErrorKind::Internal
        )
    }
}

/// A failed command as the frontend receives it: `{ "kind": ..., "message": ... }`, plus a
/// `code` when the failure is a known case that has its own copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> CommandError {
        CommandError {
            kind,
            message: message.into(),
            code: None,
        }
    }

    /// An error of a known case, which the frontend words by `code`.
    pub fn coded(kind: ErrorKind, code: &str, message: impl Into<String>) -> CommandError {
        CommandError {
            kind,
            message: message.into(),
            code: Some(code.to_string()),
        }
    }

    pub fn internal(error: impl std::fmt::Display) -> CommandError {
        CommandError::new(ErrorKind::Internal, error.to_string())
    }
}

macro_rules! kind_from {
    ($($error:ty => $kind:expr),* $(,)?) => {
        $(impl From<$error> for CommandError {
            fn from(error: $error) -> CommandError {
                CommandError::new($kind, error.to_string())
            }
        })*
    };
}

kind_from! {
    InvalidPeriod => ErrorKind::InvalidInput,
    InvalidRule => ErrorKind::InvalidInput,
    InvalidReason => ErrorKind::InvalidInput,
    UnknownBank => ErrorKind::InvalidInput,
    Busy => ErrorKind::Busy,
    SecretError => ErrorKind::Keychain,
}

impl From<PipelineError> for CommandError {
    fn from(error: PipelineError) -> CommandError {
        let kind = match &error {
            PipelineError::InvalidInput(_) => ErrorKind::InvalidInput,
            PipelineError::NotFound(_) => ErrorKind::NotFound,
            PipelineError::Parse(_) => ErrorKind::Parse,
            PipelineError::PopplerMissing(_) => ErrorKind::PopplerMissing,
            PipelineError::Unauthorized(_) => ErrorKind::Unauthorized,
            PipelineError::Finalized => ErrorKind::Finalized,
            PipelineError::Cancelled => ErrorKind::Cancelled,
            PipelineError::Io(_) => ErrorKind::Io,
            PipelineError::Coded { kind, .. } => *kind,
        };
        let message = error.to_string();
        match error {
            PipelineError::Coded { code, .. } => CommandError::coded(kind, code, message),
            _ => CommandError::new(kind, message),
        }
    }
}

impl From<ConfigError> for CommandError {
    fn from(error: ConfigError) -> CommandError {
        let kind = match &error {
            ConfigError::ReadOnly => ErrorKind::ReadOnly,
            ConfigError::Io(_) | ConfigError::Parse(..) => ErrorKind::Io,
        };
        CommandError::new(kind, error.to_string())
    }
}

impl From<GeminiError> for CommandError {
    fn from(error: GeminiError) -> CommandError {
        let kind = match &error {
            GeminiError::Auth(_) => ErrorKind::Unauthorized,
            GeminiError::Network(_) => ErrorKind::Network,
            GeminiError::Invalid(_) => ErrorKind::InvalidInput,
            GeminiError::Setting(setting) => return (*setting).into(),
        };
        CommandError::new(kind, error.to_string())
    }
}

impl From<InvalidSetting> for CommandError {
    fn from(error: InvalidSetting) -> CommandError {
        CommandError::coded(ErrorKind::InvalidInput, error.code(), error.to_string())
    }
}

impl From<ImportError> for CommandError {
    fn from(error: ImportError) -> CommandError {
        match error {
            ImportError::Invalid(e) => CommandError::new(ErrorKind::InvalidInput, e.to_string()),
            ImportError::Store(e) => e.into(),
        }
    }
}

impl From<PopplerError> for CommandError {
    fn from(error: PopplerError) -> CommandError {
        let kind = match &error {
            PopplerError::Missing(_) => ErrorKind::PopplerMissing,
            PopplerError::Failed(_) => ErrorKind::Internal,
            PopplerError::TooLarge(_) => {
                return PipelineError::from(error).into();
            }
        };
        CommandError::new(kind, error.to_string())
    }
}

impl From<UpdateError> for CommandError {
    fn from(error: UpdateError) -> CommandError {
        let kind = match &error {
            UpdateError::Network(_) => ErrorKind::Network,
            UpdateError::Internal(_) => ErrorKind::Internal,
            UpdateError::NothingPending | UpdateError::AlreadyInstalling => ErrorKind::InvalidInput,
        };
        CommandError::new(kind, error.to_string())
    }
}

/// Converts an error for the frontend and logs it: expected failures at debug, faults at warn.
pub fn fail(error: impl Into<CommandError>) -> CommandError {
    let error = error.into();
    if error.kind.is_expected() {
        log::debug!("command failed ({:?}): {}", error.kind, error.message);
    } else {
        log::warn!("command failed ({:?}): {}", error.kind, error.message);
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locks::RunKind;

    #[test]
    fn serializes_kind_and_message() {
        let error = CommandError::from(PopplerError::Missing("pdftotext".into()));
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({ "kind": "poppler_missing", "message": "pdftotext not found; install poppler" })
        );
    }

    #[test]
    fn serializes_the_code_only_when_present() {
        let error = CommandError::coded(ErrorKind::NotFound, "not_reconciled", "x");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({ "kind": "not_found", "message": "x", "code": "not_reconciled" })
        );
        let error = CommandError::from(PipelineError::coded(
            ErrorKind::InvalidInput,
            "not_pdf",
            "a.txt is not a PDF file",
        ));
        assert_eq!(error.code.as_deref(), Some("not_pdf"));
        assert_eq!(error.kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn maps_pipeline_and_lock_errors() {
        let kind = |e: CommandError| e.kind;
        assert_eq!(kind(PipelineError::Finalized.into()), ErrorKind::Finalized);
        assert_eq!(
            kind(PipelineError::Unauthorized("x".into()).into()),
            ErrorKind::Unauthorized
        );
        assert_eq!(kind(PipelineError::Cancelled.into()), ErrorKind::Cancelled);
        assert_eq!(kind(Busy::Running(RunKind::Scan).into()), ErrorKind::Busy);
        assert_eq!(
            kind(GeminiError::Network("x".into()).into()),
            ErrorKind::Network
        );
        assert_eq!(kind(ConfigError::ReadOnly.into()), ErrorKind::ReadOnly);
        assert_eq!(
            kind(UnknownBank("x".into()).into()),
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn invalid_gemini_settings_carry_their_code() {
        let error = CommandError::from(GeminiError::Setting(InvalidSetting::Project));
        assert_eq!(error.kind, ErrorKind::InvalidInput);
        assert_eq!(error.code.as_deref(), Some("invalid_project"));
    }
}
