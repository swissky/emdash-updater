import type { PluginDescriptor, RouteContext } from "emdash";
import { definePlugin, PluginRouteError } from "emdash";
import { pluginResponse } from "emdash/plugin";

import { CLEANUP_MARKER, ROLLBACK_MARKER } from "../tools/markers.mjs";
import {
	convertManifestCode,
	findEmDashRepos,
	GitHubError,
	installationToken,
	RepoClient,
	workflowPermissionUrl,
} from "./github.js";
import type { AppCredentials, FileChange, Repo } from "./github.js";
import { LOCK_BRANCH, LOCKFILES, WORKFLOW, WORKFLOW_PATH } from "./lockfile.js";
import { LOGIN_PATH, LOGIN_SECRET_KEY, newLoginSecret, signLogin } from "./preview-login.js";
import { branchFor, deployState, isStalled, phaseFromChecks, previewUrlFor } from "./preview.js";
import type { PreviewUpdate } from "./preview.js";
import { bumpPackageJson, isEmDashPackage, isNewer, resolveVersions } from "./versions.js";
import type { Bump } from "./versions.js";

declare const __UPDATER_PACKAGES__: Record<string, string>;
declare const __UPDATER_PREVIEW_BUILD__: boolean;
declare const __UPDATER_PREVIEWS__: boolean;
const installed = typeof __UPDATER_PACKAGES__ === "undefined" ? {} : __UPDATER_PACKAGES__;
const previewBuild = typeof __UPDATER_PREVIEW_BUILD__ !== "undefined" && __UPDATER_PREVIEW_BUILD__;
/** Test versions with copied content and content restore need Cloudflare Workers Builds and D1. */
const previews = typeof __UPDATER_PREVIEWS__ === "undefined" || __UPDATER_PREVIEWS__;

const ID = "emdash-updater";
const VERSION = "1.1.1";
const ALLOWED_HOSTS = ["api.github.com", "registry.npmjs.org"];
const STATE_TTL_MS = 10 * 60 * 1000;
const ADMIN_PAGE = `/_emdash/admin/plugins/${ID}/`;
const settingsSchema = {
	appId: { type: "string" as const, label: "GitHub App ID (managed automatically)" },
	appSlug: { type: "string" as const, label: "GitHub App slug (managed automatically)" },
	privateKey: {
		type: "secret" as const,
		label: "GitHub App private key (managed automatically)",
	},
};
const pages = [{ path: "/", label: "Updates", icon: "arrow-clockwise" }];

export function updaterPlugin(): PluginDescriptor {
	return {
		id: ID,
		version: VERSION,
		format: "native",
		entrypoint: "emdash-updater",
		adminEntry: "emdash-updater/admin",
		capabilities: ["network:request"],
		allowedHosts: ALLOWED_HOSTS,
		adminPages: pages,
		settingsSchema,
	};
}

type Ctx = RouteContext<unknown>;
/** D1 Time Travel keeps 7 days on the Free plan; older restores are not offered. */
const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const CLEANUP_GIVE_UP_MS = 30 * 60_000;
interface LastUpdate {
	id: string;
	bumps: Bump[];
	finishedAt: string;
	repo?: Repo;
	baseSha?: string;
	appliedSha?: string;
	before?: string;
	lockfile?: string;
	undone?: { at: string; withDatabase: boolean };
}
interface Cleanup {
	repo: Repo;
	branch: string;
	commitSha: string;
	startedAt: string;
}
interface Plan {
	id: string;
	repo: Repo;
	baseSha: string;
	content: string;
	bumps: Bump[];
	createdAt: string;
}

