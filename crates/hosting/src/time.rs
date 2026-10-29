//! Dates as the services write them (ISO 8601, « 2026-10-29T13:50:10.123+02:00 »), turned into
//! seconds since the Unix epoch, as the interface reads them everywhere else.

/// Seconds since the epoch for a date in ISO 8601; `None` when it cannot be read.
pub fn parse_iso(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once(['T', ' '])?;
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    // The offset: « Z », « +02:00 », « -0500 », or none (UTC).
    let (clock, offset) = match rest.find(['Z', 'z', '+', '-']) {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    let mut fields = clock.split(':');
    let hour: i64 = fields.next()?.parse().ok()?;
    let minute: i64 = fields.next()?.parse().ok()?;
    let second: i64 = fields.next().map_or(Some(0), |s| s.split('.').next()?.parse().ok())?;
    let offset_seconds = match offset.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let digits: String = offset[1..].chars().filter(char::is_ascii_digit).collect();
            let (h, m) = digits.split_at(digits.len().min(2));
            let value = h.parse::<i64>().ok()? * 3600 + m.parse::<i64>().unwrap_or(0) * 60;
            if sign == '+' { value } else { -value }
        }
        _ => 0,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset_seconds)
}

/// Days since 1970-01-01 of a date of the proleptic Gregorian calendar (H. Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_dates_of_every_service() {
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2024-02-29T12:00:00Z"), Some(1_709_208_000));
        assert_eq!(parse_iso("2024-02-29T14:00:00.123+02:00"), Some(1_709_208_000));
        assert_eq!(parse_iso("2024-02-29T07:00:00.123456-05:00"), Some(1_709_208_000));
        assert_eq!(parse_iso("2024-02-29T12:00:00"), Some(1_709_208_000));
        assert_eq!(parse_iso("yesterday"), None);
    }
}
