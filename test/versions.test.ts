import assert from "node:assert/strict";

import { bumpPackageJson, isEmDashPackage, isNewer, resolveVersions } from "../src/versions.ts";

assert.equal(isNewer("1.4.0", "1.3.1"), true);
assert.equal(isNewer("1.3.1", "^1.3.1"), false);
assert.equal(isNewer("1.10.0", "1.9.0"), true);
assert.equal(isNewer("2.0.0-rc.1", "1.3.1"), false);
assert.equal(isNewer("1.0.1", "1.0.1-rc.1"), true);
assert.equal(isNewer("9007199254740993.0.0", "9007199254740992.0.0"), true);
assert.equal(isNewer("01.4.0", "1.3.1"), false);
assert.equal(isEmDashPackage("emdash"), true);
assert.equal(isEmDashPackage("@emdash-cms/cloudflare"), true);
assert.equal(isEmDashPackage("emdash-updater"), false);

const pkg = `{
  "dependencies": {
    "emdash": "1.3.1",
    "@emdash-cms/cloudflare": "^1.3.1",
    "astro": "^7.3.2",
    "emdash-updater": "^1.0.0"
  },
  "devDependencies": {
    "@emdash-cms/admin": "~1.3.1"
  }
}\n`;
const targets = {
	emdash: "1.4.0",
	"@emdash-cms/cloudflare": "1.4.0",
	"@emdash-cms/admin": "1.4.0",
	astro: "9.9.9",
};
const { content, bumps } = bumpPackageJson(pkg, targets);
const out = JSON.parse(content);
assert.equal(out.dependencies.emdash, "1.4.0");
assert.equal(out.dependencies["@emdash-cms/cloudflare"], "1.4.0");
assert.equal(out.devDependencies["@emdash-cms/admin"], "1.4.0");
assert.equal(out.dependencies.astro, "^7.3.2", "non-EmDash packages are never bumped");
assert.equal(out.dependencies["emdash-updater"], "^1.0.0");
assert.deepEqual(bumps, [
	{ name: "emdash", from: "1.3.1", to: "1.4.0" },
	{ name: "@emdash-cms/cloudflare", from: "1.3.1", to: "1.4.0" },
	{ name: "@emdash-cms/admin", from: "1.3.1", to: "1.4.0" },
]);
assert.ok(content.startsWith('{\n  "dependencies"'), "keeps two-space indentation");
assert.deepEqual(
	bumpPackageJson(content, targets).bumps,
	[],
	"an already applied upgrade is a no-op",
);
assert.equal(bumpPackageJson(content, targets).content, content);
assert.deepEqual(
	bumpPackageJson('{"dependencies":{"emdash":"^1.4.0"}}', { emdash: "1.3.0" }).bumps,
	[],
	"never downgrades",
);

for (const text of ["{", "null", "[]", '"package"', "42"]) {
	assert.throws(() => bumpPackageJson(text, {}));
}
for (const field of ["dependencies", "devDependencies"]) {
	for (const malformed of [null, [], false, "1.0.0", 42]) {
		assert.throws(
			() => bumpPackageJson(JSON.stringify({ [field]: malformed }), {}),
			/must contain an object/,
		);
	}
	for (const value of [null, {}, [], 42, false]) {
		assert.throws(
			() => bumpPackageJson(JSON.stringify({ [field]: { emdash: value } }), targets),
			/must be a string/,
		);
		assert.throws(
			() => bumpPackageJson(JSON.stringify({ [field]: { astro: value } }), targets),
			/must be a string/,
		);
	}
}
for (const range of [
	"workspace:*",
	"catalog:",
	"file:../emdash",
	"npm:emdash@1.4.0",
	"latest",
	"*",
	"1.x",
	">=1.0.0",
	"1.0.0 || 1.4.0",
	"^1.0",
	"1.4.0-rc.1",
	"1.4.0+build",
	"01.4.0",
	" 1.4.0",
	"1.4.0\n",
	"^^1.4.0",
]) {
	assert.throws(
		() => bumpPackageJson(JSON.stringify({ dependencies: { emdash: range } }), targets),
		/Unsupported version range/,
	);
}
for (const target of [undefined, null, 42, "", "latest", "^1.4.0", "1.4.0-rc.1", "01.4.0"]) {
	assert.throws(
		() =>
			bumpPackageJson('{"dependencies":{"emdash":"1.3.0"}}', { emdash: target } as Record<
				string,
				string
			>),
		/Missing or invalid resolved version/,
	);
}
assert.throws(() => bumpPackageJson(pkg, {}), /Missing or invalid resolved version/);
assert.throws(
	() => bumpPackageJson(pkg, { ...targets, emdash: "2.0.0" }),
	/Major upgrade blocked.*Review the migration guide.*manually/,
);
assert.throws(
	() => bumpPackageJson('{"devDependencies":{"emdash":"^0.9.0"}}', { emdash: "1.0.0" }),
	/Major upgrade blocked/,
);
assert.throws(
	() => bumpPackageJson('{"dependencies":{"@emdash-cms/../evil":"1.0.0"}}', {}),
	/Invalid package name/,
);

