import type { Repo } from "./github.js";
import type { Bump } from "./versions.js";

export const BRANCH_PREFIX = "emdash-update-";
export const NO_BUILD_AFTER_MS = 5 * 60_000;
/** Without a build result from the hosting, a direct update counts as stuck after this. */
export const STALLED_AFTER_MS = 15 * 60_000;

export function isStalled(update: PreviewUpdate, now = Date.now()): boolean {
	return Boolean(
		update.direct &&
			(update.phase === "applied" || update.phase === "locking") &&
			now - Date.parse(update.appliedAt ?? update.startedAt) > STALLED_AFTER_MS,
	);
}

export interface PreviewUpdate {
	id: string;
	repo: Repo;
	baseSha: string;
	commitSha: string;
	branch: string;
	bumps: Bump[];
	liveHost: string;
	startedAt: string;
	phase: "building" | "ready" | "failed" | "no-build" | "applied" | "locking";
	buildUrl?: string;
	appliedAt?: string;
	/** Moment just before the live code moved; the database can be restored to it. */
	before?: string;
	/** Committed straight to the live branch, without a test version. */
	direct?: boolean;
	/** Set while the update waits on its own branch for the lockfile workflow. */
	lockfile?: string;
}

/** Branch names double as Cloudflare preview aliases, so they stay DNS-safe. */
export function branchFor(bumps: Bump[]): string {
	const target = bumps.find((b) => b.name === "emdash")?.to ?? bumps[0]?.to ?? "latest";
	return `${BRANCH_PREFIX}${target.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

/**
 * Cloudflare serves a branch preview at `<branch>-<worker>.<subdomain>.workers.dev`.
 * Only derivable when the live site itself runs on workers.dev; otherwise the
 * build page (which lists the Preview URL) is the fallback.
 */
export function previewUrlFor(branch: string, liveHost: string): string | null {
	if (!/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(liveHost)) return null;
	const [worker] = liveHost.split(".");
	if (`${branch}-${worker}`.length > 63) return null;
	return `https://${branch}-${liveHost}`;
}

type Check = { name: string; status: string; conclusion: string | null; url: string };

/** Maps the Workers Builds check run on the update commit to a phase. */
export function phaseFromChecks(
	update: PreviewUpdate,
	checks: Check[],
	now = Date.now(),
): Pick<PreviewUpdate, "phase" | "buildUrl"> {
	const build = checks.find((c) => c.name.startsWith("Workers Builds"));
	if (!build)
		return {
			phase: now - Date.parse(update.startedAt) > NO_BUILD_AFTER_MS ? "no-build" : "building",
		};
	if (build.status !== "completed") return { phase: "building", buildUrl: build.url };
	return { phase: build.conclusion === "success" ? "ready" : "failed", buildUrl: build.url };
}

export type CommitStatus = { name: string; state: "pending" | "success" | "failure"; url: string | null };

const BAD = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);

/**
 * What the hosting reported for a commit on the live branch. Vercel, Netlify,
 * Render, Coolify and GitHub Actions report as check runs or commit statuses.
 */
export function deployState(
	checks: Check[],
	statuses: CommitStatus[],
): { state: "none" | "pending" | "success" | "failed"; url?: string } {
	const failed =
		checks.find((c) => c.conclusion && BAD.has(c.conclusion)) ??
		statuses.find((s) => s.state === "failure");
	if (failed) return { state: "failed", url: failed.url ?? undefined };
	const pending = checks.find((c) => c.status !== "completed") ?? statuses.find((s) => s.state === "pending");
	if (pending) return { state: "pending", url: pending.url ?? undefined };
	return { state: checks.length || statuses.length ? "success" : "none" };
}
