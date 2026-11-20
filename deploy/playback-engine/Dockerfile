# syntax=docker/dockerfile:1.7
# Build natively on each target runner (linux/amd64, linux/arm64) or via Buildx.
FROM rust:1-bookworm AS build
ARG TARGETARCH
WORKDIR /build

COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo fetch --locked --manifest-path src-tauri/Cargo.toml

COPY src-tauri/build.rs ./src-tauri/
COPY src-tauri/src ./src-tauri/src

ARG CADENCE_VERSION=development
ARG CADENCE_BUILD_TAG=""
ARG CADENCE_BUILD_COMMITS_SINCE_TAG=""
ARG CADENCE_BUILD_SHA=""
ARG CADENCE_BUILD_DATE=""
ARG CADENCE_BUILD_SUMMARY=""

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=cadence-target-${TARGETARCH},target=/build/src-tauri/target \
    cargo build --locked --release --manifest-path src-tauri/Cargo.toml \
        --no-default-features --features bundled-sqlite --bin cadence-headless && \
    mkdir -p /out && \
    cp /build/src-tauri/target/release/cadence-headless /out/cadence-headless

FROM scratch AS binary
COPY --from=build /out/cadence-headless /cadence-headless

FROM debian:bookworm-slim AS runtime
ARG CADENCE_VERSION=development
LABEL org.opencontainers.image.title="Cadence Playback Engine" \
      org.opencontainers.image.version="${CADENCE_VERSION}" \
      org.opencontainers.image.source="https://github.com/matbhuvi-tech/Cadence" \
      org.opencontainers.image.description="Headless Linux Playback Engine"
RUN apt-get update && apt-get install -y --no-install-recommends cifs-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 568 cadence && useradd -u 568 -g 568 -d /var/lib/cadence -s /usr/sbin/nologin -M cadence \
    && mkdir -p /var/lib/cadence /music && chown 568:568 /var/lib/cadence /music
COPY --from=build /out/cadence-headless /usr/local/bin/cadence-headless
ENV CADENCE_APP_DATA_DIR=/var/lib/cadence CADENCE_MUSIC_DIR=/music CADENCE_TMP_DIR=/tmp \
    CADENCE_MUSIC_READ_ONLY=false CADENCE_CONTROL_PORT=4040 CADENCE_MEDIA_PORT=18890
# Default Standard profile uses kernel mount.cifs (requires root + SYS_ADMIN).
# Hardened Read-Only deployments override user to 568:568 via compose.hardened.yml.
USER 0:0
EXPOSE 4040/tcp 18890/tcp
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 CMD ["cadence-headless", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/cadence-headless"]
CMD ["--dragonfish"]
