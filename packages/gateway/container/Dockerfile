# syntax=docker/dockerfile:1
# check=skip=FromPlatformFlagConstDisallowed
# The runner image: git, Node 25, Mergiraf, bubblewrap, the real-task arenas' dependency snapshots
# and the runner binary on Debian trixie, linux/amd64.
# Cloudflare Containers run linux/amd64 only, so the final stage names that platform as a constant
# (the check skipped above).
# The build context is the repo root, so the Cargo workspace and Cargo.lock are visible:
#   docker buildx build --platform linux/amd64 -f packages/gateway/container/Dockerfile .

ARG RUST_VERSION=1.96.0
ARG DEBIAN_RELEASE=trixie
# The Node every suite runs on: the version the fastify arena pins (research/real-arena/fastify/
# arena.json "node") and its GitHub arm's setup-node installs. The shop arena runs on it too.
ARG NODE_VERSION=25.8.1

# Rust compiles on the build host's own architecture and links for x86_64, so builds on Apple
# Silicon do not run rustc under emulation. Only the final stage runs as amd64.
FROM --platform=$BUILDPLATFORM rust:${RUST_VERSION}-slim-${DEBIAN_RELEASE} AS chef
ARG RUST_VERSION
# rust-toolchain.toml names the "stable" channel; use the image's pinned toolchain rather than
# letting rustup download whatever stable is today.
ENV RUSTUP_TOOLCHAIN=${RUST_VERSION} \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc
RUN set -eux; \
    if [ "$(dpkg --print-architecture)" != amd64 ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends gcc-x86-64-linux-gnu libc6-dev-amd64-cross; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    rustup target add x86_64-unknown-linux-gnu; \
    cargo install cargo-chef --locked --version 0.1.78
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --target x86_64-unknown-linux-gnu -p runner --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked --target x86_64-unknown-linux-gnu -p runner

# Pure JS analyzer, bundled with its pinned parser; never resolves packages in a checked repo.
FROM --platform=$BUILDPLATFORM node:24.22.0-trixie-slim AS skipper
WORKDIR /app
RUN npm install --global pnpm@11.13.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/test-skipper/package.json packages/test-skipper/package.json
RUN pnpm install --frozen-lockfile --filter @gitstalk/test-skipper
COPY packages/test-skipper/src packages/test-skipper/src
RUN pnpm --filter @gitstalk/test-skipper build

# Release binaries, downloaded and verified natively. Node runs the arena's .ts files directly (the
# official build needs libatomic1 at run time); Mergiraf (GPL-3.0) ships only as this separate
# binary and runs only when a request asks for it.
FROM --platform=$BUILDPLATFORM debian:${DEBIAN_RELEASE}-slim AS tools
ARG NODE_VERSION
ARG NODE_SHA256=8c13c85f73b1f8e57d5fff0732b3f25880910aafa6d5c811073a2ec7fcd45b4c
ARG MERGIRAF_VERSION=0.20.0
# Upstream publishes no checksums; this is the release asset's SHA-256 as downloaded 2026-10-03.
ARG MERGIRAF_SHA256=4341127da8d1da29eced669fbacc1e5d6e530115098de0b82cc9dc551a1acf37
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tools
RUN curl -fsSLo node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c - \
 && tar -xJf node.tar.xz --strip-components=2 "node-v${NODE_VERSION}-linux-x64/bin/node" \
 && rm node.tar.xz
RUN curl -fsSLo mergiraf.tar.gz "https://codeberg.org/mergiraf/mergiraf/releases/download/v${MERGIRAF_VERSION}/mergiraf_x86_64-unknown-linux-gnu.tar.gz" \
 && echo "${MERGIRAF_SHA256}  mergiraf.tar.gz" | sha256sum -c - \
 && tar -xzf mergiraf.tar.gz mergiraf \
 && rm mergiraf.tar.gz \
 && printf 'mergiraf %s, GPL-3.0-only, unmodified upstream release binary.\nSource: https://codeberg.org/mergiraf/mergiraf/src/tag/v%s\n' \
      "${MERGIRAF_VERSION}" "${MERGIRAF_VERSION}" > MERGIRAF-NOTICE

# Dependency snapshots of the real-task arenas, installed from each arena's pinned lockfile at
# build time (the GitHub arm runs the same `npm ci --ignore-scripts` before its timed suite step),
# so a check links one and never installs: suites run offline and check time holds no install.
# npm runs natively and picks linux/x64 builds of the few platform-specific optional packages.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS deps
WORKDIR /opt/arena-deps/fastify
COPY research/real-arena/fastify/deps/package.json research/real-arena/fastify/deps/package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts --os=linux --cpu=x64 --libc=glibc \
 && rm -rf /root/.npm

FROM --platform=linux/amd64 debian:${DEBIAN_RELEASE}-slim
# bubblewrap gives each suite a network namespace with loopback only (src/check/sandbox.rs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates libatomic1 tini bubblewrap strace \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home --home-dir /home/runner --shell /usr/sbin/nologin runner \
 && install -d -o runner -g runner /work
COPY --from=tools /tools/node /tools/mergiraf /usr/local/bin/
COPY --from=tools /tools/MERGIRAF-NOTICE /usr/local/share/doc/mergiraf/NOTICE
COPY --from=deps /opt/arena-deps /opt/arena-deps
COPY --from=builder /app/target/x86_64-unknown-linux-gnu/release/runner /usr/local/bin/runner
COPY --from=skipper /app/packages/test-skipper/dist/cli.mjs /opt/gitstalk/skipper.mjs
COPY --from=skipper /app/packages/test-skipper/node_modules/acorn/LICENSE /usr/local/share/doc/gitstalk-skipper/ACORN-LICENSE
USER runner
# The commit the image was built from, reported by /version. Set last and read at run time, so a
# new value only changes this layer (the binary is not rebuilt). The gateway's deploy passes it
# (packages/gateway/container/README.md, "Image version").
ARG GIT_SHA=unknown
ENV PORT=8080 \
    GITSTALK_SKIPPER_PATH=/opt/gitstalk/skipper.mjs \
    WORK_DIR=/work \
    DEPS_DIR=/opt/arena-deps \
    RUST_LOG=info \
    GITSTALK_GIT_SHA=${GIT_SHA}
EXPOSE 8080
# tini is PID 1: it reaps test processes orphaned to it (a SIGKILLed suite's grandchildren would
# otherwise stay zombies for the instance's life) and forwards SIGTERM to the runner.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/runner"]
