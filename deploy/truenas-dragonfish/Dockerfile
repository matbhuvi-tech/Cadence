# syntax=docker/dockerfile:1.7
# Versioned linux/amd64 OCI image for Cadence Core on TrueNAS SCALE Dragonfish 24.04.
# Builds only the Tauri-independent `cadence-headless` binary (--no-default-features).

FROM --platform=linux/amd64 rust:1-bookworm AS builder

WORKDIR /build

COPY src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs ./src-tauri/
COPY src-tauri/src ./src-tauri/src

ARG CADENCE_VERSION=0.1.0
ARG CADENCE_BUILD_TAG=""
ARG CADENCE_BUILD_COMMITS_SINCE_TAG=""
ARG CADENCE_BUILD_SHA=""
ARG CADENCE_BUILD_DATE=""
ARG CADENCE_BUILD_SUMMARY=""

RUN cargo build \
    --manifest-path /build/src-tauri/Cargo.toml \
    --locked \
    --release \
    --no-default-features \
    --features bundled-sqlite \
    --bin cadence-headless

FROM --platform=linux/amd64 debian:bookworm-slim AS runtime

ARG CADENCE_VERSION=0.1.0
LABEL org.opencontainers.image.title="cadence-core" \
      org.opencontainers.image.version="${CADENCE_VERSION}" \
      org.opencontainers.image.description="Headless Cadence Core for TrueNAS SCALE Dragonfish 24.04"

RUN apt-get update \
    && apt-get install -y --no-install-recommends cifs-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 568 apps \
    && useradd -u 568 -g 568 -d /var/lib/cadence -s /usr/sbin/nologin -M apps \
    && mkdir -p /var/lib/cadence /music /tmp \
    && chown -R 568:568 /var/lib/cadence /music

COPY --from=builder /build/src-tauri/target/release/cadence-headless /usr/local/bin/cadence-headless

ENV CADENCE_APP_DATA_DIR=/var/lib/cadence \
    CADENCE_MUSIC_DIR=/music \
    CADENCE_TMP_DIR=/tmp \
    CADENCE_MUSIC_READ_ONLY=true \
    CADENCE_CONTROL_PORT=4040 \
    CADENCE_MEDIA_PORT=18890

USER 568:568

EXPOSE 4040/tcp 18890/tcp

VOLUME ["/var/lib/cadence"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/cadence-headless", "--healthcheck"]

ENTRYPOINT ["/usr/local/bin/cadence-headless"]
CMD ["--dragonfish"]
