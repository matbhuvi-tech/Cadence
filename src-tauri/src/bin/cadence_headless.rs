//! Tauri-independent headless Cadence Core executable.
//! Operates without GUI, WebView, WASAPI, ASIO, cpal, or rodio dependencies.
//!
//! Modes:
//! - Default stdio mode: `--db <path> [--engine-id ...] ...`
//! - Dragonfish container daemon mode: `--dragonfish` (reads `CADENCE_*` env vars & CLI flags)
//! - Container healthcheck: `--healthcheck [--control-port <port>]`
//! - Versioned backup / rollback: `--backup <tag>` / `--restore <tag>`
//! - Phase 9 snapshot migration: `--export-snapshot`, `--preview-import`, `--import-snapshot`, `--rollback-import`
//! - Recipe validator: `--validate-dragonfish-recipe <yaml> [--validate-dockerfile <dockerfile>]`

use cadence_core_lib::core_runtime::dragonfish::{
    probe_healthcheck, validate_dragonfish_custom_app_yaml, validate_dragonfish_dockerfile,
    DragonfishConfig, DragonfishNode, DEFAULT_CONTROL_PORT, DEFAULT_MEDIA_PORT,
};
use cadence_core_lib::core_runtime::migration::{
    export_consistent_snapshot, import_snapshot_into_core, preview_snapshot_import,
    rollback_snapshot_import, RootMapping, SnapshotImportOptions,
};
use cadence_core_lib::core_runtime::{
    HeadlessConfig, HeadlessCoreRuntime, DEFAULT_CONTAINER_HEADROOM_BYTES,
};
use cadence_core_lib::core_session::{Output, Renderer, RendererAction, RendererError};
use std::io::{self, BufRead, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn handle_unix_signal(_sig: libc::c_int) {
    SHUTDOWN_REQUESTED.store(true, Ordering::Release);
}

#[cfg(unix)]
fn install_signal_handlers() {
    unsafe {
        libc::signal(
            libc::SIGTERM,
            handle_unix_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            handle_unix_signal as *const () as libc::sighandler_t,
        );
    }
}

#[cfg(not(unix))]
fn install_signal_handlers() {}

struct HeadlessMailboxRenderer;

impl Renderer for HeadlessMailboxRenderer {
    fn apply(&mut self, _action: &RendererAction) -> Result<(), RendererError> {
        Ok(())
    }
}

enum CliMode {
    Help,
    Version,
    Stdio(HeadlessConfig),
    Dragonfish(DragonfishConfig),
    Healthcheck {
        control_port: u16,
    },
    Backup {
        app_data_dir: PathBuf,
        tag: String,
    },
    Restore {
        app_data_dir: PathBuf,
        tag: String,
    },
    ValidateRecipe {
        recipe_path: Option<PathBuf>,
        dockerfile_path: Option<PathBuf>,
    },
    ExportSnapshot {
        source_db_path: PathBuf,
        dest_snapshot_path: PathBuf,
    },
    PreviewImport {
        snapshot_path: PathBuf,
        mappings: Vec<RootMapping>,
        verify_filesystem_case: bool,
    },
    ImportSnapshot {
        snapshot_path: PathBuf,
        core_db_path: PathBuf,
        rollback_dir: PathBuf,
        options: SnapshotImportOptions,
    },
    RollbackImport {
        core_db_path: PathBuf,
        rollback_snapshot_path: PathBuf,
    },
}

fn env_u16(key: &str, default: u16) -> Result<u16, String> {
    match std::env::var(key) {
        Ok(val) if !val.trim().is_empty() => val
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("invalid {} value '{}'", key, val)),
        _ => Ok(default),
    }
}

fn env_u64(key: &str) -> Result<Option<u64>, String> {
    match std::env::var(key) {
        Ok(val) if !val.trim().is_empty() => val
            .trim()
            .parse::<u64>()
            .map(Some)
            .map_err(|_| format!("invalid {} value '{}'", key, val)),
        _ => Ok(None),
    }
}

fn env_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(val) => match val.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" => true,
            "0" | "false" | "no" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

