# @gitstalk/shared-ask

The read side of the repository explorer, shared by the web app and the MCP server: Ask
(a question becomes a fixed view spec, its entities resolve to files, and the explorer's
layout is arranged for the answer), the typed client for the gateway's RPC, the reducer that
turns an engine's event log into what the canvas shows, and the Home and file views built on
it. It is a TypeScript library with no Worker of its own; it is bundled into the Workers that
import it and reaches the gateway only through the caller's `GATEWAY` service binding.

```
packages/web ─┐                                   ┌─ GATEWAY service binding ─> gitstalk-gateway
              ├─> @gitstalk/shared-ask ── forge/ ─┤
packages/mcp ─┘          │                        └─ (web only) recorded runs, same ForgeSource shape
                         └─> @gitstalk/shared-race (rpc, events, collaboration types)
```

## Key concepts

- **Ask**: a question is classified into a class from a fixed catalog (a keyword router by
  default, optionally a small Workers AI model), its entities are resolved to a ranked file
  set, and the answer is data, never generated layout. See
  [13-ask-explorer-design.md](../../docs/claude-opus/13-ask-explorer-design.md).
- **Picker**: where a page chooses among candidates code has computed (suggested questions,
  section order). `rulesPicker` applies each decision's deterministic rule; `modelPicker` asks
  a typed decision model through Workers AI and AI Gateway (Cloudflare's Clef Flash by default;
  Clef 27B or TypeSafe's Jev on request) and falls back to the rule on any failure. Every
  decision leaves a receipt naming the model that answered.
- **Decision model** (`src/pick/decision-model.ts`): typed questions for any package. Clef,
  Clef 27B and Jev differ only in data (`DECISION_MODELS`: Workers AI id, the body's required
  `model` field for Clef, display name). `decisionModelFrom({ name, ai, gateway, budgetMs?,
  onError? })` returns a `DecisionModel` or null; `askChoice`, `askNoul` and `askScore` take
  it (or null), a state, instructions and a fallback, and return `Decided<T>`: `answered`
  (value, model, confidence, ms) or `fell-back` (the fallback value and why), never a throw.
  `askQuestions` sends up to 64 questions in one call. See
  [14-repository-experience.md](../../docs/claude-opus/14-repository-experience.md) §5.
- **ForgeSource**: the data adapter pages code against. `gatewaySource` reads live state over
  RPC; `memoSource` shares repeated reads within one request. The recorded-run source lives in
  the web app.
- **Bean streams**: a bean's working diff while its agent writes. See
  [claude-17-streaming-diffs.md](../../docs/claude-17-streaming-diffs.md) and the public
  [streaming diffs](../site/public/docs/streaming-diffs.html) page.
- **Event reducer**: `reduceRace` is a pure function from an engine's events to the canvas
  state (beans, phases, counters). Despite the `race/` folder name, it reads the
  same event log every repository's engine writes.

## Layout

There is no index module; import files by path, for example
`@gitstalk/shared-ask/ask/plan-answer` (the `exports` map is `./*` to `./src/*.ts`).

| Path | Contents |
| --- | --- |
| `src/ask/` | Ask pipeline: `view-spec`, `classifier`, `workers-ai-classifier`, `classifier-from-env`, `question-words`, `resolve-files`, `file-set`, `corpus`, `plan-context`, `plan-answer`, `answer`, `answer-picks`, `main-pane`, `rail`, `chips`, `blame` |
| `src/pick/` | `decision-model` (Clef and Jev typed questions), `picker` (rules and model pickers), `picker-from-env`, `lead` (suggested questions) |
| `src/forge/` | `forge-source`, `gateway-rpc` (typed, Zod-validated `GATEWAY` client), `gateway-source`, `memo-source`, `bean-records`, `bean-stream`, `forge-errors` |
| `src/race/` | `race-events` (boundary schemas), `race-state`, `reduce-race`, `race-counters` |
| `src/home/` | Home and Files views: `sessions`, `stalk`, `journey`, `file-rows`, `composition`, `areas`, `busiest-moment` |
| `src/repo/` | `repo-types`, `paths`, `file-diff`, `unified-patch`, `imports` |
| `src/collaboration/` | `context`: bean context assembled from collaboration records |

Imported by `packages/web` and `packages/mcp`. Depends on `@gitstalk/shared-race`, `zod` and
`diff`.

## Develop

```bash
pnpm -F @gitstalk/shared-ask test        # vitest, plain Node (pure modules, no bindings)
pnpm -F @gitstalk/shared-ask typecheck   # tsc -p tsconfig.json
```

There is no `dev`, `types` or `.dev.vars`: the library reads no bindings of its own.

## Configuration

Nothing is read from an environment directly. The importing Worker passes in its own values:

- `classifierFrom({ name, model, ai })`: the `ASK_CLASSIFIER` var (`keywords` or `workers-ai`),
  `ASK_AI_MODEL` and the optional `AI` binding.
- `pickerFrom({ name, ai, gateway })`: the `PICKER` var (`clef`, `clef-27b`, `jev` or
  `rules`), the `AI` binding and the AI Gateway id in `DECISION_GATEWAY`.
- `decisionModelFrom({ name, ai, gateway })`: the same values, for asking typed questions
  directly.
- `gatewaySource(...)`: the Worker's `GATEWAY` service binding to `gitstalk-gateway`.

The library is deployed only as part of `gitstalk-web` and `gitstalk-mcp`; see
[30-environments.md](../../docs/claude-opus/30-environments.md).

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md); run `pnpm check` at the root before sending a
change.
