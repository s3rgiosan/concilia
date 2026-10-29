//! Native alerts for destructive confirmations, shown as a sheet on the window that asks.

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use crate::error::{fail, CommandError, CommandResult};

/// An alert's text and buttons. `confirm` is the default button; `alternate`, when given, sits
/// between it and Cancel.
#[derive(Debug, Clone, Deserialize)]
pub struct AlertRequest {
    pub title: String,
    pub message: String,
    pub confirm: String,
    pub cancel: String,
    pub alternate: Option<String>,
}

/// The button the user chose. Escape and closing the alert count as Cancel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertChoice {
    Confirm,
    Alternate,
    Cancel,
}

fn buttons(request: &AlertRequest) -> MessageDialogButtons {
    match &request.alternate {
        Some(alternate) => MessageDialogButtons::YesNoCancelCustom(
            request.confirm.clone(),
            alternate.clone(),
            request.cancel.clone(),
        ),
        None => MessageDialogButtons::OkCancelCustom(request.confirm.clone(), request.cancel.clone()),
    }
}

/// The choice a dialog result stands for. Custom buttons report their label.
fn choice(request: &AlertRequest, result: &MessageDialogResult) -> AlertChoice {
    match result {
        MessageDialogResult::Custom(label) if *label == request.confirm => AlertChoice::Confirm,
        MessageDialogResult::Custom(label) if request.alternate.as_ref() == Some(label) => {
            AlertChoice::Alternate
        }
        MessageDialogResult::Ok | MessageDialogResult::Yes => AlertChoice::Confirm,
        MessageDialogResult::No if request.alternate.is_some() => AlertChoice::Alternate,
        _ => AlertChoice::Cancel,
    }
}

/// Shows an alert on the calling window and returns the button chosen.
#[tauri::command]
pub async fn show_alert(window: WebviewWindow, request: AlertRequest) -> CommandResult<AlertChoice> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .message(request.message.clone())
        .title(request.title.clone())
        .kind(MessageDialogKind::Info)
        .buttons(buttons(&request))
        .parent(&window)
        .show_with_result(move |result| {
            let _ = sender.send(result);
        });
    let result = receiver
        .await
        .map_err(|e| fail(CommandError::internal(e)))?;
    Ok(choice(&request, &result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(alternate: Option<&str>) -> AlertRequest {
        AlertRequest {
            title: "Remove the key?".into(),
            message: "Example message.".into(),
            confirm: "Remove".into(),
            cancel: "Cancel".into(),
            alternate: alternate.map(String::from),
        }
    }

    #[test]
    fn custom_labels_map_to_choices() {
        let with_alternate = request(Some("Review"));
        let custom = |label: &str| MessageDialogResult::Custom(label.into());
        assert_eq!(choice(&with_alternate, &custom("Remove")), AlertChoice::Confirm);
        assert_eq!(choice(&with_alternate, &custom("Review")), AlertChoice::Alternate);
        assert_eq!(choice(&with_alternate, &custom("Cancel")), AlertChoice::Cancel);
        assert_eq!(choice(&with_alternate, &MessageDialogResult::Cancel), AlertChoice::Cancel);
    }

    #[test]
    fn two_button_alerts_have_no_alternate() {
        let plain = request(None);
        assert_eq!(choice(&plain, &MessageDialogResult::Ok), AlertChoice::Confirm);
        assert_eq!(choice(&plain, &MessageDialogResult::No), AlertChoice::Cancel);
        assert!(matches!(buttons(&plain), MessageDialogButtons::OkCancelCustom(..)));
    }
}
