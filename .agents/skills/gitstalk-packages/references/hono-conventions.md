# Hono conventions on Workers

## Contents
- App shape and typing
- Routes and validation
- Middleware
- Errors
- Proxying Durable Objects, MCP and WebSockets
- Streaming
- RPC and typed clients

## App shape and typing

- One `createApp(deps)` per Worker returning `new Hono<AppEnv>()`; `AppEnv = { Bindings: Env; Variables: {...} }`. `Env` is the generated global from `worker-configuration.d.ts`. Never `import { Env } from 'hono'`; never hand-annotate handler parameters with ad hoc context types (that is what breaks `c.req.param` inference).
- Handlers are inline arrow functions or `factory.createHandlers()` from `hono/factory`; no "controller" functions taking `Context`, because path parameter types are lost.
- `app.route('/beans', beans)` mounts sub-apps; each sub-app is `new Hono<AppEnv>()` in `src/routes/<area>.ts` and exports the instance.
- HTTP between Workers is not allowed; use the `WorkerEntrypoint` RPC methods through a service binding.

## Routes and validation

```ts
// src/routes/beans.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { CreateBeanRequest } from '../bean/wire';
import type { AppEnv } from '../app';

export const beans = new Hono<AppEnv>()
  .post('/', zValidator('json', CreateBeanRequest), async (c) => {
    const result = await c.var.deps.beans.create(c.req.valid('json'));
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json(result.value, 201);
  })
  .get('/:id', async (c) => {
    const bean = await c.var.deps.beans.find(c.req.param('id'));
    return bean ? c.json(bean) : c.json({ error: { code: 'not_found' } }, 404);
  });
```

- Chain the route definitions (`new Hono().post(...).get(...)`) so `AppType` carries them for the RPC client.
- `zValidator('json' | 'query' | 'param', schema)` with `z.strictObject` schemas; the global `hook` in `createApp` shapes validation failures as `{ error: { code: 'invalid_request', issues } }` with status 400.
- Handlers do not contain business logic: parse, call one domain function, map the result to a status. Status codes are explicit literals.

## Middleware

- `createMiddleware<AppEnv>()` from `hono/factory` for typed middleware; set values with `c.set('requestId', id)` and read with `c.var.requestId`.
- Standard stack, in order: request id (reads `cf-ray` or generates a UUID), structured access log on completion, auth (puts a typed `Actor` on `c.var`), then routes.
- Middleware never reads the body of a request it will forward.
- Background work: `c.executionCtx.waitUntil(promise)`.

## Errors

- `throw new HTTPException(404, { message })` from `hono/http-exception` only for plain HTTP conditions in middleware; preserve the domain API's existing `Result` or `GitstalkError` contract rather than converting its error representation as incidental cleanup.
- One `app.onError` maps `HTTPException`, `GitstalkError` and unknown errors; handlers never build error responses by hand beyond the `Result` mapping above.
- `app.notFound` returns the same `{ error: { code: 'not_found' } }` shape.

## Proxying Durable Objects, MCP and WebSockets

```ts
app.all('/rooms/:id/*', (c) => c.env.ROOMS.getByName(c.req.param('id')).fetch(c.req.raw));
app.all('/mcp', (c) => mcpHandler(c.req.raw, c.env, c.executionCtx));
```

- Pass `c.req.raw` and return the `Response` untouched; WebSocket upgrades (status 101) and streaming bodies pass through only if nothing in the chain reads or wraps them. Keep these routes above any middleware that buffers.
- The MCP handler (`createMcpHandler` from the Agents SDK or `@modelcontextprotocol/sdk`) is mounted as a route; auth middleware runs before it and the tool list lives in `docs/claude-06-identity-mcp-and-previews.md`.

## Streaming

- `stream` and `streamSSE` from `hono/streaming` for long responses; write chunks as they arrive, never collect first.
- Large uploads: read `c.req.raw.body` as a stream into R2 or Artifacts; never `await c.req.text()` on unbounded input.

## RPC and typed clients

- Export `type AppType = ReturnType<typeof createApp>` and build browser or test clients with `hc<AppType>(baseUrl)` from `hono/client`. The web app uses this for calls it makes from the browser; server components call Workers through service-binding RPC instead.
- Worker-to-Worker: methods on the `WorkerEntrypoint` subclass, called as `await env.INTEGRATOR.composeWorld(plan)`. Arguments and results must be structured-cloneable (plain data, no class instances, no functions).