const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
const recent = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 86_400_000).toISOString();
function packument(name = "emdash") {
	return {
		name,
		"dist-tags": { latest: "1.5.0" },
		versions: {
			"1.9.0": { name, version: "1.9.0" },
			"1.5.0": { name, version: "1.5.0" },
			"1.4.0": { name, version: "1.4.0", deprecated: "Broken release" },
			"1.3.0": { name, version: "1.3.0" },
			"1.2.0": { name, version: "1.2.0" },
			"2.0.0-rc.1": { name, version: "2.0.0-rc.1" },
		},
		time: {
			"1.9.0": old,
			"1.5.0": recent,
			"1.4.0": old,
			"1.3.0": old,
			"1.2.0": old,
			"2.0.0-rc.1": old,
		},
	};
}
const urls: string[] = [];
const mockRegistry = async (url: string, init?: RequestInit) => {
	urls.push(url);
	assert.ok(init?.signal instanceof AbortSignal, "registry requests have a timeout signal");
	assert.equal(init.redirect, "error", "registry redirects must not bypass the package URL");
	const name = decodeURIComponent(new URL(url).pathname.slice(1));
	return Response.json(packument(name));
};
assert.deepEqual(
	await resolveVersions(mockRegistry, ["emdash", "@emdash-cms/cloudflare", "emdash"]),
	{
		emdash: "1.3.0",
		"@emdash-cms/cloudflare": "1.3.0",
	},
	"skip young, deprecated, prerelease, and versions above latest",
);
assert.deepEqual(urls, [
	"https://registry.npmjs.org/emdash",
	"https://registry.npmjs.org/%40emdash-cms%2Fcloudflare",
]);
assert.deepEqual(
	await resolveVersions(mockRegistry, ["emdash"], 0),
	{ emdash: "1.5.0" },
	"latest is an inclusive upper bound",
);
assert.deepEqual(await resolveVersions(mockRegistry, []), {});
const numericOrder = packument();
numericOrder["dist-tags"].latest = "1.9.0";
assert.deepEqual(
	await resolveVersions(async () => Response.json(numericOrder), ["emdash"]),
	{ emdash: "1.9.0" },
	"selection is not tied to registry insertion order",
);