function input(ctx: Ctx): Record<string, unknown> {
	if (!ctx.input || typeof ctx.input !== "object" || Array.isArray(ctx.input))
		throw PluginRouteError.badRequest("Invalid request body");
	return ctx.input as Record<string, unknown>;
}
function fetcher(ctx: Ctx) {
	const http = ctx.http;
	if (!http) throw PluginRouteError.badRequest("Network access is unavailable");
	return (url: string, init?: RequestInit) => http.fetch(url, init);
}
async function credentials(ctx: Ctx): Promise<AppCredentials | null> {
	const appId = await ctx.settings.get<string>("appId");
	const pem = await ctx.settings.get<string>("privateKey");
	return appId && pem ? { appId, pem } : null;
}
async function clientFor(ctx: Ctx, repo: Repo): Promise<RepoClient> {
	const creds = await credentials(ctx);
	if (!creds) throw PluginRouteError.badRequest("GitHub is not connected");
	// A reconnect creates a new installation; records saved before it keep the old id.
	const selected = await ctx.kv.get<Repo>("selectedRepo");
	const installationId =
		selected?.owner === repo.owner && selected.name === repo.name
			? selected.installationId
			: repo.installationId;
	return new RepoClient(
		fetcher(ctx),
		await installationToken(fetcher(ctx), creds, installationId),
		repo,
		creds,
	);
}
async function assertIdle(ctx: Ctx) {
	const update = await ctx.kv.get<PreviewUpdate>("update");
	if (update && update.phase !== "applied")
		throw PluginRouteError.badRequest(
			"An update is waiting for your decision. Apply or discard it first.",
		);
	if (await ctx.kv.get("cleanup"))
		throw PluginRouteError.badRequest(
			"The test copies of the last update are still being deleted. Try again in a few minutes.",
		);
}
function redirect(location: string) {
	return pluginResponse({
		status: 302,
		headers: { Location: location, "Content-Type": "text/plain" },
		body: { kind: "text", value: "" },
	});
}
interface ConnectionState {
	state: string;
	expires: number;
	phase: "ready" | "exchanging";
}
function manifestFor(origin: string) {
	return {
		name:
			`EmDash ${new URL(origin).hostname.split(".")[0]}`.slice(0, 24) +
			` ${crypto.randomUUID().slice(0, 8)}`,
		url: origin,
		redirect_url: `${origin}/_emdash/api/plugins/${ID}/connect/callback`,
		setup_url: `${origin}${ADMIN_PAGE}`,
		setup_on_update: true,
		public: false,
		default_permissions: {
			contents: "write",
			workflows: "write",
			checks: "read",
			statuses: "read",
			deployments: "read",
			metadata: "read",
		},
		default_events: [],
	};
}

function sameVersions(bumps: Bump[]): boolean {
	return bumps.every((b) => installed[b.name] === b.to);
}
async function versionStatus(ctx: Ctx) {
	const cacheKey = `versions:v2:${JSON.stringify(installed)}`;
	const cached = await ctx.kv.get<{
		checkedAt: string;
		latest: Record<string, string>;
		eligible: Record<string, string>;
	}>(cacheKey);
	try {
		let versions = cached;
		if (!versions || Date.now() - Date.parse(versions.checkedAt) > 5 * 60_000) {
			const names = Object.keys(installed);
			if (!names.length) throw PluginRouteError.badRequest("Build version metadata is missing.");
			const [latest, eligible] = await Promise.all([
				resolveVersions(fetcher(ctx), names, 0),
				resolveVersions(fetcher(ctx), names, undefined, installed),
			]);
			versions = { checkedAt: new Date().toISOString(), latest, eligible };
			await ctx.kv.set(cacheKey, versions);
		}
		return {
			packages: Object.entries(installed).map(([name, version]) => ({
				name,
				installed: version,
				latest: versions.latest[name] ?? null,
				eligible:
					versions.eligible[name]?.split(".")[0] === version.split(".")[0]
						? versions.eligible[name]
						: null,
			})),
			checkedAt: versions.checkedAt,
			minimumReleaseAgeHours: 24,
		};
	} catch (error) {
		return {
			packages: Object.entries(installed).map(([name, version]) => ({
				name,
				installed: version,
				latest: cached?.latest[name] ?? null,
				eligible:
					cached?.eligible[name]?.split(".")[0] === version.split(".")[0]
						? (cached?.eligible[name] ?? null)
						: null,
			})),
			minimumReleaseAgeHours: 24,
			versionsError: error instanceof Error ? error.message : "Version check failed",
		};
	}
}