fn print_usage() {
    println!(
        "Cadence Headless Playback Engine\n\
         Usage:\n\
         \tcadence-headless --dragonfish [--app-data-dir <path>] [--music-dir <path>] [--tmp-dir <path>] [--advertised-ip <ipv4>] [--control-port <u16>] [--media-port <u16>] [--label <name>] [--headroom-mb <mb>]\n\
         \tcadence-headless --healthcheck [--control-port <u16>]\n\
         \tcadence-headless --backup <tag> [--app-data-dir <path>] | --restore <tag> [--app-data-dir <path>]\n\
         \tcadence-headless --export-snapshot <src.db> <dest.db> | --preview-import ... | --import-snapshot ... | --rollback-import ...\n\
         \tcadence-headless --validate-dragonfish-recipe <yaml> [--validate-dockerfile <dockerfile>]\n\
         \tcadence-headless --db <path> [stdio flags...]\n\
         \tcadence-headless --version | --help"
    );
}

fn parse_args() -> Result<CliMode, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(CliMode::Help);
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        return Ok(CliMode::Version);
    }

    let is_dragonfish = args.iter().any(|a| a == "--dragonfish");
    let is_healthcheck = args.iter().any(|a| a == "--healthcheck");
    let has_recipe = args
        .iter()
        .any(|a| a == "--validate-dragonfish-recipe" || a == "--validate-dockerfile");
    let has_backup = args.iter().any(|a| a == "--backup");
    let has_restore = args.iter().any(|a| a == "--restore");
    let has_migration = args.iter().any(|a| {
        matches!(
            a.as_str(),
            "--export-snapshot" | "--preview-import" | "--import-snapshot" | "--rollback-import"
        )
    });

    if has_migration {
        return parse_migration_args(&args);
    }

    if has_recipe {
        let mut recipe_path: Option<PathBuf> = None;
        let mut dockerfile_path: Option<PathBuf> = None;
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--validate-dragonfish-recipe" => {
                    i += 1;
                    let val = args
                        .get(i)
                        .ok_or("missing path for --validate-dragonfish-recipe")?;
                    recipe_path = Some(PathBuf::from(val));
                }
                "--validate-dockerfile" => {
                    i += 1;
                    let val = args.get(i).ok_or("missing path for --validate-dockerfile")?;
                    dockerfile_path = Some(PathBuf::from(val));
                }
                other => return Err(format!("unknown argument: {}", other)),
            }
            i += 1;
        }
        return Ok(CliMode::ValidateRecipe {
            recipe_path,
            dockerfile_path,
        });
    }

    if is_healthcheck {
        let mut control_port = env_u16("CADENCE_CONTROL_PORT", DEFAULT_CONTROL_PORT)?;
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--healthcheck" => {}
                "--control-port" => {
                    i += 1;
                    let val = args.get(i).ok_or("missing value for --control-port")?;
                    control_port = val
                        .parse::<u16>()
                        .map_err(|_| "invalid --control-port value")?;
                }
                other => return Err(format!("unknown argument: {}", other)),
            }
            i += 1;
        }
        return Ok(CliMode::Healthcheck { control_port });
    }

    if has_backup || has_restore {
        let mut app_data_dir = PathBuf::from(
            std::env::var("CADENCE_APP_DATA_DIR").unwrap_or_else(|_| "/var/lib/cadence".into()),
        );
        let mut backup_tag: Option<String> = None;
        let mut restore_tag: Option<String> = None;
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--app-data-dir" => {
                    i += 1;
                    let val = args.get(i).ok_or("missing value for --app-data-dir")?;
                    app_data_dir = PathBuf::from(val);
                }
                "--backup" => {
                    i += 1;
                    let val = args.get(i).ok_or("missing tag for --backup")?;
                    backup_tag = Some(val.clone());
                }
                "--restore" => {
                    i += 1;
                    let val = args.get(i).ok_or("missing tag for --restore")?;
                    restore_tag = Some(val.clone());
                }
                other => return Err(format!("unknown argument: {}", other)),
            }
            i += 1;
        }
        if let Some(tag) = backup_tag {
            return Ok(CliMode::Backup { app_data_dir, tag });
        }
        if let Some(tag) = restore_tag {
            return Ok(CliMode::Restore { app_data_dir, tag });
        }
    }

    if is_dragonfish {
        let mut cfg = DragonfishConfig::default();
        if let Ok(v) = std::env::var("CADENCE_APP_DATA_DIR") {
            if !v.trim().is_empty() {
                cfg.app_data_dir = PathBuf::from(v);
            }
        }
        if let Ok(v) = std::env::var("CADENCE_MUSIC_DIR") {
            if !v.trim().is_empty() {
                cfg.music_mount_dir = PathBuf::from(v);
            }
        }
        if let Ok(v) = std::env::var("CADENCE_TMP_DIR") {
            if !v.trim().is_empty() {
                cfg.tmp_dir = PathBuf::from(v);
            }
        }
        if let Ok(v) = std::env::var("CADENCE_ADVERTISED_IP") {
            cfg.advertised_ip = v;
        }
        if let Ok(v) = std::env::var("CADENCE_LABEL") {
            if !v.trim().is_empty() {
                cfg.label = v;
            }
        }
        if let Ok(v) = std::env::var("CADENCE_PINNED_RS130_UDN") {
            if !v.trim().is_empty() {
                cfg.pinned_rs130_udn = Some(v);
            }
        }
        cfg.music_read_only = env_bool("CADENCE_MUSIC_READ_ONLY", true);
        cfg.allow_loopback_for_tests = env_bool("CADENCE_ALLOW_LOOPBACK", false);
        let control_port = env_u16("CADENCE_CONTROL_PORT", DEFAULT_CONTROL_PORT)?;
        let media_port = env_u16("CADENCE_MEDIA_PORT", DEFAULT_MEDIA_PORT)?;
        cfg.control_bind_addr = SocketAddr::from(([0, 0, 0, 0], control_port));
        cfg.media_bind_addr = SocketAddr::from(([0, 0, 0, 0], media_port));
        if let Some(mb) = env_u64("CADENCE_HEADROOM_MB")? {
            cfg.headroom_bytes = mb.saturating_mul(1024 * 1024);
        }
        if let Some(mb) = env_u64("CADENCE_MIN_LOCKABLE_MB")? {
            cfg.min_lockable_bytes = mb.saturating_mul(1024 * 1024);
        }

        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--dragonfish" => {}
                "--app-data-dir" => {
                    i += 1;
                    cfg.app_data_dir =
                        PathBuf::from(args.get(i).ok_or("missing --app-data-dir")?);
                }
                "--music-dir" => {
                    i += 1;
                    cfg.music_mount_dir =
                        PathBuf::from(args.get(i).ok_or("missing --music-dir")?);
                }
                "--tmp-dir" => {
                    i += 1;
                    cfg.tmp_dir = PathBuf::from(args.get(i).ok_or("missing --tmp-dir")?);
                }
                "--advertised-ip" => {
                    i += 1;
                    cfg.advertised_ip = args.get(i).ok_or("missing --advertised-ip")?.clone();
                }
                "--control-port" => {
                    i += 1;
                    let p: u16 = args
                        .get(i)
                        .ok_or("missing --control-port")?
                        .parse()
                        .map_err(|_| "invalid --control-port")?;
                    cfg.control_bind_addr = SocketAddr::from(([0, 0, 0, 0], p));
                }
                "--media-port" => {
                    i += 1;
                    let p: u16 = args
                        .get(i)
                        .ok_or("missing --media-port")?
                        .parse()
                        .map_err(|_| "invalid --media-port")?;
                    cfg.media_bind_addr = SocketAddr::from(([0, 0, 0, 0], p));
                }
                "--label" => {
                    i += 1;
                    cfg.label = args.get(i).ok_or("missing --label")?.clone();
                }
                "--headroom-mb" => {
                    i += 1;
                    let mb: u64 = args
                        .get(i)
                        .ok_or("missing --headroom-mb")?
                        .parse()
                        .map_err(|_| "invalid --headroom-mb")?;
                    cfg.headroom_bytes = mb.saturating_mul(1024 * 1024);
                }
                other => return Err(format!("unknown argument: {}", other)),
            }
            i += 1;
        }

        return Ok(CliMode::Dragonfish(cfg));
    }

    // Legacy Phase 4 stdio mode
    let mut db_path: Option<PathBuf> = None;
    let mut engine_id = String::from("cadence-core");
    let mut library_id = String::from("default-library");
    let mut label = String::from("Cadence Headless Core");
    let mut output_id = String::from("rs130-upnp");
    let mut output_label = String::from("HiFi ROSE RS130");
    let mut headroom_bytes = DEFAULT_CONTAINER_HEADROOM_BYTES;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--db" => {
                i += 1;
                let val = args.get(i).ok_or("missing value for --db")?;
                db_path = Some(PathBuf::from(val));
            }
            "--engine-id" => {
                i += 1;
                engine_id = args.get(i).ok_or("missing value for --engine-id")?.clone();
            }
            "--library-id" => {
                i += 1;
                library_id = args.get(i).ok_or("missing value for --library-id")?.clone();
            }
            "--label" => {
                i += 1;
                label = args.get(i).ok_or("missing value for --label")?.clone();
            }
            "--output-id" => {
                i += 1;
                output_id = args.get(i).ok_or("missing value for --output-id")?.clone();
            }
            "--output-label" => {
                i += 1;
                output_label = args
                    .get(i)
                    .ok_or("missing value for --output-label")?
                    .clone();
            }
            "--headroom-mb" => {
                i += 1;
                let mb: u64 = args
                    .get(i)
                    .ok_or("missing value for --headroom-mb")?
                    .parse()
                    .map_err(|_| "invalid --headroom-mb value")?;
                headroom_bytes = mb.saturating_mul(1024 * 1024);
            }
            other => return Err(format!("unknown argument: {}", other)),
        }
        i += 1;
    }

    let db_path = db_path.ok_or("missing required --db <path> argument")?;
    Ok(CliMode::Stdio(HeadlessConfig {
        db_path,
        engine_id,
        library_id,
        label,
        output: Some(Output {
            id: output_id,
            label: output_label,
            transport: "upnp".into(),
        }),
        headroom_bytes,
    }))
}

