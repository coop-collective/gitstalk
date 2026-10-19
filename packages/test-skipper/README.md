# @gitstalk/test-skipper

Forge-owned dependency analysis for the optional Node pre-land test skipper. The runner owns evidence and selection; this package emits a snapshot of file fingerprints and transitive test dependencies. It never imports repository code.

Enable with `test_skipper: true` on a `beanstalk-v2` run. It defaults to false. It never selects tests for validation or final acceptance, and selected results never qualify for full-check reuse. See [the feature contract](../../docs/09l-optional-test-skipper.md) for supported syntax, fallbacks and limitations.

```sh
pnpm -F @gitstalk/test-skipper build
node packages/test-skipper/dist/cli.mjs /absolute/path/to/checkout
pnpm -F @gitstalk/test-skipper test
```

The Docker build bundles this CLI and Acorn outside the checked repository. Its JSON protocol is consumed by `packages/gateway/container/src/check/skipper.rs`; analyzer failure runs the full suite. A fresh checkout should contain repository files only, without `.git`, dependency installations or generated output.
