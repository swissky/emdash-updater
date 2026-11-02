import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CLEANUP_MARKER, isUpdatePreviewBuild, UPDATE_BRANCH_PREFIX } from "./markers.mjs";
import { deletePreviewCopies } from "./preview-cleanup.mjs";
import { copyBucket, copyDatabase } from "./preview-copy.mjs";
import { cloudflare, ensureD1, ensureKV, ensureR2 } from "./preview-resources.mjs";

/** Loaded when first needed: only Cloudflare sites install wrangler. */
const wrangler = () => createRequire(import.meta.url)("wrangler");

export { isUpdatePreviewBuild, UPDATE_BRANCH_PREFIX };

const SESSION_BINDING = "SESSION";

/** Names of the preview copies, one per live binding. Every update preview reuses them. */
export function previewNames(config) {
	const base = `${config.name}-preview`;
	const name = (binding) => `${base}-${binding.toLowerCase().replaceAll("_", "-")}`.slice(0, 63);
	const kv = config.kv_namespaces ?? [];
	return {
		d1: (config.d1_databases ?? []).map((db) => ({ ...db, preview: name(db.binding) })),
		r2: (config.r2_buckets ?? []).map((bucket) => ({ ...bucket, preview: name(bucket.binding) })),
		kv: [
			...kv,
			...(kv.some((n) => n.binding === SESSION_BINDING) ? [] : [{ binding: SESSION_BINDING }]),
		].map((n) => ({ ...n, preview: name(n.binding) })),
	};
}

/**
 * Runs inside the Workers Builds build of an update branch: copies the live
 * database and media into separate preview resources and points the preview
 * deployment at them, so the update is tested on real content without
 * touching the live site.
 */
export async function prepareUpdatePreview({ root, env = process.env, log = console.log }) {
	const configPath = fileURLToPath(new URL("wrangler.jsonc", root));
	const { rawConfig } = wrangler().experimental_readRawConfig({ config: configPath });
	const names = previewNames(rawConfig);
	const call = cloudflare(env);

	if (existsSync(fileURLToPath(new URL(CLEANUP_MARKER, root)))) {
		await deletePreviewCopies(call, names, log);
		throw new Error(
			"[emdash-updater] The update was applied or discarded and the test copies are deleted. This build stops on purpose; nothing is deployed.",
		);
	}

	const d1 = [];
	for (const db of names.d1) {
		if (!db.database_id) throw new Error(`D1 binding ${db.binding} has no database_id in wrangler.jsonc.`);
		const id = await ensureD1(call, db.preview);
		log(`[emdash-updater] Copying live database ${db.database_name} into ${db.preview}...`);
		await copyDatabase(call, db.database_id, id, log);
		d1.push({ binding: db.binding, database_name: db.preview, database_id: id });
	}
	const r2 = [];
	for (const bucket of names.r2) {
		await ensureR2(call, bucket.preview);
		log(`[emdash-updater] Copying media from ${bucket.bucket_name} into ${bucket.preview}...`);
		await copyBucket(call, bucket.bucket_name, bucket.preview, log);
		r2.push({ binding: bucket.binding, bucket_name: bucket.preview });
	}
	const kv = [];
	for (const namespace of names.kv)
		kv.push({ binding: namespace.binding, id: await ensureKV(call, namespace.preview) });

	wrangler().experimental_patchConfig(
		configPath,
		{ previews: { d1_databases: d1, r2_buckets: r2, kv_namespaces: kv } },
		false,
	);
	log("[emdash-updater] Preview uses copies of the live content. The live site is unchanged.");
}
