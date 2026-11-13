//! Bank fee detection. Transactions whose description matches one of these patterns are
//! bank charges that need no receipt.
//!
//! Word boundaries and `\w` are ASCII-only, so accented letters count as word breaks.

use std::sync::LazyLock;

use regex::RegexSet;

const PATTERNS: &[&str] = &[
    // Portuguese
    r"comiss[aã]o",
    r"\bimposto\b.*\bselo\b",
    r"juros",
    r"\bmanut.*\bconta\b",
    r"\btaxa\b.*\bmanut",
    r"anuidade",
    r"\bdespesas\b.*\bconta\b",
    r"\bseguro\b",
    r"\bmulta\b",
    r"provis[aã]o",
    // English
    r"\bfee\b",
    r"\bcommission\b",
    r"\binterest\b",
    r"\bannual\s+(?:\w+\s+)?charge\b",
    r"\baccount.*maintenance\b",
    r"\bstamp.*duty\b",
    r"\boverdraft\b",
    r"\bwire\s+(?:\w+\s+)?transfer\b",
    r"\batm\b",
];

static FEES: LazyLock<RegexSet> = LazyLock::new(|| {
    let ascii = PATTERNS.iter().map(|p| {
        let p = p.replace(r"\b", r"(?-u:\b)").replace(r"\w", r"(?-u:\w)");
        format!("(?i){p}")
    });
    RegexSet::new(ascii).expect("bank fee patterns compile")
});

/// Whether a transaction description names a bank charge.
pub fn is_bank_fee(description: &str) -> bool {
    !description.is_empty() && FEES.is_match(description)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_portuguese_fees() {
        for description in [
            "COMISSÃO DE DÉBITO",
            "COMISSAO DE MANUTENÇÃO",
            "IMPOSTO DE SELO",
            "JUROS CREDORES",
            "TAXA DE MANUTENCAO",
            "MANUT CONTA",
            "ANUIDADE CARTAO",
            "DESPESAS DE CONTA",
            "MANUTENCAO CONTA",
            "SEGURO CARTAO DEBITO",
            "MULTA ATRASO PAGAMENTO",
            "PROVISAO MENSAL",
            "provisão mensal",
        ] {
            assert!(is_bank_fee(description), "{description}");
        }
    }

    #[test]
    fn matches_english_fees() {
        for description in [
            "MONTHLY FEE",
            "BANK COMMISSION",
            "INTEREST CHARGE",
            "ANNUAL CARD CHARGE",
            "ACCOUNT MAINTENANCE FEE",
            "STAMP DUTY",
            "OVERDRAFT CHARGE",
            "ANNUAL MAINTENANCE CHARGE",
            "WIRE TRANSFER FEE",
            "WIRE BANK TRANSFER",
            "ATM WITHDRAWAL FEE",
        ] {
            assert!(is_bank_fee(description), "{description}");
        }
    }

    #[test]
    fn ignores_partial_words_and_purchases() {
        for description in [
            "FATURA DESPESAS CONTABILIDADE MENSAL",
            "COFFEE SHOP",
            "ANNUAL SOFTWARE LICENSE CHARGE ACME CORP",
            "COMPRA LOJA",
            "",
        ] {
            assert!(!is_bank_fee(description), "{description}");
        }
    }

    #[test]
    fn treats_accented_letters_as_word_breaks() {
        // An accented letter is not an ASCII word character, so "FEE" stands alone here.
        assert!(is_bank_fee("ÃFEEÃ"));
        // The optional word in "wire … transfer" is ASCII only.
        assert!(!is_bank_fee("WIRE ÇÃO TRANSFER"));
    }
}
