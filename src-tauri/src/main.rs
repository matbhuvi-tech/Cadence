// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_else(|| "unknown".into());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<Any>".into()
        };
        let backtrace = std::backtrace::Backtrace::force_capture();
        let log = format!("PANIC at {}\nMessage: {}\nBacktrace:\n{:?}", location, payload, backtrace);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open("panic.log") {
            let _ = writeln!(f, "================== PANIC ==================\n{}\n", log);
        }
        eprintln!("{}", log);
    }));

    cadence_core_lib::run();
}
