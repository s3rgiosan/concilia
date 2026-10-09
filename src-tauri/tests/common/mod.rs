//! Helpers shared by the integration tests.

#![allow(dead_code)]

use std::sync::OnceLock;

use concilia_lib::gemini::client::ServiceAccount;
use rsa::pkcs8::{EncodePrivateKey, LineEnding};

/// A service account key file for tests, with a freshly generated RSA key. The key exists only
/// for the test run.
pub fn service_account_json() -> &'static str {
    static JSON: OnceLock<String> = OnceLock::new();
    JSON.get_or_init(|| {
        let mut rng = rsa::rand_core::OsRng;
        let key = rsa::RsaPrivateKey::new(&mut rng, 1024).expect("generate test key");
        let pem = key.to_pkcs8_pem(LineEnding::LF).expect("encode test key");
        serde_json::json!({
            "type": "service_account",
            "project_id": "acme-test",
            "private_key_id": "0000",
            "private_key": pem.as_str(),
            "client_email": "tester@acme-test.iam.gserviceaccount.com",
        })
        .to_string()
    })
}

pub fn service_account() -> ServiceAccount {
    ServiceAccount::parse(service_account_json()).expect("test service account parses")
}

/// A one-page PDF showing `lines` in Courier, one per line, so `pdftotext -layout` keeps
/// their spacing.
pub fn pdf_with_lines(lines: &[&str]) -> Vec<u8> {
    let escape = |s: &str| {
        s.replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)")
    };
    let text: String = lines
        .iter()
        .map(|l| format!("({}) Tj T*\n", escape(l)))
        .collect();
    let content = format!("BT /F1 10 Tf 40 800 Td 14 TL\n{text}ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>".to_string(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{object}\nendobj\n", i + 1).bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for offset in offsets {
        out.extend(format!("{offset:010} 00000 n \n").bytes());
    }
    out.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .bytes(),
    );
    out
}

/// Poppler from `PATH`, or none when it is not installed.
pub fn poppler_on_path() -> Option<concilia_lib::poppler::Poppler> {
    let poppler = concilia_lib::poppler::Poppler::resolve(None);
    poppler.status().ok().map(|_| poppler)
}
