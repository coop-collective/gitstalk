//! Real git checkouts and Node executions exercise the opt-in skipper end to end.
#![allow(clippy::unwrap_used, clippy::expect_used)] // tests fail loudly by design

mod common;
use common::{Remote, TOKEN, Work, World};
use serde_json::{Value, json};

const ADD: &str = "export function add(a: number, b: number) { return a + b; }\n";
const BROKEN: &str = "export function add(a: number, b: number) { return a - b; }\n";
const TEST: &str = "import { test } from 'node:test'; import assert from 'node:assert/strict';\n\
    import { add } from './barrel.ts'; test('adds', () => assert.equal(add(2, 3), 5));\n";
const OTHER: &str = "import { test } from 'node:test'; import assert from 'node:assert/strict';\n\
    test('unrelated', () => assert.equal(1, 1));\n";

fn project(world: &World) -> (Remote, Work, String) {
    let remote = world.bare("skipper");
    let work = world.work("skipper");
    let sha = work.commit(
        &[
            ("package.json", "{\"type\":\"module\"}"),
            ("src/add.ts", ADD),
            ("src/barrel.ts", "export { add } from './add.ts';"),
            ("src/add.test.ts", TEST),
            ("src/other.test.ts", OTHER),
        ],
        "baseline",
    );
    work.push(&remote, "HEAD:refs/heads/main");
    (remote, work, sha)
}

