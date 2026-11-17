# syntax=docker/dockerfile:1.7
# Build for the target platform, including arm64 (BuildKit/QEMU or native builder).
FROM rust:1-bookworm AS build
WORKDIR /build
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs ./src-tauri/
COPY src-tauri/src ./src-tauri/src
RUN cargo build --locked --release --manifest-path src-tauri/Cargo.toml \
    --no-default-features --features bundled-sqlite --bin cadence-headless

FROM debian:bookworm-slim
ARG CADENCE_VERSION=development
LABEL org.opencontainers.image.title="Cadence Playback Engine" \
      org.opencontainers.image.version="${CADENCE_VERSION}" \
      org.opencontainers.image.source="https://github.com/matbhuvi-tech/Cadence" \
      org.opencontainers.image.description="Headless Linux Playback Engine"
RUN apt-get update && apt-get install -y --no-install-recommends cifs-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 568 cadence && useradd -u 568 -g 568 -d /var/lib/cadence -s /usr/sbin/nologin -M cadence \
    && mkdir -p /var/lib/cadence /music && chown 568:568 /var/lib/cadence /music
COPY --from=build /build/src-tauri/target/release/cadence-headless /usr/local/bin/cadence-headless
ENV CADENCE_APP_DATA_DIR=/var/lib/cadence CADENCE_MUSIC_DIR=/music CADENCE_TMP_DIR=/tmp \
    CADENCE_MUSIC_READ_ONLY=false CADENCE_CONTROL_PORT=4040 CADENCE_MEDIA_PORT=18890
# Kernel CIFS mounts require root in this single-process deployment.
# Cadence must still keep app-data files accessible to UID 568 (readiness contract).
USER 0:0
EXPOSE 4040/tcp 18890/tcp
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 CMD ["cadence-headless", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/cadence-headless"]
CMD ["--dragonfish"]
