import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import updater from "../src/astro.ts";

function consumer(t) {
	const directory = mkdtempSync(join(tmpdir(), "updater-astro-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = pathToFileURL(`${join(directory, "site")}/`);
	const write = (path, content) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	};
	write(
		fileURLToPath(new URL("package.json", root)),
		JSON.stringify({
			dependencies: { emdash: "^1.3.0", unrelated: "1.0.0" },
			devDependencies: { "@emdash-cms/cloudflare": "~1.3.0", emdash: "^1.3.0" },
		}),
	);
	// Hoisted dependencies also exercise resolution outside the site directory.
	for (const [name, version] of Object.entries({
		emdash: "1.4.1",
		"@emdash-cms/cloudflare": "1.3.9",
	})) {
		const pkg = join(directory, "node_modules", name);
		write(
			join(pkg, "package.json"),
			JSON.stringify({
				name,
				version,
				exports:
					name === "emdash"
						? { ".": "./dist/index.js" }
						: { "./package.json": "./package.json" },
			}),
		);
		write(join(pkg, "dist/index.js"), "");
	}
	return {
		root,
		run() {
			let config;
			const routes = [];
			updater().hooks["astro:config:setup"]({
				config: { root },
				updateConfig(value) {
					config = value;
				},
				injectRoute(route) {
					routes.push(route);
				},
			});
			return {
				defines: Object.fromEntries(
					Object.entries(config.vite.define).map(([key, value]) => [
						key,
						JSON.parse(value),
					]),
				),
				routes,
			};
		},
	};
}

test("integration reads installed consumer versions and injects the packaged server route", (t) => {
	const site = consumer(t);
	assert.notEqual(fileURLToPath(site.root), `${process.cwd()}/`);
	const { defines, routes } = site.run();
	assert.deepEqual(defines.__UPDATER_PACKAGES__, {
		emdash: "1.4.1",
		"@emdash-cms/cloudflare": "1.3.9",
	});
	assert.equal(defines.__UPDATER_PREVIEW_BUILD__, false);
	assert.equal(defines.__UPDATER_PREVIEWS__, false, "Without wrangler.jsonc updates go straight live");
	assert.equal(routes.length, 1);
	assert.equal(routes[0].pattern, "/connect-github");
	assert.equal(routes[0].prerender, false);
	assert.equal(
		routes[0].entrypoint.href,
		new URL("../src/connect-github.astro", import.meta.url).href,
	);
	assert.ok(readFileSync(routes[0].entrypoint, "utf8").length);
});

test("update branch builds are marked as previews", (t) => {
	const site = consumer(t);
	const previous = process.env.WORKERS_CI_BRANCH;
	t.after(() => {
		if (previous === undefined) delete process.env.WORKERS_CI_BRANCH;
		else process.env.WORKERS_CI_BRANCH = previous;
	});
	process.env.WORKERS_CI_BRANCH = "emdash-update-1-4-0";
	assert.equal(site.run().defines.__UPDATER_PREVIEW_BUILD__, false, "Other hostings never build test versions");
	writeFileSync(fileURLToPath(new URL("wrangler.jsonc", site.root)), "{}");
	const preview = site.run();
	assert.equal(preview.defines.__UPDATER_PREVIEWS__, true);
	assert.equal(preview.defines.__UPDATER_PREVIEW_BUILD__, true);
	assert.ok(
		preview.routes.some((r) => r.pattern === "/_emdash/updater/preview-login"),
		"Test versions accept sign-in links from the live admin",
	);
	process.env.WORKERS_CI_BRANCH = "feature-x";
	const live = site.run();
	assert.equal(live.defines.__UPDATER_PREVIEW_BUILD__, false);
	assert.ok(
		!live.routes.some((r) => r.pattern === "/_emdash/updater/preview-login"),
		"The live site has no sign-in link route",
	);
});