fn parse_migration_args(args: &[String]) -> Result<CliMode, String> {
    let mut app_data_dir = PathBuf::from(
        std::env::var("CADENCE_APP_DATA_DIR").unwrap_or_else(|_| "/var/lib/cadence".into()),
    );
    let mut core_db_override: Option<PathBuf> = None;
    let mut rollback_dir_override: Option<PathBuf> = None;
    let mut export_paths: Option<(PathBuf, PathBuf)> = None;
    let mut preview_snapshot: Option<PathBuf> = None;
    let mut import_snapshot: Option<PathBuf> = None;
    let mut rollback_snapshot: Option<PathBuf> = None;
    let mut mappings: Vec<RootMapping> = Vec::new();
    let mut enforce_case_sensitive = true;
    let mut include_unmapped = false;
    let mut rollback_tag = String::from("pre-import");

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--export-snapshot" => {
                let src = args
                    .get(i + 1)
                    .ok_or("missing source_db_path for --export-snapshot")?;
                let dst = args
                    .get(i + 2)
                    .ok_or("missing dest_snapshot_path for --export-snapshot")?;
                export_paths = Some((PathBuf::from(src), PathBuf::from(dst)));
                i += 2;
            }
            "--preview-import" => {
                i += 1;
                let path = args
                    .get(i)
                    .ok_or("missing snapshot_path for --preview-import")?;
                preview_snapshot = Some(PathBuf::from(path));
            }
            "--import-snapshot" => {
                i += 1;
                let path = args
                    .get(i)
                    .ok_or("missing snapshot_path for --import-snapshot")?;
                import_snapshot = Some(PathBuf::from(path));
            }
            "--rollback-import" => {
                i += 1;
                let path = args
                    .get(i)
                    .ok_or("missing rollback_snapshot_path for --rollback-import")?;
                rollback_snapshot = Some(PathBuf::from(path));
            }
            "--app-data-dir" => {
                i += 1;
                let val = args.get(i).ok_or("missing value for --app-data-dir")?;
                app_data_dir = PathBuf::from(val);
            }
            "--core-db" => {
                i += 1;
                let val = args.get(i).ok_or("missing value for --core-db")?;
                core_db_override = Some(PathBuf::from(val));
            }
            "--rollback-dir" => {
                i += 1;
                let val = args.get(i).ok_or("missing value for --rollback-dir")?;
                rollback_dir_override = Some(PathBuf::from(val));
            }
            "--map-root" => {
                i += 1;
                let val = args.get(i).ok_or("missing value for --map-root")?;
                let (win, core) = val
                    .split_once('=')
                    .ok_or("--map-root must use <windows_prefix>=<core_prefix> syntax")?;
                if win.trim().is_empty() || core.trim().is_empty() {
                    return Err("--map-root requires non-empty windows and core prefixes".into());
                }
                mappings.push(RootMapping {
                    windows_prefix: win.to_string(),
                    core_prefix: core.to_string(),
                });
            }
            "--no-case-check" => {
                enforce_case_sensitive = false;
            }
            "--include-unmapped" => {
                include_unmapped = true;
            }
            "--rollback-tag" => {
                i += 1;
                let val = args.get(i).ok_or("missing value for --rollback-tag")?;
                rollback_tag = val.clone();
            }
            other => return Err(format!("unknown argument: {}", other)),
        }
        i += 1;
    }

    let action_count = usize::from(export_paths.is_some())
        + usize::from(preview_snapshot.is_some())
        + usize::from(import_snapshot.is_some())
        + usize::from(rollback_snapshot.is_some());
    if action_count != 1 {
        return Err("specify exactly one of --export-snapshot, --preview-import, --import-snapshot, or --rollback-import".into());
    }

    if let Some((source_db_path, dest_snapshot_path)) = export_paths {
        return Ok(CliMode::ExportSnapshot {
            source_db_path,
            dest_snapshot_path,
        });
    }
    if let Some(snapshot_path) = preview_snapshot {
        return Ok(CliMode::PreviewImport {
            snapshot_path,
            mappings,
            verify_filesystem_case: enforce_case_sensitive,
        });
    }

    let core_db_path = core_db_override.unwrap_or_else(|| app_data_dir.join("cadence.db"));
    let rollback_dir = rollback_dir_override
        .unwrap_or_else(|| app_data_dir.join("backups").join("imports"));

    if let Some(snapshot_path) = import_snapshot {
        return Ok(CliMode::ImportSnapshot {
            snapshot_path,
            core_db_path,
            rollback_dir,
            options: SnapshotImportOptions {
                mappings,
                enforce_case_sensitive,
                include_unmapped,
                rollback_tag,
            },
        });
    }
    if let Some(rollback_snapshot_path) = rollback_snapshot {
        return Ok(CliMode::RollbackImport {
            core_db_path,
            rollback_snapshot_path,
        });
    }

    Err("invalid migration arguments".into())
}

