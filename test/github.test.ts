import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
	convertManifestCode,
	findEmDashRepos,
	GitHubError,
	installationToken,
	RepoClient,
} from "../src/github.ts";
import type { Repo } from "../src/github.ts";

const repo: Repo = {
	installationId: 1,
	owner: "owner",
	name: "site",
	defaultBranch: "main",
};
const original = "a".repeat(40);
const concurrent = "b".repeat(40);
const newCommit = "c".repeat(40);
const originalTree = "d".repeat(40);
const newTree = "e".repeat(40);
const response = (data: unknown, status = 200, next = false) =>
	new Response(JSON.stringify(data), {
		status,
		headers: next ? { link: '<https://untrusted.invalid/?page=2>; rel="next"' } : {},
	});
const content = (source: string) =>
	response({
		encoding: "base64",
		content: Buffer.from(source).toString("base64"),
	});
const credentials = {
	appId: "1",
	pem: generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs8", format: "pem" })
		.toString(),
};

// The transport models commit ancestry and GitHub's non-force ref update rule.
function repositoryTransport(race: boolean) {
	let head = original;
	const parents = new Map<string, string[]>([
		[original, []],
		[concurrent, [original]],
	]);
	const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
	const fetch = async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname.replace("/repos/owner/site", "");
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		if (init?.method) writes.push({ path, body });
		if (path === "/contents/package.json") {
			assert.equal(new URL(url).searchParams.get("ref"), original);
			return content('{"dependencies":{"emdash":"1.0.0"}}');
		}
		if (path === "/git/ref/heads/main") return response({ object: { sha: head } });
		if (path === `/git/commits/${original}`) return response({ tree: { sha: originalTree } });
		if (path === `/git/commits/${newCommit}`) return response({ parents: [{ sha: original }] });
		if (path === "/git/trees") {
			assert.equal(body.base_tree, originalTree);
			if (race) head = concurrent;
			return response({ sha: newTree });
		}
		if (path === "/git/commits") {
			assert.equal(body.tree, newTree);
			parents.set(newCommit, body.parents);
			return response({ sha: newCommit });
		}
		if (path === "/git/refs/heads/main") {
			const ancestors = [...(parents.get(body.sha) ?? [])];
			for (let i = 0; i < ancestors.length; i++)
				ancestors.push(...(parents.get(ancestors[i]!) ?? []));
			if (!body.force && !ancestors.includes(head))
				return response({ message: "Update is not a fast forward" }, 422);
			head = body.sha;
			return response({ object: { sha: head } });
		}
		throw new Error(`Unexpected request: ${url}`);
	};
	return {
		fetch,
		writes,
		head: () => head,
		move: () => {
			head = concurrent;
		},
		parents,
	};
}

const changes = [{ path: "package.json", content: '{"dependencies":{"emdash":"2.0.0"}}' }];
const stale = repositoryTransport(false);
const staleClient = new RepoClient(stale.fetch, "token", repo);
const capturedHead = await staleClient.headSha();
assert.equal(
	await staleClient.readFile("package.json", capturedHead),
	'{"dependencies":{"emdash":"1.0.0"}}',
);
stale.move();
await assert.rejects(
	staleClient.commit("Update", changes, capturedHead),
	(error: unknown) => error instanceof GitHubError && error.status === 409,
);
assert.equal(stale.writes.length, 0, "a stale update never creates trees or commits");
assert.equal(stale.head(), concurrent);

const racing = repositoryTransport(true);
await assert.rejects(
	new RepoClient(racing.fetch, "token", repo).commit("Update", changes, original),
	(error: unknown) => error instanceof GitHubError && error.status === 409,
);
assert.equal(racing.head(), concurrent, "a concurrent commit is not overwritten");
assert.deepEqual(
	racing.parents.get(newCommit),
	[original],
	"the update remains based on the content's original revision",
);
assert.ok(
	!racing.writes.some((write) => write.path.includes("/refs/")),
	"A known moved head is rejected before publishing",
);

const success = repositoryTransport(false);
assert.equal(
	await new RepoClient(success.fetch, "token", repo).commit("Update", changes, original, [
		"old.txt",
	]),
	newCommit,
);
assert.equal(success.head(), newCommit);
assert.deepEqual(success.parents.get(newCommit), [original]);
assert.deepEqual(success.writes[0]?.body.tree, [
	{
		path: "package.json",
		mode: "100644",
		type: "blob",
		content: changes[0]!.content,
	},
	{ path: "old.txt", mode: "100644", type: "blob", sha: null },
]);
await assert.rejects(
	new RepoClient(success.fetch, "token", repo).commit("Update", changes, ""),
	GitHubError,
);

