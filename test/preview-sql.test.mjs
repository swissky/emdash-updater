import assert from "node:assert/strict";
import { test } from "node:test";

import {
	dependencyOrder,
	insertStatements,
	isFtsShadow,
	literal,
	MAX_STATEMENT_BYTES,
} from "../tools/preview-sql.mjs";
import { isUpdatePreviewBuild, previewNames } from "../tools/preview-build.mjs";

test("literal escapes quotes, keeps blobs and nulls", () => {
	assert.equal(literal("it's"), "'it''s'");
	assert.equal(literal(null), "NULL");
	assert.equal(literal(3.5), "3.5");
	assert.equal(literal([0, 255, 16]), "X'00ff10'");
});

test("insertStatements splits large tables under the statement limit", () => {
	const rows = Array.from({ length: 300 }, (_, i) => [i, "x".repeat(1000)]);
	const statements = insertStatements("t", ["id", "body"], rows);
	assert.ok(statements.length > 1);
	assert.ok(statements.every((s) => s.length <= MAX_STATEMENT_BYTES));
	assert.equal(statements.join("").match(/\(\d+,'x+'\)/g).length, 300);
});

test("dependencyOrder fills referenced tables first and survives cycles", () => {
	const refs = new Map([
		["revisions", ["users", "ec_posts"]],
		["ec_posts", ["users"]],
		["a", ["b"]],
		["b", ["a"]],
	]);
	const order = dependencyOrder(["revisions", "ec_posts", "users", "a", "b"], refs);
	assert.ok(order.indexOf("users") < order.indexOf("ec_posts"));
	assert.ok(order.indexOf("ec_posts") < order.indexOf("revisions"));
	assert.equal(order.length, 5);
});

test("isFtsShadow only matches shadow tables of real FTS tables", () => {
	const virtual = new Set(["_emdash_fts_posts"]);
	assert.ok(isFtsShadow("_emdash_fts_posts_data", virtual));
	assert.ok(!isFtsShadow("user_data", virtual));
});

test("preview builds only run on update branches", () => {
	assert.ok(isUpdatePreviewBuild({ WORKERS_CI_BRANCH: "emdash-update-1-4-0" }));
	assert.ok(!isUpdatePreviewBuild({ WORKERS_CI_BRANCH: "main" }));
	assert.ok(!isUpdatePreviewBuild({}));
});

test("previewNames never reuses a live resource and always adds a session store", () => {
	const names = previewNames({
		name: "site",
		d1_databases: [{ binding: "DB", database_name: "site", database_id: "1" }],
		r2_buckets: [{ binding: "MEDIA", bucket_name: "site-media" }],
	});
	assert.equal(names.d1[0].preview, "site-preview-db");
	assert.equal(names.r2[0].preview, "site-preview-media");
	assert.deepEqual(
		names.kv.map((n) => n.preview),
		["site-preview-session"],
	);
});

test("update branches map to the Cloudflare preview URL of the live Worker", async () => {
	const { branchFor, previewUrlFor, phaseFromChecks } = await import("../src/preview.ts");
	const branch = branchFor([{ name: "emdash", from: "1.3.1", to: "1.4.0" }]);
	assert.equal(branch, "emdash-update-1-4-0");
	assert.ok(isUpdatePreviewBuild({ WORKERS_CI_BRANCH: branch }), "the build hook recognises the branch");
	assert.equal(
		previewUrlFor(branch, "emdash-updater-demo.thismatters.workers.dev"),
		"https://emdash-update-1-4-0-emdash-updater-demo.thismatters.workers.dev",
	);
	assert.equal(previewUrlFor(branch, "www.example.com"), null, "custom domains fall back to the build page");
	const update = { startedAt: new Date(0).toISOString() };
	assert.equal(phaseFromChecks(update, [], 60_000).phase, "building");
	assert.equal(phaseFromChecks(update, [], 10 * 60_000).phase, "no-build");
	const done = (conclusion) => [{ name: "Workers Builds: x", status: "completed", conclusion, url: "https://dash.cloudflare.com/b" }];
	assert.equal(phaseFromChecks(update, done("success")).phase, "ready");
	assert.equal(phaseFromChecks(update, done("failure")).phase, "failed");
});
