//! Read-only engine health diagnostics (`--doctor`) shared by `cadence-headless` and `cadence-engine`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use super::dragonfish::{
    probe_healthcheck_with_data_dir, PersistedNodeIdentity, PersistedTlsCertificate,
};
use super::{PlatformProbe, SystemPlatformProbe};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DoctorStatus {
    Ok,
    Warn,
    Fail,
}

impl DoctorStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::Warn => "WARN",
            Self::Fail => "FAIL",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoctorCheck {
    pub name: String,
    pub status: DoctorStatus,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoctorReport {
    pub app_data_dir: PathBuf,
    pub control_port: u16,
    pub checks: Vec<DoctorCheck>,
}

impl DoctorReport {
    pub fn is_healthy(&self) -> bool {
        !self.checks.iter().any(|c| c.status == DoctorStatus::Fail)
    }

    pub fn format_text(&self) -> String {
        let mut lines = Vec::with_capacity(self.checks.len() + 3);
        lines.push(format!(
            "Cadence Engine Doctor (data_dir={}, control_port={})",
            self.app_data_dir.display(),
            self.control_port
        ));
        for check in &self.checks {
            lines.push(format!(
                "[{}] {}: {}",
                check.status.label(),
                check.name,
                check.detail
            ));
        }
        let summary = if self.is_healthy() {
            if self.checks.iter().any(|c| c.status == DoctorStatus::Warn) {
                "Overall: HEALTHY (with warnings)"
            } else {
                "Overall: HEALTHY"
            }
        } else {
            "Overall: UNHEALTHY (see FAIL items above)"
        };
        lines.push(summary.to_string());
        lines.join("\n")
    }
}

pub fn run_engine_doctor(app_data_dir: &Path, control_port: u16) -> DoctorReport {
    let mut checks = Vec::new();
    let dir_exists = app_data_dir.is_dir();

    checks.push(check_data_directory(app_data_dir));

    let db_path = app_data_dir.join("cadence.db");
    let db_exists = dir_exists && db_path.is_file();

    checks.push(check_identity_and_tls(app_data_dir, dir_exists, db_exists));

    if db_exists {
        let ro_flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        match Connection::open_with_flags(&db_path, ro_flags) {
            Ok(conn) => {
                checks.push(check_sqlite_integrity(&conn));
                checks.push(check_sqlite_foreign_keys(&conn));
            }
            Err(err) => {
                checks.push(DoctorCheck {
                    name: "sqlite_integrity".into(),
                    status: DoctorStatus::Fail,
                    detail: format!(
                        "could not open {} read-only: {} (restore a backup with --restore <tag>)",
                        db_path.display(),
                        err
                    ),
                });
                checks.push(DoctorCheck {
                    name: "sqlite_foreign_keys".into(),
                    status: DoctorStatus::Warn,
                    detail: "skipped because cadence.db could not be opened".into(),
                });
            }
        }
    } else {
        checks.push(DoctorCheck {
            name: "sqlite_integrity".into(),
            status: DoctorStatus::Warn,
            detail: format!("{} not present yet (uninitialized)", db_path.display()),
        });
        checks.push(DoctorCheck {
            name: "sqlite_foreign_keys".into(),
            status: DoctorStatus::Warn,
            detail: "skipped (database not initialized yet)".into(),
        });
    }

    checks.push(check_memory_and_lock_limits());
    checks.push(check_live_readiness(app_data_dir, control_port));

    DoctorReport {
        app_data_dir: app_data_dir.to_path_buf(),
        control_port,
        checks,
    }
}

fn check_data_directory(app_data_dir: &Path) -> DoctorCheck {
    if app_data_dir.is_dir() {
        DoctorCheck {
            name: "data_directory".into(),
            status: DoctorStatus::Ok,
            detail: format!("{} exists", app_data_dir.display()),
        }
    } else if app_data_dir.exists() {
        DoctorCheck {
            name: "data_directory".into(),
            status: DoctorStatus::Fail,
            detail: format!("{} exists but is not a directory", app_data_dir.display()),
        }
    } else {
        DoctorCheck {
            name: "data_directory".into(),
            status: DoctorStatus::Warn,
            detail: format!(
                "{} does not exist yet (engine has not been initialized)",
                app_data_dir.display()
            ),
        }
    }
}

fn check_identity_and_tls(
    app_data_dir: &Path,
    dir_exists: bool,
    db_exists: bool,
) -> DoctorCheck {
    if !dir_exists {
        return DoctorCheck {
            name: "identity_and_tls".into(),
            status: DoctorStatus::Warn,
            detail: "skipped (data directory does not exist yet)".into(),
        };
    }

    let id_path = app_data_dir.join("node-identity.json");
    let cert_json_path = app_data_dir.join("tls-cert.json");
    let cert_pem_path = app_data_dir.join("tls-cert.pem");
    let key_pem_path = app_data_dir.join("tls-key.pem");
    let token_path = app_data_dir.join("pairing-token");

    if !id_path.is_file() && !db_exists {
        return DoctorCheck {
            name: "identity_and_tls".into(),
            status: DoctorStatus::Warn,
            detail: "node-identity.json not created yet (uninitialized)".into(),
        };
    }

    let id_raw = match std::fs::read_to_string(&id_path) {
        Ok(s) => s,
        Err(err) => {
            return DoctorCheck {
                name: "identity_and_tls".into(),
                status: if db_exists {
                    DoctorStatus::Fail
                } else {
                    DoctorStatus::Warn
                },
                detail: format!("failed to read {}: {}", id_path.display(), err),
            };
        }
    };
    let identity: PersistedNodeIdentity = match serde_json::from_str(&id_raw) {
        Ok(id) => id,
        Err(err) => {
            return DoctorCheck {
                name: "identity_and_tls".into(),
                status: DoctorStatus::Fail,
                detail: format!(
                    "invalid JSON in {}: {} (restore a backup with --restore <tag>)",
                    id_path.display(),
                    err
                ),
            };
        }
    };

    let cert_raw = match std::fs::read_to_string(&cert_json_path) {
        Ok(s) => s,
        Err(err) => {
            return DoctorCheck {
                name: "identity_and_tls".into(),
                status: DoctorStatus::Warn,
                detail: format!(
                    "identity {} loaded, but {} is missing/unreadable: {}",
                    identity.engine_id,
                    cert_json_path.display(),
                    err
                ),
            };
        }
    };
    if let Err(err) = serde_json::from_str::<PersistedTlsCertificate>(&cert_raw) {
        return DoctorCheck {
            name: "identity_and_tls".into(),
            status: DoctorStatus::Fail,
            detail: format!("invalid JSON in {}: {}", cert_json_path.display(), err),
        };
    }

    let mut missing = Vec::new();
    for (name, path) in [
        ("tls-cert.pem", &cert_pem_path),
        ("tls-key.pem", &key_pem_path),
        ("pairing-token", &token_path),
    ] {
        if !path.is_file() {
            missing.push(name);
        }
    }
    if !missing.is_empty() {
        return DoctorCheck {
            name: "identity_and_tls".into(),
            status: DoctorStatus::Warn,
            detail: format!(
                "identity {} loaded; missing auxiliary file(s): {}",
                identity.engine_id,
                missing.join(", ")
            ),
        };
    }

    DoctorCheck {
        name: "identity_and_tls".into(),
        status: DoctorStatus::Ok,
        detail: format!(
            "engineId={} schemaVersion={} tls/token files present",
            identity.engine_id, identity.schema_version
        ),
    }
}

fn check_sqlite_integrity(conn: &Connection) -> DoctorCheck {
    let mut stmt = match conn.prepare("PRAGMA integrity_check(20)") {
        Ok(s) => s,
        Err(err) => {
            return DoctorCheck {
                name: "sqlite_integrity".into(),
                status: DoctorStatus::Fail,
                detail: format!(
                    "PRAGMA integrity_check failed: {} (restore a backup with --restore <tag>)",
                    err
                ),
            };
        }
    };
    let rows_res = stmt.query_map([], |row| row.get::<_, String>(0));
    let mut issues = Vec::new();
    match rows_res {
        Ok(rows) => {
            for item in rows {
                match item {
                    Ok(val) => issues.push(val),
                    Err(err) => {
                        return DoctorCheck {
                            name: "sqlite_integrity".into(),
                            status: DoctorStatus::Fail,
                            detail: format!(
                                "integrity check read error: {} (restore a backup with --restore <tag>)",
                                err
                            ),
                        };
                    }
                }
            }
        }
        Err(err) => {
            return DoctorCheck {
                name: "sqlite_integrity".into(),
                status: DoctorStatus::Fail,
                detail: format!(
                    "PRAGMA integrity_check query failed: {} (restore a backup with --restore <tag>)",
                    err
                ),
            };
        }
    }

    if issues.len() == 1 && issues[0].eq_ignore_ascii_case("ok") {
        DoctorCheck {
            name: "sqlite_integrity".into(),
            status: DoctorStatus::Ok,
            detail: "PRAGMA integrity_check passed (ok)".into(),
        }
    } else {
        DoctorCheck {
            name: "sqlite_integrity".into(),
            status: DoctorStatus::Fail,
            detail: format!(
                "corruption detected ({} finding(s)): {}; restore a backup with --restore <tag>",
                issues.len(),
                issues.join("; ")
            ),
        }
    }
}

fn check_sqlite_foreign_keys(conn: &Connection) -> DoctorCheck {
    let mut stmt = match conn.prepare("PRAGMA foreign_key_check") {
        Ok(s) => s,
        Err(err) => {
            return DoctorCheck {
                name: "sqlite_foreign_keys".into(),
                status: DoctorStatus::Fail,
                detail: format!("PRAGMA foreign_key_check failed: {}", err),
            };
        }
    };
    let rows_res = stmt.query_map([], |row| {
        let table: String = row.get(0)?;
        let parent: String = row.get(2)?;
        Ok((table, parent))
    });
    let mut counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    match rows_res {
        Ok(rows) => {
            for item in rows {
                match item {
                    Ok(pair) => {
                        *counts.entry(pair).or_insert(0) += 1;
                    }
                    Err(err) => {
                        return DoctorCheck {
                            name: "sqlite_foreign_keys".into(),
                            status: DoctorStatus::Fail,
                            detail: format!("foreign key check read error: {}", err),
                        };
                    }
                }
            }
        }
        Err(err) => {
            return DoctorCheck {
                name: "sqlite_foreign_keys".into(),
                status: DoctorStatus::Fail,
                detail: format!("PRAGMA foreign_key_check query failed: {}", err),
            };
        }
    }

    if counts.is_empty() {
        DoctorCheck {
            name: "sqlite_foreign_keys".into(),
            status: DoctorStatus::Ok,
            detail: "PRAGMA foreign_key_check passed (0 violations)".into(),
        }
    } else {
        let summary: Vec<String> = counts
            .into_iter()
            .map(|((table, parent), n)| format!("{} -> {} ({} row(s))", table, parent, n))
            .collect();
        DoctorCheck {
            name: "sqlite_foreign_keys".into(),
            status: DoctorStatus::Fail,
            detail: format!(
                "orphaned foreign-key reference(s): {}",
                summary.join(", ")
            ),
        }
    }
}

fn format_mib(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

fn check_memory_and_lock_limits() -> DoctorCheck {
    let limits = SystemPlatformProbe.query_limits();
    let host_mib = format_mib(limits.host.total_bytes);
    let avail_mib = format_mib(limits.host.available_bytes);
    let cgroup_desc = limits
        .cgroup
        .max_bytes
        .map(|b| format!("{} MiB", format_mib(b)))
        .unwrap_or_else(|| "none".into());
    let memlock_desc = limits
        .rlimit_memlock_bytes
        .map(|b| format!("{} MiB", format_mib(b)))
        .unwrap_or_else(|| "unlimited".into());

    #[cfg(target_os = "linux")]
    let low_lock_budget = !limits.cap_ipc_lock
        && limits
            .rlimit_memlock_bytes
            .is_some_and(|b| b < 64 * 1024 * 1024);
    #[cfg(not(target_os = "linux"))]
    let low_lock_budget = false;

    let detail = format!(
        "host_ram={} MiB (avail {} MiB), cgroup_max={}, rlimit_memlock={}, cap_ipc_lock={}",
        host_mib, avail_mib, cgroup_desc, memlock_desc, limits.cap_ipc_lock
    );
    DoctorCheck {
        name: "memory_lock_limits".into(),
        status: if low_lock_budget {
            DoctorStatus::Warn
        } else {
            DoctorStatus::Ok
        },
        detail,
    }
}

fn check_live_readiness(app_data_dir: &Path, control_port: u16) -> DoctorCheck {
    match probe_healthcheck_with_data_dir(control_port, Some(app_data_dir)) {
        Ok(()) => DoctorCheck {
            name: "live_readiness".into(),
            status: DoctorStatus::Ok,
            detail: format!("running and ready on 127.0.0.1:{}", control_port),
        },
        Err(_) => DoctorCheck {
            name: "live_readiness".into(),
            status: DoctorStatus::Warn,
            detail: format!(
                "engine not currently listening on 127.0.0.1:{} (offline checks completed)",
                control_port
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_runtime::dragonfish::{
        load_or_create_identity, load_or_create_tls_certificate, load_pairing_token,
        DragonfishConfig,
    };
    use std::net::Ipv4Addr;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cadence_doctor_{}_{}_{}",
            label,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_valid_dir(dir: &Path) {
        let cfg = DragonfishConfig {
            app_data_dir: dir.to_path_buf(),
            ..DragonfishConfig::default()
        };
        let identity = load_or_create_identity(&cfg).unwrap();
        let _cert =
            load_or_create_tls_certificate(&cfg, Ipv4Addr::LOCALHOST, &identity).unwrap();
        let _token = load_pairing_token(dir).unwrap();
        let conn = Connection::open(dir.join("cadence.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE artists (id INTEGER PRIMARY KEY);
             CREATE TABLE albums (id INTEGER PRIMARY KEY, artist_id INTEGER REFERENCES artists(id));
             INSERT INTO artists (id) VALUES (1);
             INSERT INTO albums (id, artist_id) VALUES (10, 1);",
        )
        .unwrap();
    }

    #[test]
    fn doctor_reports_healthy_for_valid_db_and_identity() {
        let dir = temp_dir("healthy");
        seed_valid_dir(&dir);

        let report = run_engine_doctor(&dir, 4040);
        assert!(report.is_healthy(), "{}", report.format_text());
        assert_eq!(
            report
                .checks
                .iter()
                .find(|c| c.name == "sqlite_integrity")
                .unwrap()
                .status,
            DoctorStatus::Ok
        );
        assert_eq!(
            report
                .checks
                .iter()
                .find(|c| c.name == "sqlite_foreign_keys")
                .unwrap()
                .status,
            DoctorStatus::Ok
        );
        assert_eq!(
            report
                .checks
                .iter()
                .find(|c| c.name == "identity_and_tls")
                .unwrap()
                .status,
            DoctorStatus::Ok
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_detects_corrupt_sqlite_with_restore_advice() {
        let dir = temp_dir("corrupt");
        seed_valid_dir(&dir);
        std::fs::write(dir.join("cadence.db"), b"this is not a sqlite database").unwrap();

        let report = run_engine_doctor(&dir, 4040);
        assert!(!report.is_healthy(), "{}", report.format_text());
        let integrity = report
            .checks
            .iter()
            .find(|c| c.name == "sqlite_integrity")
            .unwrap();
        assert_eq!(integrity.status, DoctorStatus::Fail);
        assert!(
            integrity.detail.contains("--restore"),
            "missing restore hint: {}",
            integrity.detail
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_detects_foreign_key_violations() {
        let dir = temp_dir("fk_violation");
        seed_valid_dir(&dir);
        let conn = Connection::open(dir.join("cadence.db")).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO albums (id, artist_id) VALUES (99, 9999);",
        )
        .unwrap();
        drop(conn);

        let report = run_engine_doctor(&dir, 4040);
        assert!(!report.is_healthy(), "{}", report.format_text());
        let fk = report
            .checks
            .iter()
            .find(|c| c.name == "sqlite_foreign_keys")
            .unwrap();
        assert_eq!(fk.status, DoctorStatus::Fail);
        assert!(fk.detail.contains("albums -> artists"), "{}", fk.detail);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doctor_warns_gracefully_for_nonexistent_dir_without_creating_files() {
        let missing = std::env::temp_dir().join(format!(
            "cadence_doctor_missing_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        assert!(!missing.exists());

        let report = run_engine_doctor(&missing, 4040);
        assert!(report.is_healthy(), "{}", report.format_text());
        assert!(!missing.exists(), "doctor must never create files");
        assert!(report.checks.iter().any(|c| c.status == DoctorStatus::Warn));
    }
}
