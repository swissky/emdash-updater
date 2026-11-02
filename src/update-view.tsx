import { Badge, Button, Dialog, LinkButton, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import * as React from "react";

import { LOCK_BRANCH } from "./lockfile.js";
import { isStalled } from "./preview.js";
import type { PreviewUpdate } from "./preview.js";
import type { Bump } from "./versions.js";

interface Props {
	status: {
		connected: boolean;
		preview?: boolean;
		previews?: boolean;
		repo?: { owner: string; name: string } | null;
		plan?: { id: string; bumps: Bump[] } | null;
		checked?: boolean;
		error?: string;
		versionsError?: string;
		update?: PreviewUpdate | null;
		previewUrl?: string | null;
		workflowPermission?: string | null;
	};
	busy: boolean;
	onStart: () => void;
	onOpen: () => void;
	onApply: () => void;
	onDiscard: () => void;
}

function safeUrl(value: string | null | undefined, hosts: RegExp): string | null {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" && hosts.test(url.hostname) ? url.href : null;
	} catch {
		return null;
	}
}

function Bumps({ bumps }: { bumps: Bump[] }) {
	return (
		<ul className="space-y-1 text-sm">
			{bumps.map((bump) => (
				<li key={bump.name}>
					<code>{bump.name}</code>: {bump.from} → <strong>{bump.to}</strong>
				</li>
			))}
		</ul>
	);
}

const BACKUP_URL = "/_emdash/api/settings/backups/export";

