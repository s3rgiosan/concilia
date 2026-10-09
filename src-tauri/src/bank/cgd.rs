//! Parser for CGD (Caixa Geral de Depósitos) statements, from `pdftotext -layout` output.
//!
//! A transaction row reads `<Data Mov.> <Data Valor> <description> <amount> <balance>`, with
//! ISO dates and European decimals. Data Mov., the posting date, is the transaction date.

use std::sync::LazyLock;

use regex::Regex;

use crate::model::RawTransaction;
use crate::schema::euro_str_to_cents;

static TX_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\s+(.+?)\s+(-?[0-9.]+,[0-9]{2})\s+(-?[0-9.]+,[0-9]{2})\s*$",
    )
    .expect("CGD line pattern compiles")
});

static WHITESPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("whitespace pattern compiles"));

/// Parses one line, or returns none when it is not a transaction row.
pub fn parse_line(line: &str) -> Option<RawTransaction> {
    let captures = TX_LINE.captures(line)?;
    let posted = &captures[1];
    let description = WHITESPACE.replace_all(&captures[3], " ").trim().to_string();
    if description.is_empty() {
        return None;
    }
    let amount_cents = euro_str_to_cents(&captures[4]).ok()?;
    let date = format!("{}/{}/{}", &posted[8..10], &posted[5..7], &posted[0..4]);
    Some(RawTransaction {
        date,
        description,
        amount_cents,
    })
}

/// Parses every transaction row in the statement text.
pub fn parse_text(text: &str) -> Vec<RawTransaction> {
    text.split('\n').filter_map(parse_line).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(date: &str, description: &str, amount_cents: i64) -> RawTransaction {
        RawTransaction {
            date: date.into(),
            description: description.into(),
            amount_cents,
        }
    }

    #[test]
    fn parses_a_standard_line() {
        let line = "  2030-01-15 2030-01-15 COMPRA LOJA ABC                    45,99    1.234,56";
        assert_eq!(
            parse_line(line),
            Some(tx("15/01/2030", "COMPRA LOJA ABC", 4599))
        );
    }

    #[test]
    fn uses_the_posting_date_when_it_differs_from_the_value_date() {
        let line = "  2030-04-10 2030-04-05 EXAMPLE FEE                     10,00      500,00";
        assert_eq!(
            parse_line(line),
            Some(tx("10/04/2030", "EXAMPLE FEE", 1000))
        );
    }

    #[test]
    fn parses_debits() {
        let line = "  2030-02-10 2030-02-10 PAGAMENTO SERVIÇO        -123,45    5.678,90";
        assert_eq!(
            parse_line(line),
            Some(tx("10/02/2030", "PAGAMENTO SERVIÇO", -12_345))
        );
    }

    #[test]
    fn parses_credits() {
        let line = "  2030-03-01 2030-03-01 TRANSFERÊNCIA RECEBIDA        500,00    6.178,90";
        assert_eq!(
            parse_line(line),
            Some(tx("01/03/2030", "TRANSFERÊNCIA RECEBIDA", 50_000))
        );
    }

    #[test]
    fn skips_lines_that_are_not_transactions() {
        for line in [
            "SALDO ANTERIOR 1.234,56",
            "2030-01-15 COMPRA LOJA 45,99",
            "Some random text",
            "",
            "- - 2030-01-15 OLD FORMAT 45,99 1.234,56",
        ] {
            assert_eq!(parse_line(line), None, "{line}");
        }
    }

    #[test]
    fn parses_amounts_with_thousands_separators() {
        let line = "  2030-06-15 2030-06-15 PAGAMENTO GRANDE        12.345,67   99.999.999,99";
        assert_eq!(parse_line(line).unwrap().amount_cents, 1_234_567);
    }

    #[test]
    fn collapses_whitespace_in_descriptions() {
        let line = "  2030-01-15 2030-01-15 COMPRA   LOJA    ABC        45,99    1.234,56";
        assert_eq!(parse_line(line).unwrap().description, "COMPRA LOJA ABC");
    }

    #[test]
    fn parses_every_row_of_a_statement() {
        let text = "EXTRATO\n  2030-01-15 2030-01-15 ACME CORP   10,00   90,00\nSALDO 90,00\n  2030-01-16 2030-01-16 EXAMPLE FEE   -1,00   89,00\n";
        assert_eq!(
            parse_text(text),
            vec![
                tx("15/01/2030", "ACME CORP", 1000),
                tx("16/01/2030", "EXAMPLE FEE", -100)
            ]
        );
    }
}