fn main() {
    let mode = match parse_args() {
        Ok(m) => m,
        Err(err) => {
            eprintln!("[cadence-headless] argument error: {}", err);
            std::process::exit(2);
        }
    };

    match mode {
        CliMode::Help => {
            print_usage();
        }
        CliMode::Version => {
            println!("cadence-headless {}", env!("CADENCE_BUILD_DISPLAY"));
        }
        CliMode::ValidateRecipe {
            recipe_path,
            dockerfile_path,
        } => {
            if let Some(path) = recipe_path {
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!(
                            "[cadence-headless] failed to read {}: {}",
                            path.display(),
                            e
                        );
                        std::process::exit(1);
                    }
                };
                if let Err(err) = validate_dragonfish_custom_app_yaml(&text) {
                    eprintln!("[cadence-headless] {}", err.user_message());
                    std::process::exit(1);
                }
            }
            if let Some(path) = dockerfile_path {
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!(
                            "[cadence-headless] failed to read {}: {}",
                            path.display(),
                            e
                        );
                        std::process::exit(1);
                    }
                };
                if let Err(err) = validate_dragonfish_dockerfile(&text) {
                    eprintln!("[cadence-headless] {}", err.user_message());
                    std::process::exit(1);
                }
            }
            println!("dragonfish recipe validation ok");
        }
        CliMode::Healthcheck { control_port } => {
            if let Err(err) = probe_healthcheck(control_port) {
                eprintln!("[cadence-headless] healthcheck failed: {}", err);
                std::process::exit(1);
            }
            println!("ok");
        }
        CliMode::Backup { app_data_dir, tag } => {
            match DragonfishNode::create_versioned_backup_offline(
                &app_data_dir,
                env!("CARGO_PKG_VERSION"),
                &tag,
            ) {
                Ok(dir) => println!("backup created: {}", dir.display()),
                Err(err) => {
                    eprintln!("[cadence-headless] backup failed: {}", err.user_message());
                    std::process::exit(1);
                }
            }
        }
        CliMode::Restore { app_data_dir, tag } => {
            match DragonfishNode::restore_versioned_backup(&app_data_dir, &tag) {
                Ok(manifest) => println!(
                    "backup restored: tag={} appVersion={} schemaVersion={}",
                    manifest.tag, manifest.app_version, manifest.schema_version
                ),
                Err(err) => {
                    eprintln!("[cadence-headless] restore failed: {}", err.user_message());
                    std::process::exit(1);
                }
            }
        }
        CliMode::ExportSnapshot {
            source_db_path,
            dest_snapshot_path,
        } => {
            if let Err(err) = export_consistent_snapshot(&source_db_path, &dest_snapshot_path) {
                eprintln!("[cadence-headless] export-snapshot failed: {}", err);
                std::process::exit(1);
            }
            println!(
                "snapshot exported: {}",
                dest_snapshot_path.display()
            );
        }
        CliMode::PreviewImport {
            snapshot_path,
            mappings,
            verify_filesystem_case,
        } => {
            match preview_snapshot_import(&snapshot_path, &mappings, verify_filesystem_case) {
                Ok(preview) => match serde_json::to_string_pretty(&preview) {
                    Ok(json) => println!("{}", json),
                    Err(err) => {
                        eprintln!("[cadence-headless] failed to serialize preview: {}", err);
                        std::process::exit(1);
                    }
                },
                Err(err) => {
                    eprintln!("[cadence-headless] preview-import failed: {}", err);
                    std::process::exit(1);
                }
            }
        }
        CliMode::ImportSnapshot {
            snapshot_path,
            core_db_path,
            rollback_dir,
            options,
        } => {
            match import_snapshot_into_core(&snapshot_path, &core_db_path, &rollback_dir, options) {
                Ok(result) => match serde_json::to_string_pretty(&result) {
                    Ok(json) => println!("{}", json),
                    Err(err) => {
                        eprintln!("[cadence-headless] failed to serialize import result: {}", err);
                        std::process::exit(1);
                    }
                },
                Err(err) => {
                    eprintln!("[cadence-headless] import-snapshot failed: {}", err);
                    std::process::exit(1);
                }
            }
        }
        CliMode::RollbackImport {
            core_db_path,
            rollback_snapshot_path,
        } => {
            if let Err(err) = rollback_snapshot_import(&core_db_path, &rollback_snapshot_path) {
                eprintln!("[cadence-headless] rollback-import failed: {}", err);
                std::process::exit(1);
            }
            println!(
                "import rolled back: {} <- {}",
                core_db_path.display(),
                rollback_snapshot_path.display()
            );
        }
        CliMode::Dragonfish(cfg) => {
            install_signal_handlers();
            let mut node = match DragonfishNode::bootstrap(cfg) {
                Ok(n) => n,
                Err(err) => {
                    eprintln!(
                        "[cadence-headless] dragonfish readiness failed: {}",
                        err.user_message()
                    );
                    std::process::exit(1);
                }
            };
            println!(
                "[cadence-headless] dragonfish ready engineId={} libraryId={} advertisedIp={} control={} media={} tlsSha256={}",
                node.identity().engine_id,
                node.identity().library_id,
                node.advertised_ip(),
                node.control_listen_addr(),
                node.media_listen_addr(),
                node.tls_certificate().sha256_fingerprint
            );
            while !SHUTDOWN_REQUESTED.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(200));
            }
            if let Err(err) = node.shutdown() {
                eprintln!(
                    "[cadence-headless] dragonfish shutdown error: {}",
                    err.user_message()
                );
                std::process::exit(1);
            }
        }
        CliMode::Stdio(config) => {
            let mut runtime = match HeadlessCoreRuntime::open(config, HeadlessMailboxRenderer) {
                Ok(rt) => rt,
                Err(err) => {
                    eprintln!("[cadence-headless] failed to open runtime: {:?}", err);
                    std::process::exit(1);
                }
            };

            let stdin = io::stdin();
            let mut stdout = io::stdout();
            for line_res in stdin.lock().lines() {
                let Ok(line) = line_res else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let response = runtime.request(trimmed.as_bytes());
                if let Ok(serialized) = serde_json::to_string(&response) {
                    let _ = writeln!(stdout, "{}", serialized);
                    let _ = stdout.flush();
                }
            }

            if let Err(err) = runtime.shutdown() {
                eprintln!("[cadence-headless] shutdown error: {:?}", err);
                std::process::exit(1);
            }
        }
    }
}
