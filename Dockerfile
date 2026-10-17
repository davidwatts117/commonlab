# syntax=docker/dockerfile:1
# CommonLab application server: the Axum binary plus the public/ assets it serves.
# The AI generation worker has its own image (worker/Dockerfile).

ARG RUST_VERSION=1.97
ARG DEBIAN_RELEASE=trixie

# ---- Build -----------------------------------------------------------------
FROM rust:${RUST_VERSION}-slim-${DEBIAN_RELEASE} AS build
WORKDIR /src

# Compile dependencies first so source edits reuse this layer.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo 'fn main() {}' > src/main.rs \
    && touch src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src

# The definition schema is compiled into the binary (include_str!).
COPY schema ./schema
COPY src ./src
# Bump mtimes so cargo rebuilds the real crate rather than the stub.
RUN touch src/main.rs src/lib.rs \
    && cargo build --release --locked \
    && install -m 0755 target/release/commonlab /usr/local/bin/commonlab

# ---- Runtime ---------------------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim AS runtime

# Unprivileged runtime user; the database volume is the only writable path it needs.
ARG APP_UID=10001
RUN mkdir -p /data && chown ${APP_UID}:${APP_UID} /data && chmod 0700 /data

COPY --from=build /usr/local/bin/commonlab /usr/local/bin/commonlab
# Assets stay root-owned and read-only to the server process.
COPY public /app/public

WORKDIR /app
ENV BIND_ADDR=0.0.0.0:8000 \
    PUBLIC_DIR=/app/public \
    DATABASE_PATH=/data/commonlab.sqlite3

USER ${APP_UID}:${APP_UID}
VOLUME ["/data"]
EXPOSE 8000

# No curl in the slim image: probe /healthz with bash's /dev/tcp instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${BIND_ADDR##*:} && printf 'GET /healthz HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && grep -q '^ok' <&3"]

# Extra arguments reach the binary, e.g. `withdraw <submission-id> <note>`.
ENTRYPOINT ["commonlab"]
