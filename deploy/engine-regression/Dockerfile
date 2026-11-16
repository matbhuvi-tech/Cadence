FROM node:22-bookworm-slim AS node
FROM rust:1-bookworm AS test
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg strace && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY src-tauri ./src-tauri
COPY deploy/truenas-dragonfish ./deploy/truenas-dragonfish
COPY tests/engine ./tests/engine
RUN cargo build --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features bundled-sqlite --bin cadence-headless
ENV CADENCE_ENGINE_BINARY=/work/src-tauri/target/debug/cadence-headless
CMD ["python3", "tests/engine/run.py"]
