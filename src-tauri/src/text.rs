//! String helpers that follow JavaScript's definitions of whitespace and string length, so stored
//! data and matching give the same results.

/// Whitespace as JavaScript's `\s` and `String.prototype.trim` define it.
pub fn is_js_whitespace(c: char) -> bool {
    c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{85}')
}

/// Trims like `String.prototype.trim`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// Length in UTF-16 code units, like a JavaScript string's `length`.
pub fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Rounds like `Math.round`: to the nearest integer, halves toward positive infinity.
pub fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_javascript_whitespace() {
        assert_eq!(js_trim("\u{FEFF} a b \n"), "a b");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn counts_utf16_units() {
        assert_eq!(js_len("EUR"), 3);
        assert_eq!(js_len("R$"), 2);
        assert_eq!(js_len("😀"), 2);
    }

    #[test]
    fn rounds_halves_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(1.4999), 1.0);
    }
}
