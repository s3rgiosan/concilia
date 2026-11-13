//! Calendar arithmetic on ISO dates and the current UTC time.

/// Days since 1970-01-01 for an ISO `YYYY-MM-DD` date. Returns none when the day does not
/// exist in that month, leap years included.
pub fn epoch_days(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !shape_ok {
        return None;
    }
    let year: i64 = date[0..4].parse().ok()?;
    let month: i64 = date[5..7].parse().ok()?;
    let day: i64 = date[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
        return None;
    }
    // Days from civil, Howard Hinnant's algorithm, for the first of the month.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468 + day - 1)
}

/// Number of days in a month of the proleptic Gregorian calendar. The month is 1 to 12.
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The current UTC time as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn time_now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days, Howard Hinnant's algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Whole days between a transaction date and an optional receipt date; none when either is
/// missing or malformed.
pub(crate) fn days_between(tx_date: &str, receipt_date: Option<&str>) -> Option<i64> {
    let a = epoch_days(tx_date)?;
    let b = epoch_days(receipt_date?)?;
    Some((a - b).abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_epoch_days() {
        assert_eq!(epoch_days("1970-01-01"), Some(0));
        assert_eq!(
            epoch_days("2028-02-29").unwrap() + 1,
            epoch_days("2028-03-01").unwrap()
        );
        assert_eq!(epoch_days("2030-01-00"), None);
        assert_eq!(epoch_days("2030-13-01"), None);
        assert_eq!(epoch_days("2030-01-32"), None);
        assert_eq!(epoch_days("2030-1-01"), None);
    }

    #[test]
    fn rejects_days_past_the_end_of_the_month() {
        assert_eq!(epoch_days("2030-02-29"), None);
        assert_eq!(epoch_days("2030-02-31"), None);
        assert_eq!(epoch_days("2030-04-31"), None);
        assert_eq!(epoch_days("2100-02-29"), None);
        assert!(epoch_days("2028-02-29").is_some());
        assert!(epoch_days("2000-02-29").is_some());
        assert!(epoch_days("2030-12-31").is_some());
    }

    #[test]
    fn formats_the_current_time_as_iso() {
        let now = time_now_iso();
        assert_eq!(now.len(), 20);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
    }
}