export function UpdateView({ status, busy, onStart, onOpen, onApply, onDiscard }: Props) {
	const { i18n } = useLingui();
	const [confirm, setConfirm] = React.useState<"apply" | "discard" | "start" | null>(null);
	const update = status.update;
	const direct = status.previews === false;
	const previewUrl = safeUrl(status.previewUrl, /\.workers\.dev$/);
	const buildUrl = safeUrl(update?.buildUrl, update?.direct ? /./ : /^dash\.cloudflare\.com$/);
	const t = (id: string, message: string) => i18n._({ id, message });

	if (status.preview)
		return (
			<section className="space-y-2 rounded-lg border border-kumo-line p-4">
				<h2 className="text-lg font-medium">{t("updater.previewTitle", "This is the test version")}</h2>
				<p className="text-sm">
					{t(
						"updater.previewHelp",
						"You are looking at a copy of your site with the new EmDash version. Changes made here do not reach your live site and are lost when the update is applied or discarded. Go back to your live site's admin to decide.",
					)}
				</p>
			</section>
		);

	let body: React.ReactNode;
	const locking = update?.direct && update.branch === LOCK_BRANCH;
	if (locking && (update.phase === "failed" || isStalled(update))) {
		body = (
			<>
				<Bumps bumps={update.bumps} />
				<p role="alert" className="text-sm text-kumo-danger">
					{t(
						"updater.lockFailed",
						"The lockfile could not be updated, so your live site was not changed. Open the GitHub Actions run to see why, then discard this update.",
					)}
				</p>
				<div className="flex flex-wrap gap-2">
					<LinkButton
						variant="secondary"
						href={`https://github.com/${update.repo.owner}/${update.repo.name}/actions`}
						external
					>
						{t("updater.actionsLog", "Open GitHub Actions")}
					</LinkButton>
					<Button variant="primary" onClick={onDiscard} disabled={busy}>
						{t("updater.discard", "Discard")}
					</Button>
				</div>
			</>
		);
	} else if (update?.phase === "locking") {
		body = (
			<>
				<p role="status" className="flex items-center gap-2 text-sm">
					<Loader />
					{t(
						"updater.locking",
						"GitHub Actions is updating your lockfile to match the new version. This takes about a minute, then your hosting builds the new version.",
					)}
				</p>
				<Bumps bumps={update.bumps} />
			</>
		);
	} else if (update && isStalled(update)) {
		body = (
			<>
				<Bumps bumps={update.bumps} />
				<p role="alert" className="text-sm text-kumo-danger">
					{t(
						"updater.stalledDirect",
						"Your site still runs the previous version and your hosting has not reported a result. Check your hosting's build log. If the build failed, go back to the previous version so the next build works again.",
					)}
				</p>
				<div className="flex flex-wrap gap-2">
					{buildUrl && (
						<LinkButton variant="secondary" href={buildUrl} external>
							{t("updater.buildLog", "Open build log")}
						</LinkButton>
					)}
					<Button variant="secondary" onClick={onDiscard} disabled={busy}>
						{t("updater.revert", "Go back to the previous version")}
					</Button>
				</div>
			</>
		);
	} else if (update?.phase === "applied") {
		body = (
			<>
				<p role="status" className="flex items-center gap-2 text-sm">
					<Loader />
					{update.direct
						? t(
								"updater.applyingDirect",
								"Your hosting is building your site with the new version. This usually takes a few minutes. This page updates on its own and shows when the new version is live.",
							)
						: t(
								"updater.applying",
								"The update is being installed on your live site. This usually takes two to three minutes. This page updates on its own.",
							)}
				</p>
				<Bumps bumps={update.bumps} />
			</>
		);
	} else if (update?.direct && update.phase === "failed") {
		body = (
			<>
				<Bumps bumps={update.bumps} />
				<p role="alert" className="text-sm text-kumo-danger">
					{t(
						"updater.failedDirect",
						"Your hosting could not build the new version. Most hostings keep the previous version online when a build fails. Check your site, then go back to the previous version so the next build works again.",
					)}
				</p>
				<div className="flex flex-wrap gap-2">
					{buildUrl && (
						<LinkButton variant="secondary" href={buildUrl} external>
							{t("updater.buildLog", "Open build log")}
						</LinkButton>
					)}
					<Button variant="primary" onClick={onDiscard} disabled={busy}>
						{t("updater.revert", "Go back to the previous version")}
					</Button>
				</div>
			</>
		);
	} else if (update) {
		const badge = {
			building: t("updater.phaseBuilding", "Preparing"),
			ready: t("updater.phaseReady", "Ready to check"),
			failed: t("updater.phaseFailed", "Failed"),
			"no-build": t("updater.phaseNoBuild", "Not started"),
		}[update.phase];
		body = (
			<>
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={update.phase === "failed" ? "destructive" : "secondary"}>{badge}</Badge>
				</div>
				<Bumps bumps={update.bumps} />
				{update.phase === "building" && (
					<p role="status" className="flex items-center gap-2 text-sm">
						<Loader />
						{t(
							"updater.building",
							"Cloudflare is building a copy of your site with the new version and copies your current content, images and settings into it. Your live site is not touched. This takes about three minutes.",
						)}
					</p>
				)}
				{update.phase === "ready" && (
					<>
						<p className="text-sm">
							{t(
								"updater.ready",
								"The copy is ready. Open it and check your important pages and the admin. You are signed in there automatically, because passkeys only work on your live address. Everything you see there is a copy: you can click around freely, nothing changes on your live site.",
							)}
						</p>
						<div className="flex flex-wrap gap-2">
							{previewUrl ? (
								<Button variant="primary" onClick={onOpen} disabled={busy}>
									{t("updater.openPreview", "Open test version")}
								</Button>
							) : (
								buildUrl && (
									<LinkButton variant="primary" href={buildUrl} external>
										{t("updater.openPreview", "Open test version")}
									</LinkButton>
								)
							)}
							<Button variant="primary" onClick={() => setConfirm("apply")} disabled={busy}>
								{t("updater.apply", "Apply to live site")}
							</Button>
							<Button variant="secondary" onClick={() => setConfirm("discard")} disabled={busy}>
								{t("updater.discard", "Discard")}
							</Button>
						</div>
					</>
				)}
				{update.phase === "failed" && (
					<>
						<p role="alert" className="text-sm text-kumo-danger">
							{t(
								"updater.failed",
								"The new version could not be built. Your live site is unchanged. The build log shows what went wrong. Discard this attempt; you can try again later.",
							)}
						</p>
						<div className="flex flex-wrap gap-2">
							{buildUrl && (
								<LinkButton variant="secondary" href={buildUrl} external>
									{t("updater.buildLog", "Open build log")}
								</LinkButton>
							)}
							<Button variant="secondary" onClick={onDiscard} disabled={busy}>
								{t("updater.discard", "Discard")}
							</Button>
						</div>
					</>
				)}
				{update.phase === "no-build" && (
					<>
						<p role="alert" className="text-sm">
							{t(
								"updater.noBuild",
								"Cloudflare has not started a test version. Preview builds are probably switched off for this site. Switch on “Enable Preview Builds” in the Cloudflare build settings once, then discard and start again. This is needed only once.",
							)}
						</p>
						<div className="flex flex-wrap gap-2">
							<LinkButton
								variant="secondary"
								href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"
								external
							>
								{t("updater.openCloudflare", "Open Cloudflare")}
							</LinkButton>
							<Button variant="secondary" onClick={onDiscard} disabled={busy}>
								{t("updater.discard", "Discard")}
							</Button>
						</div>
					</>
				)}
			</>
		);
	} else if (!status.connected || !status.repo) {
		body = (
			<p className="text-sm text-kumo-subtle">
				{t("updater.needsConnection", "Connect GitHub and choose your site's repository first.")}
			</p>
		);
	} else if (status.plan?.bumps.length) {
		body = (
			<>
				<Bumps bumps={status.plan.bumps} />
				<p className="text-sm text-kumo-subtle">
					{direct
						? t(
								"updater.planHelpDirect",
								"The new version goes straight to your live site: the updater changes the version in your code and your hosting builds and publishes it. A test copy first is only available on Cloudflare. If something does not work afterwards, you can go back to the previous version.",
							)
						: t(
								"updater.planHelp",
								"First you get a copy of your site with the new version and all your current content. You check it, then decide: apply it to the live site or discard it. Until then, nothing changes on your live site.",
							)}
				</p>
				{status.workflowPermission && (
					<div role="alert" className="space-y-2 rounded-md border border-kumo-line p-3 text-sm">
						<p>
							{t(
								"updater.workflowPermission",
								"Your code has a lockfile, which has to change together with the version. The updater does this with a small GitHub Actions workflow and needs one more permission for it. On GitHub, set Workflows to Read and write and save. GitHub then asks you to accept the new permission: accept it and refresh this page.",
							)}
						</p>
						<LinkButton variant="secondary" href={status.workflowPermission} external>
							{t("updater.grantWorkflows", "Allow on GitHub")}
						</LinkButton>
					</div>
				)}
				<Button
					variant="primary"
					onClick={direct ? () => setConfirm("start") : onStart}
					disabled={
						busy ||
						Boolean(status.error || status.versionsError || status.workflowPermission)
					}
				>
					{direct ? t("updater.startDirect", "Update now") : t("updater.start", "Try the update")}
				</Button>
			</>
		);
	} else {
		body = (
			<p className="text-sm text-kumo-subtle">
				{status.checked && !status.error
					? t("updater.upToDate", "Your site is up to date.")
					: t("updater.planUnavailable", "No update can be offered right now. Fix the error above and refresh.")}
			</p>
		);
	}

	return (
		<section
			className="space-y-4 rounded-lg border border-kumo-line p-4"
			aria-labelledby="updater-update-title"
		>
			<h2 id="updater-update-title" className="text-lg font-medium">
				{t("updater.update", "Update")}
			</h2>
			{body}
			<Dialog.Root
				open={confirm !== null}
				onOpenChange={(open: boolean) => {
					if (!busy && !open) setConfirm(null);
				}}
				role="alertdialog"
			>
				<Dialog size="sm" className="space-y-4 p-6">
					<Dialog.Title className="text-lg font-semibold">
						{confirm === "start"
							? t("updater.startDirectTitle", "Update your live site now?")
							: confirm === "apply"
								? t("updater.applyTitle", "Apply the update to your live site?")
								: t("updater.discardTitle", "Discard the test version?")}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-kumo-subtle">
						{confirm === "start"
							? t(
									"updater.startDirectHelp",
									"Your hosting builds and publishes the new version, usually within a few minutes. Your content stays as it is. Download a backup first: it contains your content, collections, menus, media details and settings, and can be imported again under Settings, Transfer. Media files and user accounts are not included.",
								)
							: confirm === "apply"
							? t(
									"updater.applyHelp",
									"Your live site gets the new version in two to three minutes. Your live content stays as it is. Changes made in the test version are not carried over. Afterwards the test version and its copy of your content are deleted. If something goes wrong, you can undo the update.",
								)
							: t(
									"updater.discardHelp",
									"The test version and its copy of your content are deleted. Your live site stays on its current version.",
								)}
					</Dialog.Description>
					<div className="flex flex-wrap justify-end gap-2">
						{confirm === "start" && (
							<LinkButton variant="secondary" href={BACKUP_URL} external>
								{t("updater.downloadBackup", "Download backup")}
							</LinkButton>
						)}
						<Button variant="secondary" onClick={() => setConfirm(null)} disabled={busy}>
							{t("updater.cancel", "Cancel")}
						</Button>
						<Button
							variant={confirm === "discard" ? "destructive" : "primary"}
							disabled={busy}
							onClick={() => {
								const action =
									confirm === "start" ? onStart : confirm === "apply" ? onApply : onDiscard;
								setConfirm(null);
								action();
							}}
						>
							{confirm === "start"
								? t("updater.startDirect", "Update now")
								: confirm === "apply"
									? t("updater.apply", "Apply to live site")
									: t("updater.discard", "Discard")}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</section>
	);
}
