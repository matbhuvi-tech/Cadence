use serde::{Deserialize, Serialize};

pub use crate::build_format::{clean_commit_summary, format_short_date};

pub const CORE_PROTOCOL_V2_REVISION: u32 = 2;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub tag: String,
    pub commits_since_tag: u32,
    pub commit_sha: String,
    pub commit_date: String,
    pub commit_summary: String,
    pub dirty: bool,
    pub display: String,
}

pub fn format_build_display(
    tag: &str,
    commits_since_tag: u32,
    commit_date: &str,
    commit_sha: &str,
    dirty: bool,
) -> String {
    crate::build_format::format_build_display(
        tag,
        commits_since_tag,
        commit_date,
        commit_sha,
        dirty,
        env!("CARGO_PKG_VERSION"),
    )
}

pub fn current_build_info() -> BuildInfo {
    let pkg_version = env!("CARGO_PKG_VERSION");
    let tag = option_env!("CADENCE_BUILD_TAG")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("v{pkg_version}"));
    let commits_since_tag = option_env!("CADENCE_BUILD_COMMITS_SINCE_TAG")
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let commit_sha = option_env!("CADENCE_BUILD_SHA")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let commit_date = option_env!("CADENCE_BUILD_DATE")
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let commit_summary = option_env!("CADENCE_BUILD_SUMMARY")
        .map(clean_commit_summary)
        .unwrap_or_default();
    let dirty = matches!(
        option_env!("CADENCE_BUILD_DIRTY")
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes")
    );
    let display = option_env!("CADENCE_BUILD_DISPLAY")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format_build_display(&tag, commits_since_tag, &commit_date, &commit_sha, dirty)
        });

    BuildInfo {
        tag,
        commits_since_tag,
        commit_sha,
        commit_date,
        commit_summary,
        dirty,
        display,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_build_display_exact_clean_and_dirty_tags() {
        assert_eq!(
            format_build_display("v0.1.0-rc.2", 0, "2026-11-18", "4b2d225", false),
            "v0.1.0-rc.2"
        );
        assert_eq!(
            format_build_display("v0.1.0-rc.2", 0, "2026-11-18", "4b2d225", true),
            "v0.1.0-rc.2 · local"
        );
    }

    #[test]
    fn format_build_display_commits_ahead_and_single_digit_day() {
        assert_eq!(
            format_build_display("v0.1.0-rc.2", 37, "2026-11-19", "66aace7", false),
            "v0.1.0-rc.2 +37 · Nov 19"
        );
        assert_eq!(
            format_build_display("v0.1.0-rc.2", 5, "2026-11-05", "1234567", false),
            "v0.1.0-rc.2 +5 · Nov 5"
        );
        assert_eq!(
            format_build_display("v0.1.0-rc.2", 38, "2026-11-20", "8dfc87c", true),
            "v0.1.0-rc.2 +38 · Nov 20 · local"
        );
    }

    #[test]
    fn format_build_display_fallback_without_tag() {
        assert_eq!(
            format_build_display("", 0, "2026-11-20", "8dfc87c", false),
            format!("v{} (8dfc87c · Nov 20)", env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            format_build_display("", 0, "", "unknown", true),
            format!("v{} · local", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn clean_commit_summary_formats_conventional_commits() {
        assert_eq!(
            clean_commit_summary(
                "feat(curate): automated enrichment engine, unified 2-button workflow, and #49 SMB commit fixes"
            ),
            "curate: automated enrichment engine"
        );
        assert_eq!(
            clean_commit_summary("fix(artwork): restore missing album art"),
            "artwork: restore missing album art"
        );
        assert_eq!(
            clean_commit_summary("fix: recover paired Windows playback engine"),
            "recover paired Windows playback engine"
        );
    }

    #[test]
    fn current_build_info_populates_valid_fields() {
        let info = current_build_info();
        assert!(!info.tag.is_empty());
        assert!(!info.display.is_empty());
        assert!(!info.commit_sha.is_empty());
        assert_ne!(info.commit_sha, "unknown");
    }
}