async fn check(world: &World, remote: &Remote, sha: &str) -> Value {
    let (status, body) = world
        .post(
            "/v1/check",
            &json!({
                "repo": remote.url(), "token": TOKEN, "sha": sha, "test_skipper": true,
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body
}

#[tokio::test]
async fn skips_unaffected_files_but_runs_a_transitive_failure_and_invalidates_its_baseline() {
    let world = World::new().await;
    let (remote, work, base) = project(&world);
    let cold = check(&world, &remote, &base).await;
    assert_eq!(cold["green"], true, "{cold}");
    assert_eq!(
        cold["selection"]["reason"], "no-full-green-baseline",
        "{cold}"
    );
    assert_eq!(cold["tests"], 2);

    let broken = work.commit(&[("src/add.ts", BROKEN)], "regression");
    work.push(&remote, "HEAD:refs/heads/main");
    let selected = check(&world, &remote, &broken).await;
    assert_eq!(selected["green"], false, "{selected}");
    assert_eq!(selected["tests"], 1);
    assert_eq!(selected["failing_files"], json!(["src/add.test.ts"]));
    assert_eq!(selected["selection"]["baseline_sha"], base);
    assert_eq!(
        selected["selection"]["skipped_files"],
        json!(["src/other.test.ts"])
    );

    let retry = check(&world, &remote, &broken).await;
    assert_eq!(retry["tests"], 2);
    assert_eq!(retry["selection"]["reason"], "no-full-green-baseline");
}

#[tokio::test]
async fn disabled_checks_and_fresh_runners_execute_the_full_suite() {
    let world = World::new().await;
    let (remote, work, base) = project(&world);
    check(&world, &remote, &base).await;
    let changed = work.commit(&[("src/add.ts", &format!("{ADD}// edited\n"))], "comment");
    work.push(&remote, "HEAD:refs/heads/main");
    let body = json!({"repo": remote.url(), "token": TOKEN, "sha": changed});
    let (_, off) = world.post("/v1/check", &body).await;
    assert_eq!(off["tests"], 2);
    assert!(off.get("selection").is_none());

    let selected = check(&world, &remote, &changed).await;
    assert_eq!(selected["green"], true, "{selected}");
    assert_eq!(selected["tests"], 1);
    assert_eq!(selected["passing_files"], json!(["src/add.test.ts"]));
    let fresh = world.second_runner().await;
    let (_, cold) = common::post(
        &fresh,
        "/v1/check",
        &json!({
            "repo": remote.url(), "token": TOKEN, "sha": changed, "test_skipper": true,
        }),
    )
    .await;
    assert_eq!(cold["tests"], 2);
    assert_eq!(cold["selection"]["reason"], "no-full-green-baseline");
    // An unchanged snapshot is deliberately not certified using an empty test run.
    let unchanged = check(&world, &remote, &base).await;
    assert_eq!(
        unchanged["selection"]["reason"],
        "no-affected-tests-run-full"
    );
}

#[tokio::test]
async fn recipe_changes_and_other_repositories_cannot_reuse_evidence() {
    let world = World::new().await;
    let (remote, work, base) = project(&world);
    check(&world, &remote, &base).await;
    let changed = work.commit(&[("src/add.ts", &format!("{ADD}// changed\n"))], "edit");
    work.push(&remote, "HEAD:refs/heads/main");
    let (_, result) = world
        .post(
            "/v1/check",
            &json!({
                "repo": remote.url(), "token": TOKEN, "sha": changed, "test_skipper": true,
                "test_timeout_ms": 30_000,
            }),
        )
        .await;
    assert_eq!(result["tests"], 2);
    assert_eq!(
        result["selection"]["reason"],
        "recipe-or-environment-changed"
    );
    let other = world.bare("other");
    work.push(&other, "HEAD:refs/heads/main");
    let result = check(&world, &other, &changed).await;
    assert_eq!(result["tests"], 2);
    assert_eq!(result["selection"]["reason"], "no-full-green-baseline");
}

#[tokio::test]
async fn config_inventory_and_unknown_dependencies_fall_back_to_full_runs() {
    let world = World::new().await;
    let (remote, work, base) = project(&world);
    check(&world, &remote, &base).await;
    let configured = work.commit(
        &[("package.json", "{\"type\":\"module\",\"private\":true}")],
        "config",
    );
    work.push(&remote, "HEAD:refs/heads/main");
    let result = check(&world, &remote, &configured).await;
    assert_eq!(
        result["selection"]["reason"],
        "configuration-or-resource-changed"
    );
    assert_eq!(result["tests"], 2);

    let added = work.commit(&[("src/new.test.ts", OTHER)], "new test");
    work.push(&remote, "HEAD:refs/heads/main");
    let result = check(&world, &remote, &added).await;
    assert_eq!(result["selection"]["reason"], "file-inventory-changed");
    assert_eq!(result["tests"], 3);

    let dynamic = work.commit(
        &[(
            "src/add.ts",
            &format!("{ADD}const lazy = () => import('./barrel.ts');\n"),
        )],
        "dynamic import",
    );
    work.push(&remote, "HEAD:refs/heads/main");
    let result = check(&world, &remote, &dynamic).await;
    assert_eq!(
        result["selection"]["reason"],
        "unsupported-dependency-or-syntax"
    );
    assert_eq!(result["tests"], 3);
}

#[tokio::test]
async fn an_explicit_test_list_or_extra_files_never_seeds_partial_evidence() {
    let world = World::new().await;
    let (remote, _, base) = project(&world);
    let (_, explicit) = world
        .post(
            "/v1/check",
            &json!({
                "repo": remote.url(), "token": TOKEN, "sha": base, "test_skipper": true,
                "cmd": ["node", "--test", "src/other.test.ts"],
            }),
        )
        .await;
    assert_eq!(explicit["tests"], 1);
    assert_eq!(
        explicit["selection"]["reason"],
        "custom-command-or-extra-files"
    );
    let cold = check(&world, &remote, &base).await;
    assert_eq!(cold["selection"]["reason"], "no-full-green-baseline");
    let (_, extra) = world
        .post(
            "/v1/check",
            &json!({
                "repo": remote.url(), "token": TOKEN, "sha": base, "test_skipper": true,
                "extra_files": {"src/extra.test.ts": OTHER},
            }),
        )
        .await;
    assert_eq!(extra["tests"], 3);
    assert_eq!(
        extra["selection"]["reason"],
        "custom-command-or-extra-files"
    );
}

#[tokio::test]
async fn custom_environment_scope_and_tracing_cannot_reuse_the_default_recipe() {
    let world = World::new().await;
    let (remote, work, base) = project(&world);
    check(&world, &remote, &base).await;
    let changed = work.commit(&[("src/add.ts", &format!("{ADD}// change\n"))], "edit");
    work.push(&remote, "HEAD:refs/heads/main");
    for option in [
        json!({"env": {"TZ": "UTC"}}),
        json!({"only_files": ["src/other.test.ts"]}),
        json!({"trace": true}),
    ] {
        let mut body =
            json!({"repo": remote.url(), "token": TOKEN, "sha": changed, "test_skipper": true});
        body.as_object_mut()
            .unwrap()
            .extend(option.as_object().unwrap().clone());
        let (status, result) = world.post("/v1/check", &body).await;
        assert_eq!(status, 200, "{result}");
        assert_eq!(result["selection"]["mode"], "full", "{result}");
        assert!(
            result["selection"]["skipped_files"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