async function planFor(ctx: Ctx, client: RepoClient, repo: Repo): Promise<Plan | null> {
	const baseSha = await client.headSha();
	const pkg = await client.readFile("package.json", baseSha);
	if (!pkg)
		throw PluginRouteError.badRequest("package.json is missing from the selected repository.");
	const parsed = JSON.parse(pkg);
	const current = { ...parsed.dependencies, ...parsed.devDependencies };
	const names = Object.keys(current).filter(isEmDashPackage);
	if (!names.includes("emdash"))
		throw PluginRouteError.badRequest(
			"This repository does not declare EmDash as a direct dependency.",
		);
	// The repository must describe the running site, or the update lands somewhere else.
	const behind = names.find((name) => {
		const running = installed[name];
		const range = String(current[name]);
		const declared = range.replace(/^[\^~]/, "");
		if (!running) return false;
		if (range === declared) return running !== declared;
		return isNewer(declared, running) || running.split(".")[0] !== declared.split(".")[0];
	});
	if (behind)
		throw PluginRouteError.badRequest(
			`This repository does not match your site: it declares ${behind} ${current[behind]}, your site runs ${installed[behind]}. Choose the repository this site is built from. If you just changed the version, wait until your hosting has published it and refresh.`,
		);
	const { content, bumps } = bumpPackageJson(
		pkg,
		await resolveVersions(fetcher(ctx), names, undefined, current),
	);
	if (!bumps.length) return null;
	const plan = {
		id: crypto.randomUUID(),
		repo,
		baseSha,
		content,
		bumps,
		createdAt: new Date().toISOString(),
	};
	await ctx.kv.set(`plan:${ctx.user?.id}`, plan);
	return plan;
}

/** Refreshes the saved update from GitHub; records success once the live site runs the new versions. */
async function refreshUpdate(ctx: Ctx, update: PreviewUpdate): Promise<PreviewUpdate> {
	if (update.phase === "locking") return refreshLock(ctx, update);
	if (update.phase === "applied" || update.direct) {
		if (!sameVersions(update.bumps) && update.direct && update.phase === "applied") {
			const client = await clientFor(ctx, update.repo);
			const [checks, statuses] = await Promise.all([
				client.checks(update.commitSha),
				client.statuses(update.commitSha),
			]);
			const deploy = deployState(checks, statuses);
			if (deploy.state === "failed") {
				const failed = { ...update, phase: "failed" as const, buildUrl: deploy.url };
				await ctx.kv.set("update", failed);
				return failed;
			}
		}
		if (sameVersions(update.bumps)) {
			const last: LastUpdate = {
				id: update.id,
				bumps: update.bumps,
				finishedAt: new Date().toISOString(),
				repo: update.repo,
				baseSha: update.baseSha,
				appliedSha: update.commitSha,
				before: update.before ?? update.appliedAt,
				lockfile: update.lockfile,
			};
			await ctx.kv.set("lastUpdate", last);
			await ctx.kv.delete("update");
		}
		return update;
	}
	const client = await clientFor(ctx, update.repo);
	const next = { ...update, ...phaseFromChecks(update, await client.checks(update.commitSha)) };
	if (next.phase !== update.phase || next.buildUrl !== update.buildUrl)
		await ctx.kv.set("update", next);
	return next;
}

/** package.json, and the lockfile when the update changed it, as they were before the update. */
async function previousFiles(client: RepoClient, ref: string, lockfile?: string) {
	const paths = lockfile ? ["package.json", lockfile] : ["package.json"];
	return Promise.all(
		paths.map(async (path) => {
			const blob = await client.fileSha(path, ref);
			if (blob === null)
				throw PluginRouteError.badRequest(`The previous ${path} could not be read.`);
			return { path, sha: blob };
		}),
	);
}

/** Later commits are fine as long as they left package.json and the lockfile as the update wrote them. */
async function sameDependencies(client: RepoClient, last: LastUpdate, head: string) {
	const paths = last.lockfile ? ["package.json", last.lockfile] : ["package.json"];
	const blobs = await Promise.all(
		paths.flatMap((path) => [client.fileSha(path, last.appliedSha!), client.fileSha(path, head)]),
	);
	return paths.every((_, i) => blobs[2 * i] !== null && blobs[2 * i] === blobs[2 * i + 1]);
}

async function findLockfile(client: RepoClient, ref: string): Promise<string | undefined> {
	const names = Object.keys(LOCKFILES);
	const found = await Promise.all(names.map((name) => client.fileSha(name, ref)));
	return names[found.findIndex((blob) => blob !== null)];
}

/**
 * Commits the update to its own branch together with the lockfile workflow;
 * `refreshLock` publishes it once the workflow has committed the lockfile.
 */
