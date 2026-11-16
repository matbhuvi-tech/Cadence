//! Opt-in runtime SMB (CIFS) share mounting for containerized Linux Core.
//! Mirrors Music Assistant's StorageController security & capability checks:
//! - Requires root (euid == 0), CAP_SYS_ADMIN, CAP_DAC_READ_SEARCH, and `mount.cifs`.
//! - Mounts strictly under `/tmp/cadence-mounts/<id>` (root-owned 0700, symlink-safe).
//! - Passes credentials via `PASSWD` env var (never CLI arguments) and never returns passwords via API.

use crate::db::AppDb;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Command;

pub const SMB_MOUNT_ROOT: &str = "/tmp/cadence-mounts";
pub const SUPPORTED_SMB_VERSIONS: &[&str] = &["auto", "3.1.1", "3.0", "2.1", "2.0", "1.0"];
const CAP_DAC_READ_SEARCH_BIT: u32 = 2;
const CAP_SYS_ADMIN_BIT: u32 = 21;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmbSupportStatus {
    pub supported: bool,
    pub reason: Option<String>,
    pub versions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkShareRecord {
    pub id: String,
    pub server: String,
    pub share: String,
    pub mount_path: String,
    pub display_name: String,
    pub username: Option<String>,
    pub smb_version: Option<String>,
    pub read_only: bool,
    pub mounted: bool,
}

#[derive(Clone, Debug)]
pub struct AddShareInput {
    pub server: String,
    pub share: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub smb_version: Option<String>,
    pub read_only: bool,
    pub display_name: Option<String>,
}

pub fn ensure_schema(db: &AppDb) -> Result<(), String> {
    db.conn
        .lock()
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS engine_network_shares (
                id TEXT PRIMARY KEY,
                server TEXT NOT NULL,
                share TEXT NOT NULL,
                mount_path TEXT NOT NULL UNIQUE,
                username TEXT,
                password TEXT,
                smb_version TEXT,
                read_only INTEGER NOT NULL DEFAULT 1,
                display_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .map_err(|e| e.to_string())
}

pub fn parse_cap_eff_from_status(status_text: &str) -> Option<u64> {
    for line in status_text.lines() {
        if let Some(rest) = line.strip_prefix("CapEff:") {
            let trimmed = rest.trim();
            return u64::from_str_radix(trimmed, 16).ok();
        }
    }
    None
}

pub fn evaluate_smb_support(
    os: &str,
    euid: Option<u32>,
    cap_eff: Option<u64>,
    has_mount_cifs: bool,
) -> SmbSupportStatus {
    let versions = SUPPORTED_SMB_VERSIONS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if os != "linux" {
        return SmbSupportStatus {
            supported: false,
            reason: Some(format!("Runtime SMB mounting is not supported on {os}.")),
            versions,
        };
    }
    if euid != Some(0) {
        return SmbSupportStatus {
            supported: false,
            reason: Some(
                "Container is not running as root (restart with --user 0:0, --cap-add SYS_ADMIN, --cap-add DAC_READ_SEARCH)."
                    .into(),
            ),
            versions,
        };
    }
    let has_sys_admin = cap_eff.is_some_and(|m| (m & (1u64 << CAP_SYS_ADMIN_BIT)) != 0);
    let has_dac_read = cap_eff.is_some_and(|m| (m & (1u64 << CAP_DAC_READ_SEARCH_BIT)) != 0);
    if !has_sys_admin || !has_dac_read {
        let mut missing = Vec::new();
        if !has_sys_admin {
            missing.push("CAP_SYS_ADMIN");
        }
        if !has_dac_read {
            missing.push("CAP_DAC_READ_SEARCH");
        }
        return SmbSupportStatus {
            supported: false,
            reason: Some(format!(
                "Container is missing {} capability.",
                missing.join(" and ")
            )),
            versions,
        };
    }
    if !has_mount_cifs {
        return SmbSupportStatus {
            supported: false,
            reason: Some("cifs-utils (mount.cifs) is not installed in this image.".into()),
            versions,
        };
    }
    SmbSupportStatus {
        supported: true,
        reason: None,
        versions,
    }
}

pub fn get_smb_mount_support() -> SmbSupportStatus {
    #[cfg(target_os = "linux")]
    {
        let euid = Some(unsafe { libc::geteuid() } as u32);
        let cap_eff = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|txt| parse_cap_eff_from_status(&txt));
        let has_helper = ["/sbin/mount.cifs", "/usr/sbin/mount.cifs", "/bin/mount.cifs"]
            .iter()
            .any(|p| Path::new(p).exists());
        evaluate_smb_support("linux", euid, cap_eff, has_helper)
    }
    #[cfg(not(target_os = "linux"))]
    {
        evaluate_smb_support(std::env::consts::OS, None, None, false)
    }
}

pub fn normalize_share_input(raw: AddShareInput) -> Result<AddShareInput, String> {
    let server = raw.server.trim().to_string();
    if server.is_empty()
        || server.len() > 255
        || server
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '/' | '\\' | ',' | '='))
    {
        return Err("Invalid SMB server hostname or IP address.".into());
    }

    let share = raw
        .share
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if share.is_empty()
        || share.len() > 255
        || share.contains("..")
        || share.contains(',')
        || share.chars().any(|c| c.is_control())
    {
        return Err("Invalid SMB share name.".into());
    }

    let username = raw
        .username
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    if let Some(ref u) = username {
        if u.len() > 128 || u.chars().any(|c| c.is_control() || matches!(c, ',' | '=')) {
            return Err("Invalid SMB username (must not contain ',' or '=').".into());
        }
    }

    let password = raw.password.filter(|p| !p.is_empty());
    if let Some(ref p) = password {
        if p.len() > 512 || p.chars().any(|c| c == '\0') {
            return Err("Invalid SMB password.".into());
        }
    }

    let smb_version = raw
        .smb_version
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v != "auto");
    if let Some(ref ver) = smb_version {
        if !SUPPORTED_SMB_VERSIONS.contains(&ver.as_str()) {
            return Err(format!("Unsupported SMB protocol version: {ver}"));
        }
    }

    let display_name = raw
        .display_name
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| format!("//{server}/{share}"));

    Ok(AddShareInput {
        server,
        share,
        username,
        password,
        smb_version,
        read_only: raw.read_only,
        display_name: Some(display_name),
    })
}

