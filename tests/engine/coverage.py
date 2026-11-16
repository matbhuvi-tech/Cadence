"""Optional native + HTTP coverage; requires cargo-llvm-cov and llvm-tools.

Run in the Linux regression image after installing those build-time tools.
No test is skipped if native tests fail: both results remain visible.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
crate = root / "src-tauri"
env = dict(os.environ)
output = subprocess.check_output(["cargo", "llvm-cov", "show-env", "--sh"], cwd=crate, text=True)
for line in output.splitlines():
    if line.startswith("export "):
        key, value = line.removeprefix("export ").split("=", 1)
        env[key] = shlex.split(value)[0]
native = subprocess.run(["cargo", "test", "--locked", "--no-default-features", "--features", "bundled-sqlite", "--", "--test-threads=1"], cwd=crate, env=env)
env["CADENCE_ENGINE_BINARY"] = str(crate / "target/debug/cadence-headless")
http = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests/engine", "-v"], cwd=root, env=env)
report = root / "phase1-coverage.json"
subprocess.run(["cargo", "llvm-cov", "report", "--json", "--output-path", str(report)], cwd=crate, env=env, check=True)
for file in json.loads(report.read_text())["data"][0]["files"]:
    if file["filename"].endswith(("core_runtime/library.rs", "curation/tag_writer.rs", "scanner/media.rs")):
        print(file["filename"], file["summary"]["lines"], flush=True)
sys.exit(0 if native.returncode == 0 and http.returncode == 0 else 1)
