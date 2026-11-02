import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { AstroIntegration } from "astro";

import { isUpdatePreviewBuild } from "../tools/markers.mjs";
import { prepareUpdatePreview } from "../tools/preview-build.mjs";
import { restoreBeforeUpdate } from "../tools/rollback-build.mjs";

function installedVersion(require: NodeRequire, name: string): string {
	let path: string;
	try {
		path = require.resolve(`${name}/package.json`);
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED"
		)
			throw error;
		path = require.resolve(name);
	}
	let directory = dirname(path);
	while (true) {
		try {
			const pkg = JSON.parse(
				readFileSync(join(directory, "package.json"), "utf8"),
			);
			if (pkg.name === name) {
				if (typeof pkg.version !== "string" || !pkg.version.trim()) {
					throw new Error(`Missing installed version for ${name}.`);
				}
				return pkg.version;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(directory);
		if (parent === directory)
			throw new Error(`Cannot locate installed package.json for ${name}.`);
		directory = parent;
	}
}

export interface UpdaterOptions {
	/**
	 * Test each update on a copy of the site before it goes live. Needs
	 * Cloudflare Workers Builds and D1; defaults to on when the site has a
	 * `wrangler.jsonc`. Without it, updates go straight to the live branch.
	 */
	previews?: boolean;
}

export default function updater(options: UpdaterOptions = {}): AstroIntegration {
	let root: URL | undefined;
	let previews = false;
	return {
		name: "emdash-updater",
		hooks: {
			// Only after a successful build, so a failed undo never leaves the
			// old content running on the new code.
			async "astro:build:done"({ logger }) {
				if (!root || !previews || !process.env.WORKERS_CI_BRANCH || isUpdatePreviewBuild()) return;
				await restoreBeforeUpdate({ root, log: (m) => logger.info(m) });
			},
			async "astro:config:setup"({ config, updateConfig, injectRoute, command, logger }) {
				root = config.root;
				previews = options.previews ?? existsSync(new URL("wrangler.jsonc", config.root));
				if (previews && command === "build" && isUpdatePreviewBuild()) {
					await prepareUpdatePreview({ root: config.root, log: (m) => logger.info(m) });
				}
				const packageUrl = new URL("package.json", config.root);
				const pkg = JSON.parse(readFileSync(packageUrl, "utf8"));
				const require = createRequire(packageUrl);
				const names = [
					...new Set([
						...Object.keys(pkg.dependencies ?? {}),
						...Object.keys(pkg.devDependencies ?? {}),
					]),
				].filter(
					(name) => name === "emdash" || name.startsWith("@emdash-cms/"),
				);
				const packages = Object.fromEntries(
					names.map((name) => [name, installedVersion(require, name)]),
				);
				updateConfig({
					vite: {
						define: {
							__UPDATER_PACKAGES__: JSON.stringify(packages),
							__UPDATER_PREVIEW_BUILD__: JSON.stringify(previews && isUpdatePreviewBuild()),
							__UPDATER_PREVIEWS__: JSON.stringify(previews),
						},
					},
				});
				injectRoute({
					pattern: "/connect-github",
					entrypoint: new URL("./connect-github.astro", import.meta.url),
					prerender: false,
				});
				if (previews && isUpdatePreviewBuild())
					injectRoute({
						pattern: "/_emdash/updater/preview-login",
						entrypoint: new URL("./preview-login.astro", import.meta.url),
						prerender: false,
					});
			},
		},
	};
}