async function startLocked(ctx: Ctx, client: RepoClient, plan: Plan, lockfile: string) {
	const summary = plan.bumps.map((b) => `${b.name} ${b.from} → ${b.to}`).join(", ");
	const files: FileChange[] = [{ path: "package.json", content: plan.content }];
	if ((await client.readFile(WORKFLOW_PATH, plan.baseSha)) !== WORKFLOW)
		files.push({ path: WORKFLOW_PATH, content: WORKFLOW });
	const commitSha = await client.createCommit(`Update EmDash: ${summary}`, files, plan.baseSha);
	await client.deleteBranch(LOCK_BRANCH);
	let created: boolean;
	try {
		created = await client.createBranch(LOCK_BRANCH, commitSha);
	} catch (error) {
		if (error instanceof GitHubError && (error.status === 403 || error.status === 404))
			throw PluginRouteError.badRequest(
				"Your repository has a lockfile, so the updater adds a GitHub Actions workflow that updates it. The GitHub App may not change workflows yet: in the App's GitHub settings, under Permissions, set Workflows to Read and write, then accept the new permission for your installation and try again.",
			);
		throw error;
	}
	if (!created) throw PluginRouteError.conflict("Could not prepare the update. Try again.");
	const now = new Date().toISOString();
	const update: PreviewUpdate = {
		id: plan.id,
		repo: plan.repo,
		baseSha: plan.baseSha,
		commitSha,
		branch: LOCK_BRANCH,
		bumps: plan.bumps,
		liveHost: new URL(ctx.request.url).hostname,
		startedAt: now,
		before: now,
		phase: "locking",
		direct: true,
		lockfile,
	};
	if (!(await ctx.kv.compareAndSet("update", null, update)).applied) {
		await client.deleteBranch(LOCK_BRANCH);
		throw PluginRouteError.conflict("Another update was started at the same time.");
	}
	await ctx.kv.delete(`plan:${ctx.user?.id}`);
	return { ok: true };
}

/**
 * Publishes the update once the workflow has added exactly one commit on top of
 * it that only touches the lockfile.
 */
async function refreshLock(ctx: Ctx, update: PreviewUpdate): Promise<PreviewUpdate> {
	const client = await clientFor(ctx, update.repo);
	const head = await client.branchSha(LOCK_BRANCH);
	const fail = async (buildUrl?: string) => {
		const failed = { ...update, phase: "failed" as const, buildUrl };
		await ctx.kv.set("update", failed);
		return failed;
	};
	if (!head) return fail();
	if (head === update.commitSha) {
		const deploy = deployState(await client.checks(update.commitSha), []);
		return deploy.state === "failed" ? fail(deploy.url) : update;
	}
	const info = await client.commitInfo(head);
	if (
		info.parents.length !== 1 ||
		info.parents[0] !== update.commitSha ||
		info.files.some((file) => file !== update.lockfile)
	)
		return fail();
	await client.fastForward(head, update.baseSha);
	const applied = {
		...update,
		commitSha: head,
		phase: "applied" as const,
		appliedAt: new Date().toISOString(),
	};
	await ctx.kv.set("update", applied);
	await client.deleteBranch(LOCK_BRANCH);
	return applied;
}

/**
 * After a decision the update branch gets one more commit. Its preview build
 * deletes the test copies of the live content instead of deploying. Once that
 * build has run, the branch and with it the preview are removed.
 */
async function startCleanup(ctx: Ctx, client: RepoClient, update: PreviewUpdate) {
	try {
		await commitCleanup(ctx, client, update);
	} catch (error) {
		// The decision already happened; never fail it over the cleanup.
		console.error("[emdash-updater] Could not start deleting the test copies:", error);
		await client.deleteBranch(update.branch);
	}
}

async function commitCleanup(ctx: Ctx, client: RepoClient, update: PreviewUpdate) {
	const head = await client.branchSha(update.branch);
	if (!head) return;
	const commitSha = await client.createCommit(
		"Remove the test copies of the live content",
		[{ path: CLEANUP_MARKER, content: `${update.id}\n` }],
		head,
	);
	await client.moveBranch(update.branch, commitSha);
	const cleanup: Cleanup = {
		repo: update.repo,
		branch: update.branch,
		commitSha,
		startedAt: new Date().toISOString(),
	};
	await ctx.kv.set("cleanup", cleanup);
}

