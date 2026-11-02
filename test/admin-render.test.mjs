import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

const directory = await mkdtemp(resolve("node_modules/.updater-render-test-"));
try {
	await build({
		entryPoints: ["src/update-view.tsx", "src/undo-view.tsx"],
		outdir: directory,
		outExtension: { ".js": ".mjs" },
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	});
	const { UpdateView } = await import(pathToFileURL(resolve(directory, "update-view.mjs")).href);
	const i18n = setupI18n({ locale: "en", messages: { en: {} } });
	const render = (status) =>
		renderToStaticMarkup(
			createElement(I18nProvider, { i18n }, createElement(UpdateView, { status, busy: false, onStart() {}, onOpen() {}, onApply() {}, onDiscard() {} })),
		);
	const bumps = [{ name: "emdash", from: "1.3.1", to: "1.4.0" }];
	const base = { connected: true, repo: { owner: "o", name: "r" } };
	const update = { id: "u", bumps, branch: "emdash-update-1-4-0", phase: "ready", buildUrl: "https://dash.cloudflare.com/x" };

	const ready = render({ ...base, update, previewUrl: "https://emdash-update-1-4-0-site.example.workers.dev" });
	assert.match(ready, /<button(?:(?!<\/button>).)*Open test version/s, "The preview opens through a sign-in link, not a plain href");
	assert.doesNotMatch(ready, /href="https:\/\/emdash-update/);
	assert.match(ready, /signed in there automatically/);
	assert.match(ready, /Apply to live site/);

	const hostile = render({ ...base, update, previewUrl: "https://evil.example.com" });
	assert.doesNotMatch(hostile, /evil\.example\.com/, "Only workers.dev preview links are used");
	assert.match(hostile, /href="https:\/\/dash\.cloudflare\.com\/x"/, "Without a preview address the build page is linked");

	const building = render({ ...base, update: { ...update, phase: "building" } });
	assert.doesNotMatch(building, /Apply to live site/, "No apply button before the build finished");

	assert.match(render({ ...base, plan: { id: "p", bumps } }), /Try the update/);
	assert.match(render({ ...base, update: { ...update, phase: "no-build" } }), /Enable Preview Builds/);
	assert.match(render({ ...base, preview: true }), /This is the test version/);
	const direct = { ...update, direct: true, phase: "applied", buildUrl: undefined };
	const waiting = render({ ...base, update: { ...direct, appliedAt: new Date().toISOString() } });
	assert.doesNotMatch(waiting, /Go back to the previous version/, "No way back while the hosting is still building");
	const stuck = render({ ...base, update: { ...direct, appliedAt: new Date(Date.now() - 16 * 60_000).toISOString() } });
	assert.match(stuck, /has not reported a result/, "A silent hosting gets a hint after a while");
	assert.match(stuck, /Go back to the previous version/);
	const { UndoView } = await import(pathToFileURL(resolve(directory, "undo-view.mjs")).href);
	const undo = (reverted) =>
		renderToStaticMarkup(
			createElement(I18nProvider, { i18n }, createElement(UndoView, {
				lastUpdate: { id: "l", finishedAt: "2026-01-01T00:00:00Z", bumps, appliedSha: "a", undone: { at: "2026-01-01T00:00:00Z", withDatabase: false } },
				restoreWindowMs: 0, reverted, busy: false, onUndo() {},
			})),
		);
	assert.match(undo(false), /within about three minutes/);
	assert.match(undo(true), /runs the previous version again/, "Once published, the undo is reported as done");
	assert.doesNotMatch(undo(true), /within about three minutes/);
	console.log("Admin render checks passed.");
} finally {
	await rm(directory, { recursive: true, force: true });
}
