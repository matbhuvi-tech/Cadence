"""Run both native and real-process regression layers; fail if either fails."""
import subprocess
import sys

native = subprocess.run(["cargo", "test", "--offline", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
                         "--no-default-features", "--features", "bundled-sqlite", "--", "--test-threads=1"])
http = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests/engine", "-v"])
sys.exit(0 if native.returncode == 0 and http.returncode == 0 else 1)