pub fn share_id(server: &str, share: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"smb:");
    hasher.update(server.to_ascii_lowercase().as_bytes());
    hasher.update(b"/");
    hasher.update(share.to_ascii_lowercase().as_bytes());
    let digest = hasher.finalize();
    format!(
        "smb_{}",
        digest[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

pub fn build_cifs_mount_options(input: &AddShareInput) -> String {
    let mut opts = vec![if input.read_only { "ro" } else { "rw" }.to_string()];
    let is_guest = input
        .username
        .as_deref()
        .is_none_or(|u| u.eq_ignore_ascii_case("guest"));
    if is_guest {
        opts.push("guest".into());
    } else if let Some(ref u) = input.username {
        opts.push(format!("username={u}"));
    }
    if let Some(ref v) = input.smb_version {
        opts.push(format!("vers={v}"));
    }
    opts.push("cache=loose".into());
    opts.join(",")
}

pub fn parse_mounted_points_from_mountinfo(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for line in text.lines() {
        let mut fields = line.split(' ');
        let _id = fields.next();
        let _parent = fields.next();
        let _dev = fields.next();
        let _root = fields.next();
        if let Some(mountpoint) = fields.next() {
            out.insert(mountpoint.replace("\\040", " "));
        }
    }
    out
}

fn current_mountpoints() -> HashSet<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/self/mountinfo")
            .map(|txt| parse_mounted_points_from_mountinfo(&txt))
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "linux"))]
    {
        HashSet::new()
    }
}