const manifests: Record<string, string> = {
	valid: '{"dependencies":{"emdash":"^1.3.0"}}',
	dev: '{"devDependencies":{"emdash":"1.3.0"}}',
	unrelated: '{"config":{"emdash":"1.3.0"}}',
	broken: '{"dependencies":{"emdash":"1.3.0"}',
	null: "null",
	array: '[{"dependencies":{"emdash":"1.3.0"}}]',
	badRange: '{"dependencies":{"emdash":42}}',
	emptyRange: '{"dependencies":{"emdash":" "}}',
	badDeps: '{"dependencies":[],"devDependencies":{"emdash":"1.3.0"}}',
	badSibling: '{"dependencies":{"emdash":"1.3.0","other":false}}',
};
const repoData = (name: string) => ({
	id: 67890,
	name,
	owner: { login: "owner", id: 12345 },
	default_branch: "main",
});
const visited: string[] = [];
const discovered = await findEmDashRepos(async (url, init) => {
	const parsed = new URL(url);
	assert.equal(
		parsed.origin,
		"https://api.github.com",
		"pagination never forwards credentials to a Link URL",
	);
	visited.push(`${parsed.pathname}${parsed.search}`);
	if (parsed.pathname === "/app/installations") {
		return parsed.searchParams.get("page") === "1"
			? response([{ id: 1 }], 200, true)
			: response([{ id: 2 }]);
	}
	if (parsed.pathname.endsWith("/access_tokens")) {
		return response({
			token: parsed.pathname.includes("/1/") ? "first" : "second",
		});
	}
	if (parsed.pathname === "/installation/repositories") {
		if (new Headers(init?.headers).get("authorization") === "Bearer second")
			return response({ repositories: [repoData("dev")] });
		return parsed.searchParams.get("page") === "1"
			? response(
					{
						repositories: Object.keys(manifests)
							.filter((name) => name !== "valid" && name !== "dev")
							.map(repoData),
					},
					200,
					true,
				)
			: response({ repositories: [repoData("valid"), repoData("missing")] });
	}
	const name = parsed.pathname.split("/")[3]!;
	return name === "missing" ? response({}, 404) : content(manifests[name]!);
}, credentials);
assert.deepEqual(
	discovered.map((r) => r.name),
	["valid", "dev"],
);
assert.ok(discovered.every((r) => r.repositoryId === 67890 && r.ownerId === 12345));
assert.ok(visited.includes("/app/installations?per_page=100&page=2"));
assert.ok(visited.includes("/installation/repositories?per_page=100&page=2"));

const check = (name: string) => ({
	name,
	status: "completed",
	conclusion: "success",
	details_url: null,
	html_url: "https://github.com/owner/site/actions",
});
let checkPages = 0;
const checks = await new RepoClient(
	async (url) => {
		checkPages++;
		assert.equal(new URL(url).searchParams.get("page"), String(checkPages));
		return response({
			check_runs:
				checkPages === 1
					? Array.from({ length: 100 }, (_, i) => check(`check-${i}`))
					: [check("last")],
		});
	},
	"token",
	repo,
).checks(original);
assert.equal(checkPages, 2, "full pages are followed even without a Link header");
assert.equal(checks.length, 101);
assert.equal(checks.at(-1)?.name, "last");

let limitPages = 0;
await assert.rejects(
	new RepoClient(
		async () => {
			limitPages++;
			return response({ check_runs: [] }, 200, true);
		},
		"token",
		repo,
	).checks(original),
	/pagination limit/,
);
assert.equal(limitPages, 100);

for (const bad of [
	{},
	{ check_runs: null },
	{ check_runs: [null] },
	{ check_runs: [{ ...check("bad"), conclusion: "unknown" }] },
	{ check_runs: [{ ...check("bad"), html_url: "javascript:alert(1)" }] },
]) {
	await assert.rejects(
		new RepoClient(async () => response(bad), "token", repo).checks(original),
		GitHubError,
	);
}
for (const bad of [
	{ content: "aA==", encoding: "none" },
	{ content: "not base64!", encoding: "base64" },
	[],
	{ content: "/w==", encoding: "base64" },
]) {
	await assert.rejects(
		new RepoClient(async () => response(bad), "token", repo).readFile("package.json"),
		GitHubError,
	);
}
assert.equal(
	await new RepoClient(async () => content(""), "token", repo).readFile("empty.txt"),
	"",
);
assert.equal(
	await new RepoClient(async () => response({}, 404), "token", repo).readFile("absent.txt"),
	null,
);
await assert.rejects(
	new RepoClient(async () => response({ object: { sha: "not-a-sha" } }), "token", repo).headSha(),
	GitHubError,
);
await assert.rejects(
	installationToken(async () => response({ token: 42 }), credentials, 1),
	GitHubError,
);
await assert.rejects(
	findEmDashRepos(async () => response({ installations: [] }), credentials),
	GitHubError,
);
await assert.rejects(
	findEmDashRepos(async () => response([{ id: "1" }]), credentials),
	GitHubError,
);

await assert.rejects(
	installationToken(async () => new Response(null, { status: 201 }), credentials, 1),
	/invalid data/,
	"Empty 201 is accepted only for the secret PUT, not other creation responses",
);

const secret = "sensitive-token-or-code";
for (const status of [401, 403, 409, 422, 429, 500]) {
	await assert.rejects(
		convertManifestCode(async () => response({ message: secret.repeat(1000) }, status), secret),
		(error: unknown) => {
			assert.ok(error instanceof GitHubError);
			assert.equal(error.status, status);
			assert.ok(error.message.length < 250);
			assert.ok(!error.message.includes(secret));
			return true;
		},
	);
}
await assert.rejects(
	convertManifestCode(async () => {
		throw new Error(secret);
	}, secret),
	(error: unknown) => {
		assert.ok(error instanceof GitHubError);
		assert.ok(!error.message.includes(secret));
		return true;
	},
);
await assert.rejects(
	convertManifestCode(async () => new Response(`invalid JSON ${secret}`), secret),
	GitHubError,
);
await assert.rejects(
	convertManifestCode(async () => response({ id: 1, pem: secret }), secret),
	GitHubError,
);
const app = {
	id: 1,
	slug: "updater",
	pem: credentials.pem,
	html_url: "https://github.com/apps/updater",
	owner: { login: "owner" },
};
assert.deepEqual(await convertManifestCode(async () => response(app), secret), app);
console.log("github: ok");
