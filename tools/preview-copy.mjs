import {
	copyable,
	dependencyOrder,
	ident,
	insertStatements,
	isFtsShadow,
	literal,
	MAX_STATEMENT_BYTES,
} from "./preview-sql.mjs";

const VIRTUAL = /^CREATE VIRTUAL TABLE/i;

async function select(call, databaseId, sql) {
	const [result] = await call(`/d1/database/${databaseId}/raw`, {
		method: "POST",
		json: { sql },
	});
	return result.results.rows;
}

/** Sends statements in as few requests as possible. */
async function execAll(call, databaseId, statements) {
	let batch = [];
	let size = 0;
	const flush = async () => {
		if (!batch.length) return;
		await call(`/d1/database/${databaseId}/query`, {
			method: "POST",
			json: { sql: `PRAGMA defer_foreign_keys = on; ${batch.join(";\n")}` },
		});
		batch = [];
		size = 0;
	};
	for (const statement of statements) {
		if (size + statement.length > MAX_STATEMENT_BYTES) await flush();
		batch.push(statement);
		size += statement.length + 2;
	}
	await flush();
}

async function schemaOf(call, databaseId) {
	const items = (
		await select(
			call,
			databaseId,
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid",
		)
	).map(([type, name, table, sql]) => ({ type, name, table, sql }));
	const virtual = new Set(
		items.filter((i) => i.type === "table" && VIRTUAL.test(i.sql)).map((i) => i.name),
	);
	const tables = items.filter(
		(i) => i.type === "table" && copyable(i.name) && !isFtsShadow(i.name, virtual),
	);
	const references = groupBy(
		await pragmaRows(
			call,
			databaseId,
			tables.filter((t) => !virtual.has(t.name)).map((t) => t.name),
			(name) => `SELECT ${literal(name)}, "table" FROM pragma_foreign_key_list(${literal(name)})`,
		),
	);
	const order = dependencyOrder(
		tables.map((t) => t.name),
		references,
	);
	return { items, virtual, tables, order };
}

function groupBy(rows) {
	const map = new Map();
	for (const [key, value] of rows) map.set(key, [...(map.get(key) ?? []), value]);
	return map;
}

/** D1 refuses pragma functions joined to sqlite_master, so each table gets its own statement. */
async function pragmaRows(call, databaseId, tables, query) {
	if (!tables.length) return [];
	const results = await call(`/d1/database/${databaseId}/raw`, {
		method: "POST",
		json: { sql: tables.map(query).join(";\n") },
	});
	return results.flatMap((r) => r.results.rows);
}

/**
 * Replaces the target database with a copy of the source: tables, rows,
 * full-text indexes, indexes and triggers. The source is only read.
 */
export async function copyDatabase(call, sourceId, targetId, log = console.log) {
	const source = await schemaOf(call, sourceId);
	const target = await schemaOf(call, targetId);

	await execAll(
		call,
		targetId,
		target.order.toReversed().map((name) => `DROP TABLE IF EXISTS ${ident(name)}`),
	);
	await execAll(
		call,
		targetId,
		source.tables.map((t) => t.sql),
	);

	const columns = groupBy(
		await pragmaRows(
			call,
			sourceId,
			source.order,
			(name) => `SELECT ${literal(name)}, name FROM pragma_table_info(${literal(name)}) ORDER BY cid`,
		),
	);

	const names = source.order.filter((name) => columns.get(name)?.length);
	const results = await call(`/d1/database/${sourceId}/raw`, {
		method: "POST",
		json: {
			sql: names
				.map((name) => `SELECT ${columns.get(name).map(ident).join(",")} FROM ${ident(name)}`)
				.join(";\n"),
		},
	});
	let copied = 0;
	const inserts = [];
	names.forEach((name, i) => {
		const { rows } = results[i].results;
		inserts.push(...insertStatements(name, columns.get(name), rows));
		copied += rows.length;
	});
	await execAll(call, targetId, inserts);

	await execAll(
		call,
		targetId,
		source.items
			.filter(
				(i) =>
					(i.type === "index" || i.type === "trigger") &&
					copyable(i.table) &&
					!isFtsShadow(i.table, source.virtual),
			)
			.map((i) => i.sql),
	);
	log(
		`[emdash-updater] Copied ${source.tables.length} tables (${copied} rows) into the preview database.`,
	);
	return { tables: source.tables.length, rows: copied };
}

/** Copies every object of the source bucket into the target bucket. */
export async function copyBucket(call, source, target, log = console.log) {
	let cursor;
	let count = 0;
	do {
		const page = await call(
			`/r2/buckets/${source}/objects?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			{ withCursor: true },
		);
		for (const object of page.result) {
			const key = object.key.split("/").map(encodeURIComponent).join("/");
			const body = await call(`/r2/buckets/${source}/objects/${key}`, { binary: true });
			await call(`/r2/buckets/${target}/objects/${key}`, {
				method: "PUT",
				body,
				contentType: object.http_metadata?.contentType ?? "application/octet-stream",
			});
			count++;
		}
		cursor = page.cursor;
	} while (cursor);
	log(`[emdash-updater] Copied ${count} media files into the preview bucket.`);
	return count;
}