#[cfg(target_os = "linux")]
fn ensure_safe_mount_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let root = Path::new(SMB_MOUNT_ROOT);
    if !root.exists() {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let root_meta = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if root_meta.file_type().is_symlink() || !root_meta.is_dir() || root_meta.uid() != 0 {
        return Err("Unsafe SMB mount root directory.".into());
    }
    if !path.exists() {
        std::fs::create_dir(path).map_err(|e| e.to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != 0 {
        return Err("Unsafe SMB mountpoint directory.".into());
    }
    Ok(())
}

fn mount_cifs_share(input: &AddShareInput, mount_path: &Path) -> Result<(), String> {
    let support = get_smb_mount_support();
    if !support.supported {
        return Err(support
            .reason
            .unwrap_or_else(|| "SMB mounting is unavailable.".into()));
    }
    #[cfg(target_os = "linux")]
    {
        ensure_safe_mount_dir(mount_path)?;
        if current_mountpoints().contains(&mount_path.to_string_lossy().to_string()) {
            return Ok(());
        }
        let source = format!("//{}/{}", input.server, input.share);
        let opts = build_cifs_mount_options(input);
        let mut cmd = Command::new("mount");
        cmd.arg("-t")
            .arg("cifs")
            .arg(&source)
            .arg(mount_path)
            .arg("-o")
            .arg(&opts);
        if let Some(ref pwd) = input.password {
            cmd.env("PASSWD", pwd);
        }
        let output = cmd.output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "Failed to mount SMB share.".into()
            } else {
                stderr
            });
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (input, mount_path);
        Err("Runtime SMB mounting is only supported on Linux containers.".into())
    }
}

fn unmount_cifs_share(mount_path: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let path_str = mount_path.to_string_lossy().to_string();
        if current_mountpoints().contains(&path_str) {
            let output = Command::new("umount")
                .arg(mount_path)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    "Failed to unmount SMB share.".into()
                } else {
                    stderr
                });
            }
        }
        if mount_path.exists() {
            let _ = std::fs::remove_dir(mount_path);
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = mount_path;
        Ok(())
    }
}