/** Returns true while the test copies are still being deleted. */
async function finishCleanup(ctx: Ctx): Promise<boolean> {
	const cleanup = await ctx.kv.get<Cleanup>("cleanup");
	if (!cleanup) return false;
	const client = await clientFor(ctx, cleanup.repo);
	const build = (await client.checks(cleanup.commitSha)).find((c) =>
		c.name.startsWith("Workers Builds"),
	);
	const givenUp = Date.now() - Date.parse(cleanup.startedAt) > CLEANUP_GIVE_UP_MS;
	if (build?.status !== "completed" && !givenUp) return true;
	await client.deleteBranch(cleanup.branch);
	await ctx.kv.delete("cleanup");
	return false;
}

/** A direct update whose deploy failed: put the previous package.json back on the live branch. */
async function revertDirect(ctx: Ctx, update: PreviewUpdate) {
	const client = await clientFor(ctx, update.repo);
	if (update.phase === "locking" || update.branch === LOCK_BRANCH && update.phase === "failed") {
		await client.deleteBranch(LOCK_BRANCH);
		return;
	}
	const head = await client.headSha();
	if (head !== update.commitSha)
		throw PluginRouteError.badRequest(
			"Your site's code changed after the update. Fix the version in package.json by hand.",
		);
	const summary = update.bumps.map((b) => `${b.name} ${b.to} → ${b.from}`).join(", ");
	await client.commit(
		`Revert failed EmDash update: ${summary}`,
		await previousFiles(client, update.baseSha, update.lockfile),
		head,
	);
}

