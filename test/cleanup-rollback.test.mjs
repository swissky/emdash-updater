import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { deletePreviewCopies } from "../tools/preview-cleanup.mjs";
import { previewNames } from "../tools/preview-build.mjs";
import { restoreBeforeUpdate, ROLLBACK_MARKER } from "../tools/rollback-build.mjs";

const config = {
	name: "site",
	d1_databases: [{ binding: "DB", database_name: "site", database_id: "live-db" }],
	r2_buckets: [{ binding: "MEDIA", bucket_name: "site-media" }],
};

test("deletes every preview copy, emptying the bucket first", async () => {
	const calls = [];
	const objects = ["a.jpg", "dir/b c.png"];
	const call = async (path, { method = "GET" } = {}) => {
		calls.push(`${method} ${path}`);
		if (path.startsWith("/d1/database?name=")) return [{ name: "site-preview-db", uuid: "p-db" }];
		if (path === "/r2/buckets/site-preview-media" && method === "GET") return {};
		if (path.startsWith("/r2/buckets/site-preview-media/objects?"))
			return { result: objects.map((key) => ({ key })), cursor: undefined };
		if (path.startsWith("/storage/kv/namespaces?"))
			return [{ title: "site-preview-session", id: "p-kv" }];
		return {};
	};
	await deletePreviewCopies(call, previewNames(config), () => {});
	assert.ok(calls.includes("DELETE /d1/database/p-db"));
	assert.ok(calls.includes("DELETE /r2/buckets/site-preview-media/objects/dir/b%20c.png"));
	assert.ok(
		calls.indexOf("DELETE /r2/buckets/site-preview-media") >
			calls.indexOf("DELETE /r2/buckets/site-preview-media/objects/a.jpg"),
		"The bucket is deleted only after its objects",
	);
	assert.ok(calls.includes("DELETE /storage/kv/namespaces/p-kv"));
	assert.ok(!calls.some((c) => c.includes("live-db") || c.includes("/site-media")), "Live resources are never touched");
});

function site(t, marker) {
	const dir = mkdtempSync(join(tmpdir(), "updater-rollback-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(config));
	if (marker) writeFileSync(join(dir, ROLLBACK_MARKER), JSON.stringify(marker));
	return pathToFileURL(`${dir}/`);
}

function fakeCloudflare(done = null) {
	const requests = [];
	const fetchImpl = async (url, init = {}) => {
		requests.push({ url, method: init.method, body: init.body });
		const sql = init.body ? JSON.parse(init.body).sql : "";
		const results = sql.startsWith("SELECT") && done ? [{ value: JSON.stringify(done) }] : [];
		return Response.json({ success: true, result: [{ results }] });
	};
	return { requests, fetchImpl };
}
const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "t" };
const id = "11111111-1111-4111-8111-111111111111";
const before = "2026-11-01T19:00:00.000Z";

test("restores the live database to the moment before the update, once", async (t) => {
	const root = site(t, { id, before, bumps: [], finishedAt: before });
	const cf = fakeCloudflare();
	const restored = await restoreBeforeUpdate({
		root,
		env: { ...env },
		log: () => {},
		fetchImpl: cf.fetchImpl,
	});
	assert.equal(restored, true);
	const restore = cf.requests.find((r) => r.url.includes("/time_travel/restore"));
	assert.ok(restore.url.includes("/d1/database/live-db/"));
	assert.equal(new URL(restore.url).searchParams.get("timestamp"), before);
	const record = cf.requests.at(-1).body;
	assert.match(record, /rollbackDone/);
	const saved = JSON.parse(record).sql.match(/'plugin:emdash-updater:lastUpdate', '(.*?)'\)/)[1];
	assert.equal(JSON.parse(saved).id, id);
	assert.equal(JSON.parse(saved).undone.withDatabase, true, "The restored database records the undo");
	assert.match(record, /DELETE FROM options WHERE name = 'plugin:emdash-updater:update'/);

	const again = fakeCloudflare(id);
	assert.equal(
		await restoreBeforeUpdate({ root, env, log: () => {}, fetchImpl: again.fetchImpl }),
		false,
	);
	assert.ok(!again.requests.some((r) => r.url.includes("time_travel")), "A rebuild never restores twice");
});

test("does nothing without an undo marker", async (t) => {
	const cf = fakeCloudflare();
	assert.equal(await restoreBeforeUpdate({ root: site(t), env, fetchImpl: cf.fetchImpl }), false);
	assert.equal(cf.requests.length, 0);
});

test("refuses a malformed marker", async (t) => {
	const cf = fakeCloudflare();
	await assert.rejects(
		restoreBeforeUpdate({ root: site(t, { id: "x';--", before }), env, fetchImpl: cf.fetchImpl }),
		/invalid/,
	);
	assert.equal(cf.requests.length, 0);
});
