# Rust container package

A container is a Rust crate in `packages/<worker>/container/`, inside the TypeScript Worker package whose Container Durable Object class owns it (the gateway's runner, the SSH Worker's server, the Actions executor's job runner). Use the existing root `Cargo.toml`, pinned toolchain and a comparable crate in `packages/gateway/container`, `packages/ssh/container` or `packages/actions-executor/container` for Rust/build wiring. `clean-code-rust` is an explicitly assigned maintenance review, not a bootstrap prerequisite. This file covers the Worker side and the build wiring.

## Contents
- Directory layout
- Container class in the owning Worker
- wrangler.jsonc containers block
- Build context and .dockerignore
- Local development and deploy
- Talking to the container

## Directory layout

```
packages/integrator/           TypeScript Worker that owns the container
  src/index.ts                 exports WorldBuilder (Container class) and the WorkerEntrypoint
  wrangler.jsonc               containers block points at ./container/Dockerfile
  container/                   Rust crate `world-builder` (Cargo.toml, Dockerfile, src/, tests/)
```

Add the crate to `members` in the root `Cargo.toml` (`"packages/integrator/container"`). One crate per container image; one Container class per crate, so a Worker owns at most one container directory. The Worker's `tsconfig.json` (`src/`, `test/`) and `vitest.config.ts` (`test/**/*.test.ts`) include only their own globs, so they never scan `container/`; `container/` has no `package.json`, so the pnpm workspace (`packages/*`) does not see it.

## Container class in the owning Worker

```ts
// packages/integrator/src/world-builder.ts
import { Container } from '@cloudflare/containers';

export class WorldBuilder extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = '10m';
  override enableInternet = false;
  override envVars = {
    PORT: '8080',
    RUST_LOG: 'info',
  };

  override onStart(): void {
    console.log(JSON.stringify({ level: 'info', msg: 'world-builder started', id: this.ctx.id.toString() }));
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    console.log(JSON.stringify({ level: 'info', msg: 'world-builder stopped', ...params }));
  }
}
```

- Per-instance secrets (a short-lived gateway token) are passed through `envVars` set in the constructor from `this.env`, or sent per request in a header; never baked into the image.
- `enableInternet` is explicit. The world builder needs egress only to the gateway and the Artifacts git remote: keep `enableInternet = false` and call `await this.setAllowedHosts([gatewayHost, artifactsHost])` before starting the container (allowed hosts get access even when internet is off; `setDeniedHosts` blocks unconditionally). The class also supports `setOutboundByHosts` to route a host through a Worker handler, which is how a container can reach a binding-backed proxy without raw internet.
- Route requests with `getContainer(env.WORLD_BUILDER, worldId).fetch(request)`; one instance per world id keeps a job's filesystem on one container for its lifetime. Use `getRandom` for stateless pools.

## wrangler.jsonc containers block

```jsonc
{
  "containers": [
    {
      "class_name": "WorldBuilder",
      "image": "./container/Dockerfile",
      "image_build_context": "../..",
      "instance_type": "standard-1",
      "max_instances": 10
    }
  ],
  "exports": {
    "WorldBuilder": { "type": "durable-object", "storage": "sqlite" }
  },
  "durable_objects": {
    "bindings": [{ "name": "WORLD_BUILDER", "class_name": "WorldBuilder" }]
  }
}
```

`instance_type` options: `lite`, `basic`, `standard-1` to `standard-4` (4 vCPU, 12 GiB, 20 GB). Start at `standard-1` for git plus Mergiraf work and move only with a measurement.

## Build context and .dockerignore

`image_build_context` is the repo root so the Dockerfile sees the Cargo workspace and `Cargo.lock`. The root `.dockerignore` excludes `node_modules`, `target`, `.git`, `docs`, `research`, `.agents` and `.claude`; keep it current or image builds become slow and large. Images must be `linux/amd64`.

## Local development and deploy

- Docker must be running (`docker info`) for `wrangler dev` and `wrangler deploy`; both build the image.
- A source change that does not show up under `wrangler dev` means a cached image: `docker rmi` it.
- Image size is bounded by the instance disk; the distroless or `bookworm-slim` final stage keeps it small.
- Deploy from the owning Worker package: `pnpm env:deploy <env> --only integrator`. Rollouts replace running instances; design the Rust service so an in-flight job can be re-run.

## Talking to the container

- The Worker speaks plain HTTP to the container (`this.containerFetch(request)` inside the class, or `getContainer(...).fetch(request)` from outside).
- The container reaches the rest of the system only through the gateway's HTTP API with its short-lived token; it never holds Cloudflare bindings or Artifacts repo tokens beyond the one scoped push token a job needs.
- Long jobs return a job id immediately; progress goes to the owning DO through a callback request or a WebSocket to the container's port.
