import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ROLLBACK_MARKER } from "./markers.mjs";
import { cloudflare } from "./preview-resources.mjs";

/** Loaded when first needed: only Cloudflare sites install wrangler. */
const wrangler = () => createRequire(import.meta.url)("wrangler");

export { ROLLBACK_MARKER };
const DONE_OPTION = "plugin:emdash-updater:rollbackDone";

function literal(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Runs in the production build of the undo commit: restores the live
 * database to the moment before the update was applied, using D1 Time
 * Travel. Each undo restores once, even if the build is retried later.
 */
export async function restoreBeforeUpdate({ root, env = process.env, log = console.log, fetchImpl = fetch }) {
	const markerPath = fileURLToPath(new URL(ROLLBACK_MARKER, root));
	if (!existsSync(markerPath)) return false;
	const last = JSON.parse(readFileSync(markerPath, "utf8"));
	const { id, before } = last;
	if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || Number.isNaN(Date.parse(before)))
		throw new Error(`[emdash-updater] ${ROLLBACK_MARKER} is invalid.`);
	const { rawConfig } = wrangler().experimental_readRawConfig({
		config: fileURLToPath(new URL("wrangler.jsonc", root)),
	});
	const db = rawConfig.d1_databases?.find((d) => d.binding === "DB") ?? rawConfig.d1_databases?.[0];
	if (!db?.database_id) throw new Error("[emdash-updater] No D1 database to restore.");
	const call = cloudflare(env, fetchImpl);
	const query = (sql) =>
		call(`/d1/database/${db.database_id}/query`, { method: "POST", json: { sql } });

	const [done] = await query(`SELECT value FROM options WHERE name = ${literal(DONE_OPTION)}`);
	if (done.results[0]?.value === JSON.stringify(id)) {
		log("[emdash-updater] The database was already restored for this undo.");
		return false;
	}
	log(`[emdash-updater] Restoring ${db.database_name} to ${before} (before the update)...`);
	await call(
		`/d1/database/${db.database_id}/time_travel/restore?${new URLSearchParams({ timestamp: before })}`,
		{ method: "POST" },
	);
	// The restored database still holds this update as "waiting for a decision"
	// and an older update as the last one; record this undo instead.
	const lastUpdate = { ...last, undone: { at: new Date().toISOString(), withDatabase: true } };
	const upsert = (name, value) =>
		`INSERT INTO options (name, value) VALUES (${literal(name)}, ${literal(JSON.stringify(value))}) ON CONFLICT(name) DO UPDATE SET value = excluded.value`;
	await query(
		[
			`DELETE FROM options WHERE name = 'plugin:emdash-updater:update'`,
			upsert(DONE_OPTION, id),
			upsert("plugin:emdash-updater:lastUpdate", lastUpdate),
		].join(";\n"),
	);
	log("[emdash-updater] Database restored. Changes made after the update are gone.");
	return true;
}
