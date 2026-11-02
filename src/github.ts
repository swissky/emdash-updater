const API = "https://api.github.com";
const UA = "emdash-updater";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface AppCredentials {
	appId: string;
	pem: string;
}

function b64url(bytes: Uint8Array | string): string {
	const bin =
		typeof bytes === "string" ? bytes : Array.from(bytes, (b) => String.fromCharCode(b)).join("");
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derLength(len: number): number[] {
	if (len < 0x80) return [len];
	const out: number[] = [];
	while (len > 0) {
		out.unshift(len & 0xff);
		len >>= 8;
	}
	return [0x80 | out.length, ...out];
}

/** Wraps a PKCS#1 RSA key (what GitHub issues) into PKCS#8 for WebCrypto. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
	const algId = [
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
	];
	const octet = [0x04, ...derLength(pkcs1.length)];
	const body = [0x02, 0x01, 0x00, ...algId, ...octet];
	const total = body.length + pkcs1.length;
	const out = new Uint8Array([0x30, ...derLength(total), ...body, ...pkcs1]);
	return out;
}

async function importKey(pem: string): Promise<CryptoKey> {
	const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
	const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey(
		"pkcs8",
		isPkcs1 ? pkcs1ToPkcs8(der) : der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

export async function appJwt({ appId, pem }: AppCredentials): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
	const data = `${header}.${payload}`;
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		await importKey(pem),
		new TextEncoder().encode(data),
	);
	return `${data}.${b64url(new Uint8Array(sig))}`;
}

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 100;

function invalidResponse(): never {
	throw new GitHubError("GitHub returned invalid data. Refresh and try again.", 502);
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
	return value as Record<string, unknown>;
}

function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) invalidResponse();
	return value;
}

function positive(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidResponse();
	return value as number;
}

function sha(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) invalidResponse();
	return value;
}

async function gh(
	fetch: Fetch,
	token: string,
	path: string,
	init: RequestInit = {},
	emptyCreated = false,
) {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new GitHubError(
					"GitHub timed out. Refresh repository state before retrying an update.",
					504,
				),
			);
			controller.abort();
		}, REQUEST_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			(async () => {
				const res = await fetch(`${API}${path}`, {
					...init,
					signal: controller.signal,
					redirect: "error",
					headers: {
						Accept: "application/vnd.github+json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
						"User-Agent": UA,
						"X-GitHub-Api-Version": "2022-11-28",
						...(init.body ? { "Content-Type": "application/json" } : {}),
					},
				});
				if (!res.ok) {
					const advice =
						res.status === 401 || res.status === 403
							? "Check the GitHub App credentials, repository permissions and rate limit."
							: res.status === 409 || res.status === 422
								? "Refresh repository state and check branch protection before retrying."
								: res.status === 404
									? "Check repository access and the requested file or branch."
									: res.status === 429
										? "GitHub's rate limit was reached. Wait before refreshing and retrying."
										: "Refresh repository state before retrying.";
					throw new GitHubError(`GitHub request failed (${res.status}). ${advice}`, res.status);
				}
				if (res.status === 204 || (emptyCreated && res.status === 201))
					return { data: null, hasNext: false };
				let data: unknown;
				try {
					data = await res.json();
				} catch {
					invalidResponse();
				}
				return {
					data,
					hasNext: /rel="next"/.test(res.headers.get("link") ?? ""),
				};
			})(),
			timeout,
		]);
	} catch (error) {
		if (error instanceof GitHubError) throw error;
		throw new GitHubError(
			"Could not reach GitHub. Check connectivity and refresh repository state before retrying.",
			502,
		);
	} finally {
		clearTimeout(timer);
	}
}

async function* pages(fetch: Fetch, token: string, path: string, field?: string) {
	for (let page = 1; page <= MAX_PAGES; page++) {
		const { data, hasNext } = await gh(
			fetch,
			token,
			`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
		);
		const items = field ? object(data)[field] : data;
		if (!Array.isArray(items) || items.length > 100) invalidResponse();
		yield items as unknown[];
		if (!hasNext && items.length < 100) return;
	}
	throw new GitHubError(
		"GitHub pagination limit reached. Narrow the App's repository access and try again.",
		502,
	);
}

/** Exchanges the one-time code from the App manifest flow for the new App's credentials. */
export async function convertManifestCode(fetch: Fetch, code: string) {
	const { data } = await gh(
		fetch,
		"",
		`/app-manifests/${encodeURIComponent(text(code))}/conversions`,
		{
			method: "POST",
		},
	);
	const app = object(data);
	if (!Number.isSafeInteger(app.id) || (app.id as number) <= 0) invalidResponse();
	return {
		id: app.id as number,
		slug: text(app.slug),
		pem: text(app.pem),
		html_url: text(app.html_url),
		owner: { login: text(object(app.owner).login) },
	};
}

export interface Repo {
	repositoryId?: number;
	ownerId?: number;
	installationId: number;
	owner: string;
	name: string;
	defaultBranch: string;
}

/** Repositories the App was granted whose package.json depends on emdash. */
export async function findEmDashRepos(fetch: Fetch, creds: AppCredentials): Promise<Repo[]> {
	const jwt = await appJwt(creds);
	const candidates: Repo[] = [];
	for await (const installs of pages(fetch, jwt, "/app/installations")) {
		for (const install of installs) {
			const installationId = object(install).id;
			if (!Number.isSafeInteger(installationId) || (installationId as number) <= 0)
				invalidResponse();
			const token = await installationToken(fetch, creds, installationId as number);
			for await (const repositories of pages(
				fetch,
				token,
				"/installation/repositories",
				"repositories",
			)) {
				for (const item of repositories) {
					const r = object(item);
					const owner = object(r.owner);
					if (
						!Number.isSafeInteger(r.id) ||
						(r.id as number) <= 0 ||
						!Number.isSafeInteger(owner.id) ||
						(owner.id as number) <= 0
					)
						invalidResponse();
					const repo = {
						repositoryId: r.id as number,
						ownerId: owner.id as number,
						installationId: installationId as number,
						owner: text(object(r.owner).login),
						name: text(r.name),
						defaultBranch: text(r.default_branch),
					};
					const pkg = await new RepoClient(fetch, token, repo).readFile("package.json");
					if (pkg && dependsOnEmDash(pkg)) candidates.push(repo);
				}
			}
		}
	}
	return candidates;
}

function dependsOnEmDash(source: string): boolean {
	try {
		const pkg = object(JSON.parse(source));
		let found = false;
		for (const field of ["dependencies", "devDependencies"]) {
			if (!(field in pkg)) continue;
			const deps = object(pkg[field]);
			if (Object.values(deps).some((value) => typeof value !== "string" || !value.trim()))
				return false;
			if (Object.hasOwn(deps, "emdash")) found = true;
		}
		return found;
	} catch {
		return false;
	}
}

export async function installationToken(
	fetch: Fetch,
	creds: AppCredentials,
	installationId: number,
) {
	if (!Number.isSafeInteger(installationId) || installationId <= 0) invalidResponse();
	const jwt = await appJwt(creds);
	const { data } = await gh(fetch, jwt, `/app/installations/${installationId}/access_tokens`, {
		method: "POST",
	});
	return text(object(data).token);
}

/**
 * Null when the installation may change files under `.github/workflows`,
 * otherwise the App's permission settings page.
 */
export async function workflowPermissionUrl(
	fetch: Fetch,
	creds: AppCredentials,
	installationId: number,
): Promise<string | null> {
	if (!Number.isSafeInteger(installationId) || installationId <= 0) invalidResponse();
	const jwt = await appJwt(creds);
	const { data } = await gh(fetch, jwt, `/app/installations/${installationId}`);
	if (object(object(data).permissions).workflows === "write") return null;
	const { data: appData } = await gh(fetch, jwt, "/app");
	const app = object(appData);
	const slug = encodeURIComponent(text(app.slug));
	const owner = object(app.owner);
	return owner.type === "Organization"
		? `https://github.com/organizations/${encodeURIComponent(text(owner.login))}/settings/apps/${slug}/permissions`
		: `https://github.com/settings/apps/${slug}/permissions`;
}

/** New file content, or the blob `sha` of an existing version of the file. */
export type FileChange = { path: string; content: string } | { path: string; sha: string };

export class RepoClient {
	constructor(
		private fetch: Fetch,
		private token: string,
		private repo: Repo,
		private appCredentials?: AppCredentials,
	) {}

	private path(p: string) {
		return `/repos/${encodeURIComponent(text(this.repo.owner))}/${encodeURIComponent(text(this.repo.name))}${p}`;
	}

	/** Blob SHA of a file, also for files above the 1 MB content limit. */
	async fileSha(path: string, ref: string): Promise<string | null> {
		try {
			const { data } = await gh(
				this.fetch,
				this.token,
				this.path(
					`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
				),
			);
			return sha(object(data).sha);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return null;
			throw error;
		}
	}

	async readFile(path: string, ref = this.repo.defaultBranch): Promise<string | null> {
		try {
			const { data } = await gh(
				this.fetch,
				this.token,
				this.path(
					`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
				),
			);
			const res = object(data);
			if (res.encoding !== "base64" || typeof res.content !== "string") invalidResponse();
			try {
				const bin = atob(res.content.replace(/\n/g, ""));
				return new TextDecoder("utf-8", { fatal: true }).decode(
					Uint8Array.from(bin, (c) => c.charCodeAt(0)),
				);
			} catch {
				invalidResponse();
			}
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return null;
			throw error;
		}
	}

	async headSha(branch = this.repo.defaultBranch): Promise<string> {
		const { data } = await gh(
			this.fetch,
			this.token,
			this.path(`/git/ref/heads/${encodeURIComponent(text(branch))}`),
		);
		return sha(object(object(data).object).sha);
	}

	/** One commit on the default branch; fails (409/422) if the branch moved, never force-pushes. */
	async commit(
		message: string,
		files: FileChange[],
		expectedHead: string,
		deletes: string[] = [],
		beforePublish?: (commitSha: string) => Promise<void>,
	): Promise<string> {
		sha(expectedHead);
		if ((await this.headSha()) !== expectedHead) {
			throw new GitHubError(
				"The branch changed. Refresh repository state and calculate the update again.",
				409,
			);
		}
		const commitSha = await this.createCommit(message, files, expectedHead, deletes);
		await beforePublish?.(commitSha);
		await this.publishCommit(commitSha, expectedHead);
		return commitSha;
	}

	/** Creates a commit object on top of `parent` without moving any branch. */
	async createCommit(
		message: string,
		files: FileChange[],
		parent: string,
		deletes: string[] = [],
	): Promise<string> {
		const expectedHead = sha(parent);
		const { data: parentCommit } = await gh(
			this.fetch,
			this.token,
			this.path(`/git/commits/${expectedHead}`),
		);
		const baseTree = sha(object(object(parentCommit).tree).sha);
		const { data: tree } = await gh(this.fetch, this.token, this.path("/git/trees"), {
			method: "POST",
			body: JSON.stringify({
				base_tree: baseTree,
				tree: [
					...files.map((f) => ({
						path: f.path,
						mode: "100644",
						type: "blob",
						...("sha" in f ? { sha: sha(f.sha) } : { content: f.content }),
					})),
					...deletes.map((path) => ({
						path,
						mode: "100644",
						type: "blob",
						sha: null,
					})),
				],
			}),
		});
		const { data: commit } = await gh(this.fetch, this.token, this.path("/git/commits"), {
			method: "POST",
			body: JSON.stringify({
				message,
				tree: sha(object(tree).sha),
				parents: [expectedHead],
			}),
		});
		return sha(object(commit).sha);
	}

	/** Creates the branch at `commitSha`, or returns false when it already exists. */
	async createBranch(branch: string, commitSha: string): Promise<boolean> {
		try {
			await gh(this.fetch, this.token, this.path("/git/refs"), {
				method: "POST",
				body: JSON.stringify({ ref: `refs/heads/${text(branch)}`, sha: sha(commitSha) }),
			});
			return true;
		} catch (error) {
			if (error instanceof GitHubError && error.status === 422) return false;
			throw error;
		}
	}

	async deleteBranch(branch: string): Promise<void> {
		try {
			await gh(
				this.fetch,
				this.token,
				this.path(`/git/refs/heads/${text(branch).split("/").map(encodeURIComponent).join("/")}`),
				{ method: "DELETE" },
			);
		} catch (error) {
			if (!(error instanceof GitHubError && [404, 422].includes(error.status))) throw error;
		}
	}

	/** Fast-forwards a non-default branch; fails if it moved in the meantime. */
	async moveBranch(branch: string, commitSha: string): Promise<void> {
		await gh(
			this.fetch,
			this.token,
			this.path(`/git/refs/heads/${text(branch).split("/").map(encodeURIComponent).join("/")}`),
			{ method: "PATCH", body: JSON.stringify({ sha: sha(commitSha), force: false }) },
		);
	}

	async branchSha(branch: string): Promise<string | null> {
		try {
			return await this.headSha(branch);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return null;
			throw error;
		}
	}

	/** Parent and changed paths of a commit. */
	async commitInfo(commitSha: string): Promise<{ parents: string[]; files: string[] }> {
		const { data } = await gh(this.fetch, this.token, this.path(`/commits/${sha(commitSha)}`));
		const res = object(data);
		if (!Array.isArray(res.parents) || !Array.isArray(res.files)) invalidResponse();
		return {
			parents: res.parents.map((p) => sha(object(p).sha)),
			files: res.files.map((f) => text(object(f).filename)),
		};
	}

	/** Moves the default branch forward to `commitSha`; GitHub refuses anything but a fast-forward. */
	async fastForward(commitSha: string, expectedHead: string): Promise<void> {
		if ((await this.headSha()) !== sha(expectedHead))
			throw new GitHubError("The branch changed. Review setup again.", 409);
		const { data } = await gh(
			this.fetch,
			this.token,
			this.path(`/git/refs/heads/${encodeURIComponent(text(this.repo.defaultBranch))}`),
			{ method: "PATCH", body: JSON.stringify({ sha: sha(commitSha), force: false }) },
		);
		if (sha(object(object(data).object).sha) !== commitSha) invalidResponse();
	}

	async publishCommit(commitSha: string, expectedHead: string): Promise<void> {
		sha(commitSha);
		sha(expectedHead);
		const head = await this.headSha();
		if (head === commitSha) return;
		if (head !== expectedHead)
			throw new GitHubError("The branch changed. Review setup again.", 409);
		const { data } = await gh(this.fetch, this.token, this.path(`/git/commits/${commitSha}`));
		const parents = object(data).parents;
		if (!Array.isArray(parents) || parents.length !== 1 || object(parents[0]).sha !== expectedHead)
			invalidResponse();
		const { data: updated } = await gh(
			this.fetch,
			this.token,
			this.path(`/git/refs/heads/${encodeURIComponent(text(this.repo.defaultBranch))}`),
			{
				method: "PATCH",
				body: JSON.stringify({ sha: commitSha, force: false }),
			},
		);
		if (sha(object(object(updated).object).sha) !== commitSha) invalidResponse();
	}

	/**
	 * Commit statuses and deployments (Vercel, Netlify and Coolify report the
	 * former, Render the latter). Apps created before the `statuses` or
	 * `deployments` permission existed get 403; they then rely on check runs.
	 */
	async statuses(commit: string) {
		const [statuses, deployments] = await Promise.all([
			this.commitStatuses(commit),
			this.deployments(commit),
		]);
		return [...statuses, ...deployments];
	}

	private async deployments(commit: string) {
		try {
			const { data } = await gh(
				this.fetch,
				this.token,
				this.path(`/deployments?sha=${sha(commit)}&per_page=20`),
			);
			if (!Array.isArray(data)) invalidResponse();
			const results = await Promise.all(
				data.map(async (item) => {
					const d = object(item);
					const { data: list } = await gh(
						this.fetch,
						this.token,
						this.path(`/deployments/${Number(d.id)}/statuses?per_page=1`),
					);
					if (!Array.isArray(list)) invalidResponse();
					if (!list.length) return null;
					const s = object(list[0]);
					const raw = text(s.state);
					const state =
						raw === "success"
							? "success"
							: raw === "failure" || raw === "error"
								? "failure"
								: ["pending", "queued", "in_progress"].includes(raw)
									? "pending"
									: null;
					if (!state) return null;
					return {
						name: text(d.environment),
						state,
						url: httpsUrl(s.log_url ?? s.target_url),
					} as CommitStatus;
				}),
			);
			return results.filter((r): r is CommitStatus => r !== null);
		} catch (error) {
			if (error instanceof GitHubError && [403, 404].includes(error.status)) return [];
			throw error;
		}
	}

	private async commitStatuses(commit: string) {
		try {
			const { data } = await gh(
				this.fetch,
				this.token,
				this.path(`/commits/${sha(commit)}/status?per_page=100`),
			);
			const list = object(data).statuses;
			if (!Array.isArray(list)) invalidResponse();
			return list.map((item) => {
				const s = object(item);
				const raw = text(s.state);
				if (!["error", "failure", "pending", "success"].includes(raw)) invalidResponse();
				return {
					name: text(s.context),
					state: (raw === "error" ? "failure" : raw) as "pending" | "success" | "failure",
					url: httpsUrl(s.target_url),
				};
			});
		} catch (error) {
			if (error instanceof GitHubError && [403, 404].includes(error.status)) return [];
			throw error;
		}
	}

	async checks(sha: string) {
		const results: Array<{
			name: string;
			status: string;
			conclusion: string | null;
			url: string;
		}> = [];
		for await (const runs of pages(
			this.fetch,
			this.token,
			this.path(`/commits/${encodeURIComponent(sha)}/check-runs`),
			"check_runs",
		)) {
			for (const item of runs) {
				const r = object(item);
				const status = text(r.status);
				if (
					!["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(
						status,
					)
				)
					invalidResponse();
				const conclusion = r.conclusion === null ? null : text(r.conclusion);
				if (
					conclusion !== null &&
					![
						"success",
						"failure",
						"neutral",
						"cancelled",
						"skipped",
						"timed_out",
						"action_required",
						"stale",
						"startup_failure",
					].includes(conclusion)
				)
					invalidResponse();
				if ((status === "completed") !== (conclusion !== null)) invalidResponse();
				const url = text(r.details_url ?? r.html_url);
				try {
					if (new URL(url).protocol !== "https:") invalidResponse();
				} catch {
					invalidResponse();
				}
				results.push({ name: text(r.name), status, conclusion, url });
			}
		}
		return results;
	}
}

function httpsUrl(value: unknown): string | null {
	try {
		if (typeof value === "string" && new URL(value).protocol === "https:") return value;
	} catch {}
	return null;
}
