export const MAX_STATEMENT_BYTES = 90_000;
const FTS_SHADOW = /_(config|content|data|docsize|idx)$/;

export const ident = (name) => `"${name.replaceAll('"', '""')}"`;

export function literal(value) {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return `X'${Buffer.from(value).toString("hex")}'`;
	return `'${String(value).replaceAll("'", "''")}'`;
}

/** Multi-row INSERTs for one table, split to stay under D1's statement size limit. */
export function insertStatements(table, columns, rows) {
	const head = `INSERT INTO ${ident(table)} (${columns.map(ident).join(",")}) VALUES `;
	const statements = [];
	let tuples = [];
	let size = head.length;
	for (const row of rows) {
		const tuple = `(${row.map(literal).join(",")})`;
		if (tuples.length && size + tuple.length + 1 > MAX_STATEMENT_BYTES) {
			statements.push(head + tuples.join(","));
			tuples = [];
			size = head.length;
		}
		tuples.push(tuple);
		size += tuple.length + 1;
	}
	if (tuples.length) statements.push(head + tuples.join(","));
	return statements;
}

/** Orders tables so referenced tables are filled before the tables pointing at them. */
export function dependencyOrder(tables, references) {
	const done = new Set();
	const out = [];
	const visit = (name, path) => {
		if (done.has(name) || path.has(name)) return;
		path.add(name);
		for (const parent of references.get(name) ?? [])
			if (tables.includes(parent)) visit(parent, path);
		done.add(name);
		out.push(name);
	};
	for (const name of tables) visit(name, new Set());
	return out;
}

/** FTS5 keeps its data in shadow tables that SQLite creates and fills itself. */
export function isFtsShadow(name, virtualTables) {
	return FTS_SHADOW.test(name) && virtualTables.has(name.replace(FTS_SHADOW, ""));
}

export function copyable(name) {
	return !name.startsWith("sqlite_") && !name.startsWith("_cf_");
}
