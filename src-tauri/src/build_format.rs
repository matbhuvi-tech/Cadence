pub fn sanitize_env_value(raw: &str) -> String {
    raw.chars()
        .filter(|&ch| ch >= ' ')
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn format_short_date(iso_date: &str) -> Option<String> {
    let date_only = iso_date
        .trim()
        .split(['T', ' '])
        .next()
        .unwrap_or("")
        .trim();
    let mut parts = date_only.split('-');
    let year = parts.next()?;
    let month_str = parts.next()?;
    let day_str = parts.next()?;
    if parts.next().is_some() || year.len() != 4 || !year.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let month: u32 = month_str.parse().ok()?;
    let day: u32 = day_str.parse().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let month_name = match month {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        12 => "Dec",
        _ => return None,
    };
    Some(format!("{month_name} {day}"))
}

const CONVENTIONAL_TYPES: &[&str] = &[
    "feat", "fix", "chore", "refactor", "docs", "perf", "test", "build", "ci", "merge", "revert",
];

pub fn clean_commit_summary(raw_subject: &str) -> String {
    let sanitized = sanitize_env_value(raw_subject);
    if sanitized.is_empty() {
        return String::new();
    }

    let mut summary = sanitized.clone();
    if let Some((raw_prefix, rest)) = sanitized.split_once(':') {
        let prefix = raw_prefix.trim().trim_end_matches('!').trim();
        let rest_trimmed = rest.trim();
        if !rest_trimmed.is_empty() {
            if let Some((raw_type, raw_scope)) = prefix.split_once('(') {
                if let Some(scope) = raw_scope.strip_suffix(')') {
                    let kind = raw_type.trim().to_ascii_lowercase();
                    let scope_trimmed = scope.trim();
                    if CONVENTIONAL_TYPES.contains(&kind.as_str())
                        && !scope_trimmed.is_empty()
                        && !scope_trimmed.contains('(')
                    {
                        summary = format!("{scope_trimmed}: {rest_trimmed}");
                    }
                }
            } else {
                let kind = prefix.to_ascii_lowercase();
                if CONVENTIONAL_TYPES.contains(&kind.as_str()) {
                    summary = rest_trimmed.to_string();
                }
            }
        }
    }

    if summary.chars().count() > 56 {
        let mut earliest_idx: Option<usize> = None;
        for sep in [", ", " — "] {
            if let Some(idx) = summary.find(sep) {
                let left = summary[..idx].trim();
                if left.chars().count() >= 16
                    && earliest_idx.map_or(true, |best| idx < best)
                {
                    earliest_idx = Some(idx);
                }
            }
        }
        if let Some(idx) = earliest_idx {
            summary = summary[..idx].trim().to_string();
        }
    }

    if summary.chars().count() > 64 {
        let mut truncated: String = summary.chars().take(63).collect();
        if let Some(last_space) = truncated.rfind(' ') {
            if truncated[..last_space].chars().count() >= 20 {
                truncated.truncate(last_space);
            }
        }
        let cleaned = truncated.trim_end_matches(|c: char| {
            c.is_whitespace() || matches!(c, ',' | ';' | ':' | '-')
        });
        format!("{cleaned}…")
    } else {
        summary
    }
}

pub fn format_build_display(
    tag: &str,
    commits_since_tag: u32,
    commit_date: &str,
    commit_sha: &str,
    dirty: bool,
    pkg_version: &str,
) -> String {
    let tag = tag.trim();
    let commit_sha = commit_sha.trim();
    let short_date = format_short_date(commit_date);
    let dirty_suffix = if dirty { " · local" } else { "" };

    if !tag.is_empty() {
        if commits_since_tag == 0 {
            return format!("{tag}{dirty_suffix}");
        }
        return match short_date {
            Some(date) => format!("{tag} +{commits_since_tag} · {date}{dirty_suffix}"),
            None => format!("{tag} +{commits_since_tag}{dirty_suffix}"),
        };
    }

    let base = if pkg_version.trim().is_empty() {
        "v0.1.0".to_string()
    } else if pkg_version.trim().starts_with('v') {
        pkg_version.trim().to_string()
    } else {
        format!("v{}", pkg_version.trim())
    };
    let has_sha = !commit_sha.is_empty() && commit_sha != "unknown";
    match (has_sha, short_date) {
        (true, Some(date)) => format!("{base} ({commit_sha} · {date}){dirty_suffix}"),
        (true, None) => format!("{base} ({commit_sha}){dirty_suffix}"),
        (false, Some(date)) => format!("{base} ({date}){dirty_suffix}"),
        (false, None) => format!("{base}{dirty_suffix}"),
    }
}