export function createPlugin() {
	const plugin = definePlugin({
		id: ID,
		version: VERSION,
		capabilities: ["network:request"],
		allowedHosts: ALLOWED_HOSTS,
		admin: { pages, settingsSchema },
		routes: {
			status: {
				methods: ["POST"],
				handler: async (ctx) => {
					const appSlug = await ctx.settings.get<string>("appSlug");
					const creds = await credentials(ctx);
					const repo = await ctx.kv.get<Repo>("selectedRepo");
					const base = {
						...(await versionStatus(ctx)),
						connected: Boolean(creds),
						installUrl: appSlug
							? `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`
							: null,
						repo,
						lastUpdate: await ctx.kv.get("lastUpdate"),
						restoreWindowMs: previews ? RESTORE_WINDOW_MS : 0,
						previews,
					};
					if (previewBuild) return { ...base, preview: true };
					if (!creds) return base;
					try {
						Object.assign(base, { cleaning: await finishCleanup(ctx) });
						const saved = await ctx.kv.get<PreviewUpdate>("update");
						if (saved) {
							const update = await refreshUpdate(ctx, saved);
							const current = await ctx.kv.get<PreviewUpdate>("update");
							return {
								...base,
								update: current,
								lastUpdate: current ? base.lastUpdate : await ctx.kv.get("lastUpdate"),
								previewUrl: previewUrlFor(update.branch, update.liveHost),
							};
						}
						if (!repo) return { ...base, choices: await findEmDashRepos(fetcher(ctx), creds) };
						const client = await clientFor(ctx, repo);
						const plan = await planFor(ctx, client, repo);
						const workflowPermission =
							plan && !previews && (await findLockfile(client, plan.baseSha))
								? await workflowPermissionUrl(fetcher(ctx), creds, repo.installationId)
								: null;
						return { ...base, plan, checked: true, workflowPermission };
					} catch (error) {
						return {
							...base,
							error: error instanceof Error ? error.message : "Could not check update status",
						};
					}
				},
			},
			"connect/start": {
				methods: ["POST"],
				handler: async (ctx) => {
					await assertIdle(ctx);
					if (!ctx.user) throw PluginRouteError.badRequest("Sign in to connect GitHub.");
					if (await credentials(ctx))
						throw PluginRouteError.badRequest(
							"An App is already connected. Change its repository instead.",
						);
					const { org } = input(ctx);
					if (org !== undefined && (typeof org !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(org)))
						throw PluginRouteError.badRequest("Invalid organization name");
					const state = crypto.randomUUID();
					await ctx.kv.set(`connection:${ctx.user.id}`, {
						state,
						expires: Date.now() + STATE_TTL_MS,
						phase: "ready",
					});
					const base = org
						? `https://github.com/organizations/${org}/settings/apps/new`
						: "https://github.com/settings/apps/new";
					return {
						action: `${base}?state=${state}`,
						manifest: JSON.stringify(manifestFor(ctx.site.url || new URL(ctx.request.url).origin)),
					};
				},
			},
			"connect/callback": {
				public: true,
				methods: ["GET"],
				response: "raw",
				handler: async (ctx) => {
					const query = new URL(ctx.request.url).searchParams;
					const code = query.get("code");
					const state = query.get("state");
					if (
						!code ||
						!/^[a-zA-Z0-9]{1,256}$/.test(code) ||
						!state ||
						!/^[a-f0-9-]{36}$/.test(state)
					)
						return redirect(`${ADMIN_PAGE}?error=state`);
					return redirect(`${ADMIN_PAGE}?${new URLSearchParams({ code, state })}`);
				},
			},
			"connect/finish": {
				methods: ["POST"],
				handler: async (ctx) => {
					await assertIdle(ctx);
					if (!ctx.user)
						throw PluginRouteError.badRequest(
							"Sign in with the account that started this connection.",
						);
					if (await credentials(ctx))
						throw PluginRouteError.conflict(
							"A GitHub App is already connected. Refresh before continuing.",
						);
					const { code, state } = input(ctx);
					const key = `connection:${ctx.user.id}`;
					const saved = await ctx.kv.getVersioned<ConnectionState>(key);
					if (
						typeof code !== "string" ||
						!/^[a-zA-Z0-9]{1,256}$/.test(code) ||
						!saved ||
						saved.value.state !== state ||
						saved.value.expires < Date.now() ||
						saved.value.phase !== "ready"
					)
						throw PluginRouteError.badRequest("Connection expired or already used. Start again.");
					if (
						!(
							await ctx.kv.compareAndSet(key, saved.revision, {
								...saved.value,
								phase: "exchanging",
							})
						).applied
					)
						throw PluginRouteError.badRequest("Connection is already being completed.");
					const app = await convertManifestCode(fetcher(ctx), code);
					await ctx.settings.set("privateKey", app.pem);
					await ctx.settings.set("appSlug", app.slug);
					await ctx.settings.set("appId", String(app.id));
					await ctx.kv.delete(key);
					return {
						installUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
					};
				},
			},
			"select-repo": {
				methods: ["POST"],
				handler: async (ctx) => {
					await assertIdle(ctx);
					const { owner, name } = input(ctx);
					if (typeof owner !== "string" || typeof name !== "string")
						throw PluginRouteError.badRequest("Select a repository.");
					const creds = await credentials(ctx);
					if (!creds) throw PluginRouteError.badRequest("GitHub is not connected");
					const repo = (await findEmDashRepos(fetcher(ctx), creds)).find(
						(r) => r.owner === owner && r.name === name,
					);
					if (!repo)
						throw PluginRouteError.badRequest("Repository not available to this GitHub App");
					const previous = await ctx.kv.get<Repo>("selectedRepo");
					if (JSON.stringify(previous) !== JSON.stringify(repo)) {
					}
					await ctx.kv.set("selectedRepo", repo);
					return { ok: true };
				},
			},
			"change-repo": {
				methods: ["POST"],
				handler: async (ctx) => {
					await assertIdle(ctx);
					await ctx.kv.delete("selectedRepo");
					return { ok: true };
				},
			},
			disconnect: {
				methods: ["POST"],
				handler: async (ctx) => {
					await assertIdle(ctx);
					for (const key of ["appId", "appSlug", "privateKey"]) await ctx.settings.delete(key);
					for (const key of ["selectedRepo", "siteRepo", "repo", "manifestState"])
						await ctx.kv.delete(key);
					return { ok: true };
				},
			},
			"update/start": {
				methods: ["POST"],
				handler: async (ctx) => {
					await assertIdle(ctx);
					const { planId } = input(ctx);
					const plan = await ctx.kv.get<Plan>(`plan:${ctx.user?.id}`);
					if (!plan || plan.id !== planId || Date.now() - Date.parse(plan.createdAt) > STATE_TTL_MS)
						throw PluginRouteError.badRequest("The update plan expired. Refresh and try again.");
					const client = await clientFor(ctx, plan.repo);
					if ((await client.headSha()) !== plan.baseSha)
						throw PluginRouteError.badRequest(
							"Your site's code changed in the meantime. Refresh and try again.",
						);
					if (!previews) {
						const lockfile = await findLockfile(client, plan.baseSha);
						if (lockfile) return startLocked(ctx, client, plan, lockfile);
						const before = new Date().toISOString();
						const summary = plan.bumps.map((b) => `${b.name} ${b.from} → ${b.to}`).join(", ");
						let commitSha: string;
						try {
							commitSha = await client.commit(
								`Update EmDash: ${summary}`,
								[{ path: "package.json", content: plan.content }],
								plan.baseSha,
							);
						} catch (error) {
							if (error instanceof GitHubError && error.status === 409)
								throw PluginRouteError.badRequest(
									"Your site's code changed in the meantime. Refresh and try again.",
								);
							throw error;
						}
						const update: PreviewUpdate = {
							id: plan.id,
							repo: plan.repo,
							baseSha: plan.baseSha,
							commitSha,
							branch: plan.repo.defaultBranch,
							bumps: plan.bumps,
							liveHost: new URL(ctx.request.url).hostname,
							startedAt: before,
							before,
							appliedAt: new Date().toISOString(),
							phase: "applied",
							direct: true,
						};
						await ctx.kv.set("update", update);
						await ctx.kv.delete(`plan:${ctx.user?.id}`);
						return { ok: true };
					}
					// Written before the branch exists so the preview build copies it.
					await ctx.kv.set(LOGIN_SECRET_KEY, newLoginSecret());
					const branch = branchFor(plan.bumps);
					const summary = plan.bumps.map((b) => `${b.name} ${b.from} → ${b.to}`).join(", ");
					const leftover = (await client.readFile(ROLLBACK_MARKER, plan.baseSha)) !== null;
					const commitSha = await client.createCommit(
						`Update EmDash: ${summary}`,
						[{ path: "package.json", content: plan.content }],
						plan.baseSha,
						leftover ? [ROLLBACK_MARKER] : [],
					);
					// A leftover branch from an earlier, discarded attempt is replaced.
					if (!(await client.createBranch(branch, commitSha))) {
						await client.deleteBranch(branch);
						if (!(await client.createBranch(branch, commitSha)))
							throw PluginRouteError.conflict("Could not prepare the test version. Try again.");
					}
					const update: PreviewUpdate = {
						id: plan.id,
						repo: plan.repo,
						baseSha: plan.baseSha,
						commitSha,
						branch,
						bumps: plan.bumps,
						liveHost: new URL(ctx.request.url).hostname,
						startedAt: new Date().toISOString(),
						phase: "building",
					};
					if (!(await ctx.kv.compareAndSet("update", null, update)).applied) {
						await client.deleteBranch(branch);
						throw PluginRouteError.conflict("Another update was started at the same time.");
					}
					await ctx.kv.delete(`plan:${ctx.user?.id}`);
					return { ok: true };
				},
			},
			"update/open": {
				methods: ["POST"],
				handler: async (ctx) => {
					const { updateId } = input(ctx);
					const update = await ctx.kv.get<PreviewUpdate>("update");
					if (!update || update.id !== updateId || update.phase !== "ready")
						throw PluginRouteError.badRequest("The test version is not ready.");
					const previewUrl = previewUrlFor(update.branch, update.liveHost);
					const secret = await ctx.kv.get<string>(LOGIN_SECRET_KEY);
					if (!previewUrl || !secret || !ctx.user) return { url: update.buildUrl ?? null };
					const url = new URL(LOGIN_PATH, previewUrl);
					url.searchParams.set("token", await signLogin(secret, ctx.user.id));
					return { url: url.href };
				},
			},
			"update/apply": {
				methods: ["POST"],
				handler: async (ctx) => {
					const { updateId } = input(ctx);
					const saved = await ctx.kv.getVersioned<PreviewUpdate>("update");
					if (!saved || saved.value.id !== updateId || saved.value.phase !== "ready")
						throw PluginRouteError.badRequest("Only a finished test version can be applied.");
					const update = saved.value;
					const client = await clientFor(ctx, update.repo);
					if ((await client.branchSha(update.branch)) !== update.commitSha)
						throw PluginRouteError.badRequest(
							"The test version changed. Discard it and start again.",
						);
					const before = new Date().toISOString();
					try {
						await client.publishCommit(update.commitSha, update.baseSha);
					} catch (error) {
						if (error instanceof GitHubError && error.status === 409)
							throw PluginRouteError.badRequest(
								"Your site's code changed since the test started. Discard this test and start again.",
							);
						throw error;
					}
					const applied = {
						...update,
						phase: "applied" as const,
						before,
						appliedAt: new Date().toISOString(),
					};
					await ctx.kv.compareAndSet("update", saved.revision, applied);
					await startCleanup(ctx, client, update);
					return { ok: true };
				},
			},
			"update/undo": {
				methods: ["POST"],
				handler: async (ctx) => {
					await assertIdle(ctx);
					if (await ctx.kv.get("update"))
						throw PluginRouteError.badRequest("Wait until the update is fully installed.");
					const { id, withDatabase } = input(ctx);
					const saved = await ctx.kv.getVersioned<LastUpdate>("lastUpdate");
					const last = saved?.value;
					if (
						!saved ||
						!last?.repo ||
						!last.baseSha ||
						!last.appliedSha ||
						last.id !== id ||
						last.undone
					)
						throw PluginRouteError.badRequest("This update can no longer be undone here.");
					const restore = withDatabase === true;
					if (restore && !previews)
						throw PluginRouteError.badRequest(
							"Resetting the content is only available on Cloudflare D1. Undo only the code instead.",
						);
					if (restore && (!last.before || Date.now() - Date.parse(last.before) > RESTORE_WINDOW_MS))
						throw PluginRouteError.badRequest(
							"The content can only be reset within 7 days of the update. Undo only the code instead.",
						);
					const client = await clientFor(ctx, last.repo);
					const head = await client.headSha();
					if (head !== last.appliedSha && !(await sameDependencies(client, last, head)))
						throw PluginRouteError.badRequest(
							"Your site's dependencies changed after the update, so it cannot be undone automatically.",
						);
					const files = await previousFiles(client, last.baseSha, last.lockfile);
					if (restore)
						files.push({
							path: ROLLBACK_MARKER,
							content: `${JSON.stringify({
								id: last.id,
								before: last.before,
								bumps: last.bumps,
								finishedAt: last.finishedAt,
							})}\n`,
						});
					const summary = last.bumps.map((b) => `${b.name} ${b.to} → ${b.from}`).join(", ");
					// commit() refuses if the branch moved, so a second click cannot undo twice.
					await client.commit(`Undo EmDash update: ${summary}`, files, head);
					const undone = { at: new Date().toISOString(), withDatabase: restore };
					await ctx.kv.compareAndSet("lastUpdate", saved.revision, { ...last, undone });
					return { ok: true };
				},
			},
			"update/discard": {
				methods: ["POST"],
				handler: async (ctx) => {
					const { updateId } = input(ctx);
					const saved = await ctx.kv.getVersioned<PreviewUpdate>("update");
					if (
						!saved ||
						saved.value.id !== updateId ||
						(saved.value.phase === "applied" && !isStalled(saved.value))
					)
						throw PluginRouteError.badRequest("This update can no longer be discarded.");
					if (saved.value.direct) {
						await revertDirect(ctx, saved.value);
						await ctx.kv.compareAndDelete("update", saved.revision);
						return { ok: true };
					}
					await startCleanup(ctx, await clientFor(ctx, saved.value.repo), saved.value);
					if (!(await ctx.kv.compareAndDelete("update", saved.revision)).applied)
						throw PluginRouteError.conflict("The update changed. Refresh the page.");
					return { ok: true };
				},
			},
		},
	});
	for (const [name, route] of Object.entries(plugin.routes ?? {})) {
		const handler = route.handler;
		route.handler = async (ctx) => {
			try {
				if (previewBuild && name !== "status")
					throw PluginRouteError.badRequest(
						"This is the test version of your site. Apply or discard the update on your live site.",
					);
				return await handler(ctx);
			} catch (error) {
				if (error instanceof GitHubError)
					throw new PluginRouteError("GITHUB_ERROR", error.message, error.status);
				throw error;
			}
		};
	}
	return plugin;
}

export default createPlugin;