let calls = 0;
for (const name of [
	"@emdash-cms/",
	"@emdash-cms/../evil",
	"@emdash-cms/foo?x=1",
	"@emdash-cms/foo#fragment",
	"@emdash-cms/%2f",
	"https://evil.test",
	"emdash/extra",
	"@emdash-cms/Uppercase",
	"astro",
	`@emdash-cms/${"a".repeat(215)}`,
]) {
	await assert.rejects(
		resolveVersions(async () => {
			calls++;
			return Response.json({});
		}, ["emdash", name]),
		/Invalid EmDash package name/,
	);
}
assert.equal(calls, 0, "validate all names before making any network request");
for (const age of [-1, NaN, Infinity]) {
	await assert.rejects(resolveVersions(mockRegistry, ["emdash"], age), /Minimum release age/);
}
for (const status of [404, 429, 500]) {
	await assert.rejects(
		resolveVersions(async () => new Response("failure", { status }), ["emdash"]),
		new RegExp(`Cannot resolve emdash:.*HTTP ${status}`),
	);
}
await assert.rejects(
	resolveVersions(async () => {
		throw new Error("offline");
	}, ["emdash"]),
	/Cannot resolve emdash: offline/,
);
await assert.rejects(
	resolveVersions(async () => {
		throw new DOMException("request timed out", "TimeoutError");
	}, ["emdash"]),
	/Cannot resolve emdash: request timed out/,
);
await assert.rejects(
	resolveVersions(async () => new Response("not JSON"), ["emdash"]),
	/Cannot resolve emdash/,
);
await assert.rejects(
	resolveVersions(
		async (url) =>
			url.endsWith("emdash")
				? Response.json(packument())
				: new Response("missing", { status: 404 }),
		["emdash", "@emdash-cms/admin"],
	),
	/Cannot resolve @emdash-cms\/admin/,
	"one failed package rejects the whole result",
);

const valid = packument();
for (const body of [
	null,
	[],
	"metadata",
	{},
	{ ...valid, name: "another-package" },
	{ ...valid, "dist-tags": [] },
	{ ...valid, "dist-tags": {} },
	{ ...valid, "dist-tags": { latest: "2.0.0-rc.1" } },
	{ ...valid, "dist-tags": { latest: "3.0.0" } },
	{ ...valid, versions: [] },
	{ ...valid, versions: { ...valid.versions, "1.3.0": null } },
	{ ...valid, versions: { ...valid.versions, "1.3.0": { version: "9.0.0" } } },
	{ ...valid, versions: { ...valid.versions, "1.3.0": { name: "other", version: "1.3.0" } } },
	{ ...valid, versions: { ...valid.versions, "1.3.0": { version: "1.3.0", deprecated: false } } },
	{ ...valid, time: [] },
	{ ...valid, time: {} },
	{ ...valid, time: { ...valid.time, "1.3.0": "not a date" } },
	{ ...valid, time: { ...valid.time, "1.3.0": 123 } },
]) {
	await assert.rejects(
		resolveVersions(async () => Response.json(body), ["emdash"]),
		/Cannot resolve emdash/,
	);
}
for (const body of [
	{ ...valid, time: Object.fromEntries(Object.keys(valid.time).map((v) => [v, recent])) },
	{ ...valid, time: Object.fromEntries(Object.keys(valid.time).map((v) => [v, future])) },
	{
		...valid,
		versions: Object.fromEntries(
			Object.entries(valid.versions).map(([v, metadata]) => [
				v,
				{ ...metadata, deprecated: "Removed" },
			]),
		),
	},
]) {
	await assert.rejects(
		resolveVersions(async () => Response.json(body), ["emdash"]),
		/No stable, nondeprecated release/,
	);
}
const majorRegistry = async (url: string) => {
	const name = decodeURIComponent(new URL(url).pathname.slice(1));
	return Response.json({
		name,
		"dist-tags": { latest: "2.0.0" },
		versions: Object.fromEntries(
			["1.4.0", "1.4.1", "2.0.0"].map((version) => [version, { name, version }]),
		),
		time: { "1.4.0": old, "1.4.1": old, "2.0.0": old },
	});
};
const current = { emdash: "^1.4.0", "@emdash-cms/cloudflare": "~1.4.0" };
const eligible = await resolveVersions(majorRegistry, Object.keys(current), undefined, current);
assert.deepEqual(eligible, { emdash: "1.4.1", "@emdash-cms/cloudflare": "1.4.1" });
assert.equal((await resolveVersions(majorRegistry, ["emdash"], 0)).emdash, "2.0.0");
assert.equal(
	bumpPackageJson(JSON.stringify({ dependencies: current }), eligible).bumps.length,
	2,
	"New major releases do not block compatible companion updates",
);
await assert.rejects(
	resolveVersions(majorRegistry, ["emdash"], undefined, { emdash: "workspace:*" }),
	/Unsupported current version/,
);
console.log("versions: ok");
