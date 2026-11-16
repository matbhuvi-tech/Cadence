FROM rust:1-bookworm AS test
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg strace && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY src-tauri ./src-tauri
COPY tests/engine ./tests/engine
RUN cargo build --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite --bin cadence-headless
ENV CADENCE_ENGINE_BINARY=/work/src-tauri/target/debug/cadence-headless
CMD ["python3", "-m", "unittest", "discover", "-s", "tests/engine", "-v"]