pub fn list_shares(db: &AppDb) -> Result<Vec<NetworkShareRecord>, String> {
    ensure_schema(db)?;
    let mounted = current_mountpoints();
    let conn = db.conn.lock();
    let mut stmt = conn
        .prepare(
            "SELECT id, server, share, mount_path, display_name, username, smb_version, read_only
             FROM engine_network_shares ORDER BY display_name, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let mount_path: String = r.get(3)?;
            Ok(NetworkShareRecord {
                id: r.get(0)?,
                server: r.get(1)?,
                share: r.get(2)?,
                mounted: mounted.contains(&mount_path),
                mount_path,
                display_name: r.get(4)?,
                username: r.get(5)?,
                smb_version: r.get(6)?,
                read_only: r.get::<_, i64>(7)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn add_and_mount_share(db: &AppDb, raw: AddShareInput) -> Result<NetworkShareRecord, String> {
    ensure_schema(db)?;
    let input = normalize_share_input(raw)?;
    let id = share_id(&input.server, &input.share);
    let mount_path = PathBuf::from(SMB_MOUNT_ROOT).join(&id);
    mount_cifs_share(&input, &mount_path)?;
    let mount_str = mount_path.to_string_lossy().to_string();
    let display_name = input
        .display_name
        .clone()
        .unwrap_or_else(|| format!("//{}/{}", input.server, input.share));
    db.conn
        .lock()
        .execute(
            "INSERT INTO engine_network_shares
             (id, server, share, mount_path, username, password, smb_version, read_only, display_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               username = excluded.username,
               password = COALESCE(excluded.password, engine_network_shares.password),
               smb_version = excluded.smb_version,
               read_only = excluded.read_only,
               display_name = excluded.display_name",
            params![
                id,
                input.server,
                input.share,
                mount_str,
                input.username,
                input.password,
                input.smb_version,
                if input.read_only { 1 } else { 0 },
                display_name,
            ],
        )
        .map_err(|e| e.to_string())?;

    Ok(NetworkShareRecord {
        id,
        server: input.server,
        share: input.share,
        mount_path: mount_str,
        display_name,
        username: input.username,
        smb_version: input.smb_version,
        read_only: input.read_only,
        mounted: true,
    })
}

pub fn remove_and_unmount_share(db: &AppDb, id: &str) -> Result<Option<String>, String> {
    ensure_schema(db)?;
    let mount_path: Option<String> = db
        .conn
        .lock()
        .query_row(
            "SELECT mount_path FROM engine_network_shares WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(mount_str) = mount_path else {
        return Ok(None);
    };
    unmount_cifs_share(Path::new(&mount_str))?;
    db.conn
        .lock()
        .execute("DELETE FROM engine_network_shares WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(Some(mount_str))
}

/// Remounts persisted shares at idle startup and returns their mounted paths.
pub fn remount_persisted_shares(db: &AppDb) -> Vec<PathBuf> {
    if ensure_schema(db).is_err() || !get_smb_mount_support().supported {
        return Vec::new();
    }
    let rows: Vec<(String, String, String, Option<String>, Option<String>, Option<String>, bool, String)> = {
        let conn = db.conn.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT server, share, mount_path, username, password, smb_version, read_only, display_name
             FROM engine_network_shares",
        ) else {
            return Vec::new();
        };
        let Ok(mapped) = stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get::<_, i64>(6)? != 0,
                r.get(7)?,
            ))
        }) else {
            return Vec::new();
        };
        mapped.filter_map(Result::ok).collect()
    };

    let mut mounted_roots = Vec::new();
    for (server, share, mount_path, username, password, smb_version, read_only, display_name) in rows
    {
        let input = AddShareInput {
            server,
            share,
            username,
            password,
            smb_version,
            read_only,
            display_name: Some(display_name),
        };
        let path = PathBuf::from(&mount_path);
        if mount_cifs_share(&input, &path).is_ok() {
            mounted_roots.push(path);
        }
    }
    mounted_roots
}

pub fn status_json() -> Value {
    let status = get_smb_mount_support();
    json!(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cap_eff_and_checks_sys_admin_plus_dac_read_search() {
        let status = "Name:\tcadence\nCapPrm:\t0000000000200004\nCapEff:\t0000000000200004\n";
        let cap = parse_cap_eff_from_status(status).unwrap();
        let ok = evaluate_smb_support("linux", Some(0), Some(cap), true);
        assert!(ok.supported);
        assert!(ok.reason.is_none());

        let no_root = evaluate_smb_support("linux", Some(568), Some(cap), true);
        assert!(!no_root.supported);
        assert!(no_root.reason.unwrap().contains("root"));

        let missing_caps = evaluate_smb_support("linux", Some(0), Some(0), true);
        assert!(!missing_caps.supported);
        assert!(missing_caps.reason.unwrap().contains("CAP_SYS_ADMIN"));
    }

    #[test]
    fn normalizes_share_and_builds_safe_cifs_options() {
        let normalized = normalize_share_input(AddShareInput {
            server: "192.168.1.10".into(),
            share: "\\Media\\DSD\\".into(),
            username: Some("mathan".into()),
            password: Some("sec,ret=1".into()),
            smb_version: Some("3.1.1".into()),
            read_only: true,
            display_name: None,
        })
        .unwrap();
        assert_eq!(normalized.share, "Media/DSD");
        assert_eq!(
            build_cifs_mount_options(&normalized),
            "ro,username=mathan,vers=3.1.1,cache=loose"
        );
        assert!(normalize_share_input(AddShareInput {
            server: "192.168.1.10".into(),
            share: "../etc".into(),
            username: None,
            password: None,
            smb_version: None,
            read_only: true,
            display_name: None,
        })
        .is_err());
    }

    #[test]
    fn parses_mountinfo_with_escaped_spaces() {
        let txt = "41 25 0:42 / /tmp/cadence-mounts/smb_1 rw,relatime - cifs //192.168.1.6/Music\\040Share rw\n";
        let pts = parse_mounted_points_from_mountinfo(txt);
        assert!(pts.contains("/tmp/cadence-mounts/smb_1"));
    }
}
