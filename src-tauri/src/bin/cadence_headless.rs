//! Tauri-independent headless Cadence Core executable.
//! Operates without GUI, WebView, WASAPI, ASIO, cpal, or rodio dependencies.

use cadence_core_lib::core_runtime::{
    HeadlessConfig, HeadlessCoreRuntime, DEFAULT_CONTAINER_HEADROOM_BYTES,
};
use cadence_core_lib::core_session::{Output, Renderer, RendererAction, RendererError};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

struct HeadlessMailboxRenderer;

impl Renderer for HeadlessMailboxRenderer {
    fn apply(&mut self, _action: &RendererAction) -> Result<(), RendererError> {
        Ok(())
    }
}

fn parse_args() -> Result<HeadlessConfig, String> {
    let mut db_path: Option<PathBuf> = None;
    let mut engine_id = String::from("cadence-core");
    let mut library_id = String::from("default-library");
    let mut label = String::from("Cadence Headless Core");
    let mut output_id = String::from("rs130-upnp");
    let mut output_label = String::from("HiFi ROSE RS130");
    let mut headroom_bytes = DEFAULT_CONTAINER_HEADROOM_BYTES;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => {
                let val = args.next().ok_or("missing value for --db")?;
                db_path = Some(PathBuf::from(val));
            }
            "--engine-id" => {
                engine_id = args.next().ok_or("missing value for --engine-id")?;
            }
            "--library-id" => {
                library_id = args.next().ok_or("missing value for --library-id")?;
            }
            "--label" => {
                label = args.next().ok_or("missing value for --label")?;
            }
            "--output-id" => {
                output_id = args.next().ok_or("missing value for --output-id")?;
            }
            "--output-label" => {
                output_label = args.next().ok_or("missing value for --output-label")?;
            }
            "--headroom-mb" => {
                let mb: u64 = args
                    .next()
                    .ok_or("missing value for --headroom-mb")?
                    .parse()
                    .map_err(|_| "invalid --headroom-mb value")?;
                headroom_bytes = mb.saturating_mul(1024 * 1024);
            }
            other => return Err(format!("unknown argument: {}", other)),
        }
    }

    let db_path = db_path.ok_or("missing required --db <path> argument")?;
    Ok(HeadlessConfig {
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
    })
}

fn main() {
    let config = match parse_args() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("[cadence-headless] argument error: {}", err);
            std::process::exit(2);
        }
    };

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
