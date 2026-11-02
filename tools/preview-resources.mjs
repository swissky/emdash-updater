const API = "https://api.cloudflare.com/client/v4";

/** Minimal Cloudflare API client using the credentials Workers Builds injects. */
export function cloudflare(env = process.env, fetchImpl = fetch) {
	const account = env.CLOUDFLARE_ACCOUNT_ID;
	if (!account) throw new Error("CLOUDFLARE_ACCOUNT_ID is missing in the build environment.");
	const authHeaders = env.CLOUDFLARE_API_TOKEN
		? { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
		: env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_EMAIL
			? { "X-Auth-Key": env.CLOUDFLARE_API_KEY, "X-Auth-Email": env.CLOUDFLARE_EMAIL }
			: null;
	if (!authHeaders) throw new Error("No Cloudflare credentials in the build environment.");
	return async function call(
		path,
		{ method = "GET", json, body, contentType, binary = false, allow404 = false, withCursor = false } = {},
	) {
		const res = await fetchImpl(`${API}/accounts/${account}${path}`, {
			method,
			headers: {
				...authHeaders,
				...(json ? { "Content-Type": "application/json" } : {}),
				...(contentType ? { "Content-Type": contentType } : {}),
			},
			...(json ? { body: JSON.stringify(json) } : body ? { body } : {}),
		});
		if (allow404 && res.status === 404) return null;
		if (binary && method === "GET") {
			if (!res.ok) throw new Error(`Cloudflare GET ${path} failed: ${res.status}`);
			return new Uint8Array(await res.arrayBuffer());
		}
		const result = await res.json().catch(() => null);
		if (!res.ok || !result?.success)
			throw new Error(`Cloudflare ${method} ${path} failed: ${JSON.stringify(result?.errors ?? res.status)}`);
		return withCursor ? { result: result.result, cursor: result.result_info?.cursor } : result.result;
	};
}

export async function ensureD1(call, name) {
	const found = (await call(`/d1/database?name=${encodeURIComponent(name)}`)).find((db) => db.name === name);
	return found ? found.uuid : (await call("/d1/database", { method: "POST", json: { name } })).uuid;
}

export async function ensureR2(call, name) {
	if (!(await call(`/r2/buckets/${name}`, { allow404: true })))
		await call("/r2/buckets", { method: "POST", json: { name } });
	return name;
}

export async function ensureKV(call, title) {
	for (let page = 1; page <= 50; page++) {
		const list = await call(`/storage/kv/namespaces?per_page=100&page=${page}`);
		const found = list.find((n) => n.title === title);
		if (found) return found.id;
		if (list.length < 100) break;
	}
	return (await call("/storage/kv/namespaces", { method: "POST", json: { title } })).id;
}
