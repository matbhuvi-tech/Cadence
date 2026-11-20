#[path = "src/build_format.rs"]
mod build_format;

use build_format::{clean_commit_summary, format_build_display, sanitize_env_value};
use std::path::{Path, PathBuf};
use std::process::Command;

const ENV_VARS: &[&str] = &[
    "CADENCE_VERSION",
    "CADENCE_BUILD_TAG",
    "CADENCE_BUILD_COMMITS_SINCE_TAG",
    "CADENCE_BUILD_SHA",
    "CADENCE_BUILD_DATE",
    "CADENCE_BUILD_SUMMARY",
    "CADENCE_BUILD_DIRTY",
];

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| sanitize_env_value(&v))
        .filter(|v| !v.is_empty())
}

fn run_git(repo_root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    Some(sanitize_env_value(&text))
}

struct DescribeInfo {
    tag: Option<String>,
    commits_since_tag: Option<u32>,
    sha: Option<String>,
    dirty: bool,
}

fn parse_git_describe(raw: &str) -> DescribeInfo {
    let trimmed = raw.trim();
    let (core, dirty) = match trimmed.strip_suffix("-dirty") {
        Some(rest) => (rest, true),
        None => (trimmed, false),
    };

    if let Some((prefix, sha)) = core.rsplit_once("-g") {
        if !sha.is_empty() && sha.chars().all(|c| c.is_ascii_hexdigit()) {
            if let Some((tag, commits_str)) = prefix.rsplit_once('-') {
                if !tag.is_empty() {
                    if let Ok(commits) = commits_str.parse::<u32>() {
                        return DescribeInfo {
                            tag: Some(tag.to_string()),
                            commits_since_tag: Some(commits),
                            sha: Some(sha.to_string()),
                            dirty,
                        };
                    }
                }
            }
        }
    }

    let bare_sha = if !core.is_empty() && core.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(core.to_string())
    } else {
        None
    };

    DescribeInfo {
        tag: None,
        commits_since_tag: None,
        sha: bare_sha,
        dirty,
    }
}

fn emit_git_rerun_hints(manifest_dir: &Path) {
    let git_dir = manifest_dir.join("..").join(".git");
    let head_path = git_dir.join("HEAD");
    if !head_path.is_file() {
        return;
    }
    println!("cargo:rerun-if-changed={}", head_path.display());

    if let Ok(head_contents) = std::fs::read_to_string(&head_path) {
        if let Some(ref_rel) = head_contents.trim().strip_prefix("ref:") {
            let ref_path = git_dir.join(ref_rel.trim());
            if ref_path.is_file() {
                println!("cargo:rerun-if-changed={}", ref_path.display());
            }
        }
    }

    let packed_refs = git_dir.join("packed-refs");
    if packed_refs.is_file() {
        println!("cargo:rerun-if-changed={}", packed_refs.display());
    }
}

fn emit_build_metadata() {
    for var in ENV_VARS {
        println!("cargo:rerun-if-env-changed={var}");
    }

    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()),
    );
    emit_git_rerun_hints(&manifest_dir);

    let repo_root = manifest_dir.join("..");
    let pkg_version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.1.0".to_string());
    let cadence_version = non_empty_env("CADENCE_VERSION");

    let described = run_git(
        &repo_root,
        &["describe", "--tags", "--long", "--always", "--dirty"],
    )
    .map(|raw| parse_git_describe(&raw));

    let tag = non_empty_env("CADENCE_BUILD_TAG")
        .or_else(|| described.as_ref().and_then(|d| d.tag.clone()))
        .or_else(|| {
            cadence_version
                .as_deref()
                .filter(|v| v.starts_with('v'))
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("v{pkg_version}"));

    let commits_since_tag = non_empty_env("CADENCE_BUILD_COMMITS_SINCE_TAG")
        .and_then(|v| v.parse::<u32>().ok())
        .or_else(|| {
            described
                .as_ref()
                .and_then(|d| if d.tag.is_some() { d.commits_since_tag } else { None })
        })
        .unwrap_or(0);

    let commit_sha = non_empty_env("CADENCE_BUILD_SHA")
        .or_else(|| described.as_ref().and_then(|d| d.sha.clone()))
        .or_else(|| run_git(&repo_root, &["log", "-1", "--format=%h"]))
        .or_else(|| {
            cadence_version
                .as_deref()
                .filter(|v| v.len() >= 7 && v.chars().all(|c| c.is_ascii_hexdigit()))
                .map(|v| v[..7].to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    let commit_date = non_empty_env("CADENCE_BUILD_DATE")
        .or_else(|| run_git(&repo_root, &["log", "-1", "--format=%cs"]))
        .unwrap_or_default();

    let raw_summary = non_empty_env("CADENCE_BUILD_SUMMARY")
        .or_else(|| run_git(&repo_root, &["log", "-1", "--format=%s"]))
        .unwrap_or_default();
    let commit_summary = clean_commit_summary(&raw_summary);

    let dirty = match non_empty_env("CADENCE_BUILD_DIRTY") {
        Some(v) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        None => match run_git(&repo_root, &["status", "--porcelain", "--untracked-files=no"]) {
            Some(status) => !status.is_empty(),
            None => described.as_ref().map_or(false, |d| d.dirty),
        },
    };

    let display = format_build_display(
        &tag,
        commits_since_tag,
        &commit_date,
        &commit_sha,
        dirty,
        &pkg_version,
    );

    println!("cargo:rustc-env=CADENCE_BUILD_TAG={}", sanitize_env_value(&tag));
    println!("cargo:rustc-env=CADENCE_BUILD_COMMITS_SINCE_TAG={commits_since_tag}");
    println!("cargo:rustc-env=CADENCE_BUILD_SHA={}", sanitize_env_value(&commit_sha));
    println!("cargo:rustc-env=CADENCE_BUILD_DATE={}", sanitize_env_value(&commit_date));
    println!(
        "cargo:rustc-env=CADENCE_BUILD_SUMMARY={}",
        sanitize_env_value(&commit_summary)
    );
    println!("cargo:rustc-env=CADENCE_BUILD_DIRTY={dirty}");
    println!("cargo:rustc-env=CADENCE_BUILD_DISPLAY={}", sanitize_env_value(&display));
}

fn main() {
    emit_build_metadata();
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
