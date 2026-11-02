export interface Bump {
	name: string;
	from: string;
	to: string;
}

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?![\s\S])/;
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
const RANGE_PREFIX = /^[\^~]/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?![\s\S])/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Release-only comparison: prereleases never count as newer than a release. */
export function isNewer(candidate: string, current: string): boolean {
	const a = SEMVER.exec(candidate);
	const b = SEMVER.exec(current.replace(RANGE_PREFIX, ""));
	if (!a || !b || a[4]) return false;
	for (let i = 1; i <= 3; i++) {
		const diff = BigInt(a[i]!) - BigInt(b[i]!);
		if (diff !== 0n) return diff > 0n;
	}
	return Boolean(b[4]);
}

export function isEmDashPackage(name: string): boolean {
	return name === "emdash" || name.startsWith("@emdash-cms/");
}

/** Pins upgraded EmDash dependencies to the reviewed target version. */
export function bumpPackageJson(
	text: string,
	latest: Record<string, string>,
): { content: string; bumps: Bump[] } {
	const pkg: unknown = JSON.parse(text);
	if (!isRecord(pkg)) throw new Error("package.json must contain an object.");
	if (!isRecord(latest)) throw new Error("Resolved versions must contain an object.");
	const bumps: Bump[] = [];
	for (const field of ["dependencies", "devDependencies"]) {
		if (!Object.hasOwn(pkg, field)) continue;
		const deps = pkg[field];
		if (!isRecord(deps)) throw new Error(`package.json ${field} must contain an object.`);
		for (const [name, range] of Object.entries(deps)) {
			if (typeof range !== "string")
				throw new Error(`package.json ${field}.${name} must be a string.`);
			if (!isEmDashPackage(name)) continue;
			if (name.length > 214 || !PACKAGE_NAME.test(name))
				throw new Error(`Invalid package name: ${name}.`);
			const current = range.replace(RANGE_PREFIX, "");
			if (!STABLE.test(current)) {
				throw new Error(
					`Unsupported version range for ${name}: ${range}. Use an exact stable version, ^x.y.z, or ~x.y.z; workspace, catalog, aliases, and other ranges require a manual update.`,
				);
			}
			const target = latest[name];
			if (!Object.hasOwn(latest, name) || typeof target !== "string" || !STABLE.test(target)) {
				throw new Error(
					`Missing or invalid resolved version for ${name}. Retry the registry check before updating.`,
				);
			}
			if (!isNewer(target, current)) continue;
			if (target.split(".")[0] !== current.split(".")[0]) {
				throw new Error(
					`Major upgrade blocked for ${name}: ${current} to ${target}. Review the migration guide and update this package manually.`,
				);
			}
			deps[name] = target;
			bumps.push({ name, from: current, to: target });
		}
	}
	const indent = /^(\s+)"/m.exec(text)?.[1] ?? "\t";
	return { content: `${JSON.stringify(pkg, null, indent)}\n`, bumps };
}

export async function resolveVersions(
	fetcher: (url: string, init?: RequestInit) => Promise<Response>,
	names: string[],
	minimumAgeMs = 86_400_000,
	currentVersions?: Record<string, string>,
): Promise<Record<string, string>> {
	if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0)
		throw new Error("Minimum release age must be a finite, nonnegative number.");
	for (const name of names) {
		if (
			typeof name !== "string" ||
			name.length > 214 ||
			!PACKAGE_NAME.test(name) ||
			!isEmDashPackage(name)
		) {
			throw new Error(`Invalid EmDash package name: ${name}.`);
		}
		if (
			currentVersions &&
			(typeof currentVersions[name] !== "string" ||
				!STABLE.test(currentVersions[name].replace(RANGE_PREFIX, "")))
		) {
			throw new Error(
				`Unsupported current version for ${name}. Use an exact stable version, ^x.y.z, or ~x.y.z.`,
			);
		}
	}
	const cutoff = Date.now() - minimumAgeMs;
	const entries = await Promise.all(
		[...new Set(names)].map(async (name) => {
			try {
				const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
					headers: { Accept: "application/json" },
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}.`);
				const body: unknown = await response.json();
				if (
					!isRecord(body) ||
					body.name !== name ||
					!isRecord(body["dist-tags"]) ||
					!isRecord(body.versions) ||
					!isRecord(body.time)
				) {
					throw new Error("Malformed npm package metadata.");
				}
				const latest = body["dist-tags"].latest;
				if (
					typeof latest !== "string" ||
					!STABLE.test(latest) ||
					!Object.hasOwn(body.versions, latest)
				) {
					throw new Error("Missing or invalid stable latest tag.");
				}
				let selected: string | undefined;
				for (const [version, manifest] of Object.entries(body.versions)) {
					if (
						!SEMVER.test(version) ||
						!isRecord(manifest) ||
						manifest.version !== version ||
						(manifest.name !== undefined && manifest.name !== name)
					) {
						throw new Error(`Malformed metadata for version ${version}.`);
					}
					if (manifest.deprecated !== undefined && typeof manifest.deprecated !== "string") {
						throw new Error(`Malformed deprecation metadata for version ${version}.`);
					}
					if (!STABLE.test(version) || isNewer(version, latest)) continue;
					if (
						currentVersions &&
						version.split(".")[0] !== currentVersions[name]!.replace(RANGE_PREFIX, "").split(".")[0]
					)
						continue;
					const timestamp = body.time[version];
					if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
						throw new Error(`Missing or invalid publication time for version ${version}.`);
					}
					if (manifest.deprecated || Date.parse(timestamp) > cutoff) continue;
					if (!selected || isNewer(version, selected)) selected = version;
				}
				if (!selected)
					throw new Error(
						`No stable, nondeprecated release at or below latest meets the minimum release age of ${minimumAgeMs} ms.`,
					);
				return [name, selected] as const;
			} catch (error) {
				throw new Error(
					`Cannot resolve ${name}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
		}),
	);
	return Object.fromEntries(entries);
}
