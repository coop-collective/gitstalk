#!/bin/sh
# The docker binary Wrangler uses for the gateway's deploy (WRANGLER_DOCKER_BIN): `docker build`
# gets the runner image's GIT_SHA build arg, every other command passes through unchanged.
# Wrangler's container config (image_vars) only takes fixed strings, hence this wrapper.
#
# GIT_SHA is the last commit that touched the runner's sources (this directory and the Cargo
# workspace files, the arenas' lockfiles the image installs), with "-dirty" when they have uncommitted or untracked changes, so a deploy that does not
# change the runner keeps the same image. Set GIT_SHA to override; DOCKER names the real binary.
set -eu
docker_bin="${DOCKER:-docker}"
if [ "${1:-}" != build ]; then
  exec "$docker_bin" "$@"
fi
shift
here="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${GIT_SHA:-}" ]; then
  sources=". ../../test-skipper ../../../pnpm-workspace.yaml ../../../pnpm-lock.yaml ../../../package.json ../../../Cargo.toml ../../../Cargo.lock ../../../research/real-arena/*/deps ../../../.dockerignore"
  # shellcheck disable=SC2086 # the pathspecs are meant to split
  GIT_SHA="$(git -C "$here" log -1 --format=%H -- $sources 2>/dev/null || true)"
  # shellcheck disable=SC2086
  if [ -n "$GIT_SHA" ] && [ -n "$(git -C "$here" status --porcelain -- $sources 2>/dev/null)" ]; then
    GIT_SHA="$GIT_SHA-dirty"
  fi
fi
exec "$docker_bin" build --build-arg "GIT_SHA=${GIT_SHA:-unknown}" "$@"
