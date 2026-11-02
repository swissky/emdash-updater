import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const BASE = "a".repeat(40);
const CANDIDATE = "c".repeat(40);
const BRANCH = "emdash-update-1-4-0";
let pkg = JSON.stringify({ dependencies: { emdash: "1.3.1" } }, null, "\t") + "\n";

const directory = await mkdtemp(resolve("node_modules/.updater-test-"));
try {
	const outfile = resolve(directory, "plugin.mjs");
	await build({
		entryPoints: ["src/index.ts"],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		define: {
			__UPDATER_PACKAGES__: JSON.stringify({ emdash: "1.3.1" }),
			__UPDATER_PREVIEW_BUILD__: "false",
		},
	});
	const { createPlugin } = await import(pathToFileURL(outfile).href);
	const plugin = createPlugin();
	const directFile = resolve(directory, "plugin-direct.mjs");
	await build({
		entryPoints: ["src/index.ts"],
		outfile: directFile,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		define: {
			__UPDATER_PACKAGES__: JSON.stringify({ emdash: "1.3.1" }),
			__UPDATER_PREVIEW_BUILD__: "false",
			__UPDATER_PREVIEWS__: "false",
		},
	});
	const direct = (await import(pathToFileURL(directFile).href)).createPlugin();

	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const settings = new Map([
		["appId", "1"],
		["privateKey", privateKey.export({ type: "pkcs8", format: "pem" })],
	]);
	const kv = new Map([
		["selectedRepo", { installationId: 1, owner: "o", name: "r", defaultBranch: "main" }],
	]);
	let rev = 0;
	const revisions = new Map();
	const github = {
		main: BASE,
		branches: new Map(),
		commits: new Map(),
		next: 0x100,
		tree: [],
		checks: [],
		statuses: [],
		deployments: [],
		committed: null,
		files: {},
		workflows: "write",
		// Checks without a sha stand for the update commits; cleanup commits get their own.
		checksFor: (sha) =>
			github.checks.filter((c) =>
				c.sha ? c.sha === sha : github.commits.get(sha)?.tree[0]?.path === "package.json",
			),
	};
	const json = (data, status = 200) => Response.json(data, { status });

	const fetch = async (url, init = {}) => {
		const u = new URL(url);
		const method = init.method ?? "GET";
		if (u.hostname === "registry.npmjs.org")
			return json({
				name: "emdash",
				"dist-tags": { latest: "1.4.0" },
				versions: { "1.3.1": { version: "1.3.1" }, "1.4.0": { version: "1.4.0" } },
				time: { "1.3.1": "2026-01-01T00:00:00Z", "1.4.0": "2026-02-01T00:00:00Z" },
			});
		const path = u.pathname.replace("/repos/o/r", "");
		if (path === "/app/installations/1/access_tokens") return json({ token: "t" });
		if (path === "/app/installations/1")
			return json({ permissions: { contents: "write", workflows: github.workflows } });
		if (path === "/app") return json({ slug: "emdash-updater-site", owner: { login: "swissky", type: "User" } });
		if (path === "/git/ref/heads/main") return json({ object: { sha: github.main } });
		const refMatch = path.match(/^\/git\/refs?\/heads\/(.+)$/);
		if (refMatch && refMatch[1] !== "main") {
			const name = decodeURIComponent(refMatch[1]);
			if (method === "GET")
				return github.branches.has(name)
					? json({ object: { sha: github.branches.get(name) } })
					: json({}, 404);
			if (method === "DELETE") {
				github.branches.delete(name);
				return new Response(null, { status: 204 });
			}
			if (method === "PATCH") {
				const { sha, force } = JSON.parse(init.body);
				assert.equal(force, false);
				assert.equal(
					github.commits.get(sha)?.parent,
					github.branches.get(name),
					"Branches only fast-forward",
				);
				github.branches.set(name, sha);
				return json({ object: { sha } });
			}
		}
		if (path.startsWith("/contents/")) {
			const file = decodeURIComponent(path.slice("/contents/".length));
			const ref = u.searchParams.get("ref");
			const content =
				ref === BASE || ref === "main"
					? file === "package.json"
						? pkg
						: github.files[file]
					: null;
			return content
				? json({
						sha: blobSha(content),
						encoding: "base64",
						content: Buffer.from(content).toString("base64"),
					})
				: json({}, 404);
		}
		const infoMatch = path.match(/^\/commits\/([a-f0-9]{40})$/);
		if (infoMatch) {
			const c = github.commits.get(infoMatch[1]);
			return json({
				parents: c.parent ? [{ sha: c.parent }] : [],
				files: c.tree.map((f) => ({ filename: f.path })),
			});
		}
		const commitMatch = path.match(/^\/git\/commits\/([a-f0-9]{40})$/);
		if (commitMatch) {
			const parent = github.commits.get(commitMatch[1])?.parent;
			return json({ tree: { sha: "b".repeat(40) }, parents: parent ? [{ sha: parent }] : [] });
		}
		if (path === "/git/trees") {
			github.tree = JSON.parse(init.body).tree.map((f) =>
				f.sha && !f.content ? { ...f, content: blobs.get(f.sha) } : f,
			);
			return json({ sha: "d".repeat(40) }, 201);
		}
		if (path === "/git/commits" && method === "POST") {
			const { message, parents } = JSON.parse(init.body);
			const sha = github.commits.size ? (++github.next).toString(16).padStart(40, "0") : CANDIDATE;
			github.commits.set(sha, { parent: parents[0], message, tree: github.tree });
			if (github.tree[0]?.path === "package.json") github.committed = github.tree[0].content;
			return json({ sha }, 201);
		}
		if (path === "/git/refs" && method === "POST") {
			const { ref, sha } = JSON.parse(init.body);
			const name = ref.replace("refs/heads/", "");
			if (github.branches.has(name)) return json({}, 422);
			github.branches.set(name, sha);
			return json({ ref }, 201);
		}
		if (path === "/git/refs/heads/main" && method === "PATCH") {
			const { sha, force } = JSON.parse(init.body);
			assert.equal(force, false, "The live branch is never force-pushed");
			github.main = sha;
			return json({ object: { sha } });
		}
		if (/^\/commits\/[a-f0-9]{40}\/status$/.test(path)) return json({ statuses: github.statuses });
		if (path === "/deployments")
			return json(github.deployments.map((d, id) => ({ id, environment: d.environment })));
		const deployMatch = path.match(/^\/deployments\/(\d+)\/statuses$/);
		if (deployMatch) return json(github.deployments[Number(deployMatch[1])].statuses);
		const checkMatch = path.match(/^\/commits\/([a-f0-9]{40})\/check-runs$/);
		if (checkMatch) return json({ check_runs: github.checksFor(checkMatch[1]) });
		throw new Error(`Unexpected request ${method} ${url}`);
	};

	const blobs = new Map();
	function blobSha(content) {
		const id = createHash("sha1").update(content).digest("hex");
		blobs.set(id, content);
		return id;
	}

	const ctx = (input = {}) => ({
		input,
		user: { id: "admin" },
		request: new Request("https://site-demo.example.workers.dev/_emdash/api/plugins/x"),
		http: { fetch },
		settings: { get: async (k) => settings.get(k) ?? null },
		kv: {
			get: async (k) => kv.get(k) ?? null,
			set: async (k, v) => {
				kv.set(k, v);
				revisions.set(k, String(++rev));
			},
			delete: async (k) => kv.delete(k),
			getVersioned: async (k) =>
				kv.has(k) ? { value: kv.get(k), revision: revisions.get(k) } : null,
			compareAndSet: async (k, expected, v) => {
				if ((revisions.get(k) ?? null) !== expected && !(expected === null && !kv.has(k)))
					return { applied: false };
				kv.set(k, v);
				revisions.set(k, String(++rev));
				return { applied: true, revision: revisions.get(k) };
			},
			compareAndDelete: async (k, expected) => {
				if (revisions.get(k) !== expected) return { applied: false };
				kv.delete(k);
				return { applied: true };
			},
		},
	});
	const status = () => plugin.routes.status.handler(ctx());

	const planned = await status();
	assert.deepEqual(planned.plan.bumps, [{ name: "emdash", from: "1.3.1", to: "1.4.0" }]);

	await plugin.routes["update/start"].handler(ctx({ planId: planned.plan.id }));
	assert.equal(github.main, BASE, "Starting a test leaves the live branch untouched");
	assert.equal(github.branches.get(BRANCH), CANDIDATE);
	assert.match(github.committed, /"emdash": "1.4.0"/);

	let s = await status();
	assert.equal(s.update.phase, "building");
	assert.equal(s.previewUrl, `https://${BRANCH}-site-demo.example.workers.dev`);
	await assert.rejects(
		plugin.routes["update/apply"].handler(ctx({ updateId: s.update.id })),
		/finished test/,
		"An unbuilt test version cannot be applied",
	);

	github.checks = [
		{
			name: "Workers Builds: site-demo",
			status: "completed",
			conclusion: "success",
			details_url: "https://dash.cloudflare.com/x/builds/1",
		},
	];
	s = await status();
	assert.equal(s.update.phase, "ready");
	assert.ok(
		kv.get("previewLoginSecret"),
		"The sign-in secret exists before the preview copies the database",
	);
	const { url } = await plugin.routes["update/open"].handler(ctx({ updateId: s.update.id }));
	const link = new URL(url);
	assert.equal(link.origin, `https://${BRANCH}-site-demo.example.workers.dev`);
	assert.equal(link.pathname, "/_emdash/updater/preview-login");
	assert.match(link.searchParams.get("token"), /^[\w-]+\.[\w-]+$/);

	await plugin.routes["update/apply"].handler(ctx({ updateId: s.update.id }));
	assert.equal(
		github.main,
		CANDIDATE,
		"Applying fast-forwards the live branch to the tested commit",
	);
	const cleanupSha = github.branches.get(BRANCH);
	const cleanupCommit = github.commits.get(cleanupSha);
	assert.equal(cleanupCommit.parent, CANDIDATE, "The cleanup commit sits on the tested commit");
	assert.equal(cleanupCommit.tree[0].path, ".emdash-update-cleanup");
	assert.equal((await status()).cleaning, true, "The branch stays until the cleanup build ran");
	assert.equal(github.branches.has(BRANCH), true);
	github.checks = [
		...github.checks,
		{
			sha: cleanupSha,
			name: "Workers Builds: site-demo",
			status: "completed",
			conclusion: "failure",
			details_url: "https://dash.cloudflare.com/x/builds/2",
		},
	];
	const afterCleanup = await status();
	assert.equal(afterCleanup.cleaning, false, JSON.stringify(afterCleanup.error));
	assert.equal(
		github.branches.has(BRANCH),
		false,
		"The test branch is removed after the cleanup build",
	);
	assert.equal((await status()).update.phase, "applied");

	// Undo: once the live site runs the new version, the update can be reverted.
	kv.delete("update");
	kv.set("lastUpdate", {
		id: "11111111-1111-4111-8111-111111111111",
		bumps: [{ name: "emdash", from: "1.3.1", to: "1.4.0" }],
		finishedAt: new Date().toISOString(),
		// Saved before a GitHub reconnect: that installation no longer exists.
		repo: { ...kv.get("selectedRepo"), installationId: 99 },
		baseSha: BASE,
		appliedSha: CANDIDATE,
		before: new Date().toISOString(),
	});
	revisions.set("lastUpdate", String(++rev));
	await plugin.routes["update/undo"].handler(
		ctx({ id: "11111111-1111-4111-8111-111111111111", withDatabase: true }),
	);
	const undo = github.commits.get(github.main);
	assert.equal(undo.parent, CANDIDATE, "Undo is a new commit on top, history is kept");
	assert.match(undo.tree.find((f) => f.path === "package.json").content, /"emdash": "1.3.1"/);
	assert.match(undo.tree.find((f) => f.path === ".emdash-rollback.json").content, /"before"/);
	assert.ok(kv.get("lastUpdate").undone);
	await assert.rejects(
		plugin.routes["update/undo"].handler(ctx({ id: "11111111-1111-4111-8111-111111111111" })),
		/no longer be undone/,
		"An update is undone only once",
	);

	// Discard path: the live branch stays put and the copies are cleaned up.
	github.main = BASE;
	kv.delete("update");
	kv.delete("lastUpdate");
	const again = await status();
	await plugin.routes["update/start"].handler(ctx({ planId: again.plan.id }));
	const pending = await status();
	await plugin.routes["update/discard"].handler(ctx({ updateId: pending.update.id }));
	assert.equal(github.main, BASE);
	assert.equal(kv.has("update"), false);
	assert.equal(
		github.commits.get(github.branches.get(BRANCH)).tree[0].path,
		".emdash-update-cleanup",
	);
	await assert.rejects(
		plugin.routes["update/start"].handler(ctx({ planId: "x" })),
		/still being deleted/,
		"No new test while the old copies are deleted",
	);
	github.checks.push({
		sha: github.branches.get(BRANCH),
		name: "Workers Builds: site-demo",
		status: "completed",
		conclusion: "failure",
		details_url: "https://dash.cloudflare.com/x/builds/3",
	});
	await status();
	assert.equal(github.branches.has(BRANCH), false);

	// A live branch that moved after the test started is never overwritten.
	const third = await status();
	await plugin.routes["update/start"].handler(ctx({ planId: third.plan.id }));
	const ready = await status();
	github.main = "e".repeat(40);
	await assert.rejects(
		plugin.routes["update/apply"].handler(ctx({ updateId: ready.update.id })),
		/code changed/,
	);
	assert.equal(github.main, "e".repeat(40));

	// Other hostings: no test version, the update goes straight to the live branch.
	await plugin.routes["update/discard"].handler(ctx({ updateId: ready.update.id }));
	github.checks.push({
		sha: github.branches.get(BRANCH),
		name: "Workers Builds: x",
		status: "completed",
		conclusion: "failure",
		details_url: "https://dash.cloudflare.com/x",
	});
	await status();
	const live = BASE;
	github.main = BASE;
	github.checks = [];
	const directStatus = () => direct.routes.status.handler(ctx());
	const offer = await directStatus();
	assert.equal(offer.previews, false);
	assert.equal(offer.restoreWindowMs, 0, "Content reset is not offered without D1");
	const branchesBefore = github.branches.size;
	await direct.routes["update/start"].handler(ctx({ planId: offer.plan.id }));
	const updated = github.main;
	assert.notEqual(updated, live, "The update commit lands on the live branch");
	assert.equal(github.commits.get(updated).parent, live);
	assert.equal(github.branches.size, branchesBefore, "No test branch is created");
	assert.equal((await directStatus()).update.phase, "applied");
	await assert.rejects(
		direct.routes["update/discard"].handler(ctx({ updateId: kv.get("update").id })),
		/no longer be discarded/,
		"A running direct update cannot be reverted yet",
	);
	github.deployments = [
		{
			environment: "main - site",
			statuses: [{ state: "in_progress", log_url: "https://dashboard.render.com/d/1" }],
		},
	];
	assert.equal((await directStatus()).update.phase, "applied", "A running deploy is not a failure");
	github.deployments[0].statuses = [
		{ state: "failure", log_url: "https://dashboard.render.com/d/1" },
	];
	const renderBroken = await directStatus();
	assert.equal(renderBroken.update.phase, "failed", "A failed deployment (Render) is reported");
	assert.equal(renderBroken.update.buildUrl, "https://dashboard.render.com/d/1");
	github.deployments = [];
	kv.set("update", { ...renderBroken.update, phase: "applied", buildUrl: undefined });
	github.statuses = [
		{ context: "Vercel", state: "failure", target_url: "https://vercel.com/x/deployments/1" },
	];
	const broken = await directStatus();
	assert.equal(broken.update.phase, "failed", "A failed deploy is reported");
	assert.equal(broken.update.buildUrl, "https://vercel.com/x/deployments/1");
	await assert.rejects(
		direct.routes["update/start"].handler(ctx({ planId: "x" })),
		/waiting for your decision/,
		"No new update while the failed one is unresolved",
	);
	await direct.routes["update/discard"].handler(ctx({ updateId: broken.update.id }));
	assert.equal(
		github.commits.get(github.main).parent,
		updated,
		"Going back is a new commit, history is kept",
	);
	assert.match(github.committed, /"emdash": "1.3.1"/);
	assert.equal(kv.has("update"), false);
	await assert.rejects(
		direct.routes["update/undo"].handler(ctx({ id: "x", withDatabase: true })),
		/no longer be undone|only available/,
	);
	const savedCreds = new Map(settings);
	settings.clear();
	const behindProxy = await plugin.routes["connect/start"].handler({
		...ctx(),
		request: new Request("http://10.0.0.5:4321/_emdash/api/plugins/x"),
		site: { url: "https://site.example.com" },
	});
	const manifest = JSON.parse(behindProxy.manifest);
	assert.equal(
		manifest.url,
		"https://site.example.com",
		"The App points at the public address, not the proxy",
	);
	assert.match(manifest.redirect_url, /^https:\/\/site\.example\.com\//);
	for (const [k, v] of savedCreds) settings.set(k, v);

	const declare = (emdash) =>
		(pkg = JSON.stringify({ dependencies: { emdash } }, null, "\t") + "\n");
	github.main = BASE;
	declare("1.2.0");
	const other = await directStatus();
	assert.match(other.error, /does not match your site/, "A repository of another site is refused");
	assert.equal(other.plan, undefined, "No update is offered for it");
	declare("^1.3.0");
	assert.equal((await directStatus()).plan.bumps[0].to, "1.4.0", "A range covering the site is fine");

	// A hosting that reports nothing: after a while the update can still be reverted.
	declare("1.3.1");
	github.statuses = [];
	github.checks = [];
	const quiet = await directStatus();
	await direct.routes["update/start"].handler(ctx({ planId: quiet.plan.id }));
	const pushed = github.main;
	assert.equal((await directStatus()).update.phase, "applied");
	kv.set("update", { ...kv.get("update"), appliedAt: new Date(Date.now() - 16 * 60_000).toISOString() });
	await direct.routes["update/discard"].handler(ctx({ updateId: kv.get("update").id }));
	assert.equal(github.commits.get(github.main).parent, pushed, "A stuck update is reverted with a new commit");
	assert.equal(kv.has("update"), false);

	// With a lockfile the update waits on its own branch until the workflow adds the lockfile.
	github.main = BASE;
	github.files["package-lock.json"] = '{"lockfileVersion":3}\n';
	github.workflows = undefined;
	const unpermitted = await directStatus();
	assert.equal(
		unpermitted.workflowPermission,
		"https://github.com/settings/apps/emdash-updater-site/permissions",
	);
	github.workflows = "write";
	const locked = await directStatus();
	assert.equal(locked.workflowPermission, null);
	await direct.routes["update/start"].handler(ctx({ planId: locked.plan.id }));
	assert.equal(github.main, BASE, "The live branch stays untouched until the lockfile exists");
	const waiting = github.branches.get("emdash-update-lockfile");
	assert.deepEqual(
		github.commits.get(waiting).tree.map((f) => f.path),
		["package.json", ".github/workflows/emdash-updater-lockfile.yml"],
	);
	assert.equal((await directStatus()).update.phase, "locking");
	const sneaky = "e".repeat(40);
	github.commits.set(sneaky, { parent: waiting, tree: [{ path: "src/index.ts", content: "x" }] });
	github.branches.set("emdash-update-lockfile", sneaky);
	assert.equal((await directStatus()).update.phase, "failed", "Only a lockfile commit is published");
	assert.equal(github.main, BASE);
	await direct.routes["update/discard"].handler(ctx({ updateId: kv.get("update").id }));
	assert.equal(github.branches.has("emdash-update-lockfile"), false);
	assert.equal(github.main, BASE, "Discarding a waiting update leaves the live branch alone");

	const relocked = await directStatus();
	await direct.routes["update/start"].handler(ctx({ planId: relocked.plan.id }));
	const lockCommit = "f".repeat(40);
	github.commits.set(lockCommit, {
		parent: github.branches.get("emdash-update-lockfile"),
		tree: [{ path: "package-lock.json", content: "{}" }],
	});
	github.branches.set("emdash-update-lockfile", lockCommit);
	assert.equal((await directStatus()).update.phase, "applied");
	assert.equal(github.main, lockCommit, "The lockfile commit is fast-forwarded to the live branch");
	assert.equal(github.branches.has("emdash-update-lockfile"), false);
	kv.set("update", { ...kv.get("update"), appliedAt: new Date(Date.now() - 16 * 60_000).toISOString() });
	await direct.routes["update/discard"].handler(ctx({ updateId: kv.get("update").id }));
	const revert = github.commits.get(github.main);
	assert.equal(revert.parent, lockCommit);
	assert.deepEqual(
		revert.tree.map((f) => [f.path, f.content]),
		[
			["package.json", pkg],
			["package-lock.json", github.files["package-lock.json"]],
		],
		"Going back restores package.json and the lockfile",
	);
	console.log("status flow ok");
} finally {
	await rm(directory, { recursive: true, force: true });
}
