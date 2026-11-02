import { Badge, Button, Dialog, Input, LinkButton, Loader, Table } from "@cloudflare/kumo";
import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import type { Repo } from "./github.js";
import type { PreviewUpdate } from "./preview.js";
import { queuedRefresh } from "./refresh.js";
import { UndoView } from "./undo-view.jsx";
import type { LastUpdate } from "./undo-view.jsx";
import { UpdateView } from "./update-view.jsx";
import { isNewer } from "./versions.js";
import type { Bump } from "./versions.js";

const API = "/_emdash/api/plugins/emdash-updater";
const POLL_MS = 10_000;
const CONNECTION_STATE = "emdash-updater:connection-state";

interface Status {
	connected: boolean;
	preview?: boolean;
	installUrl?: string | null;
	choices?: Repo[];
	repo?: Repo | null;
	packages: Array<{
		name: string;
		installed: string;
		latest: string | null;
		eligible: string | null;
	}>;
	versionsError?: string;
	checkedAt?: string;
	minimumReleaseAgeHours: number;
	plan?: { id: string; bumps: Bump[] } | null;
	checked?: boolean;
	error?: string;
	update?: PreviewUpdate | null;
	previewUrl?: string | null;
	lastUpdate?: LastUpdate | null;
	restoreWindowMs?: number;
	cleaning?: boolean;
	previews?: boolean;
}

class SignedOutError extends Error {}

function messageOf(error: unknown, fallback: string, i18n: I18n): string {
	if (error instanceof SignedOutError)
		return i18n._({
			id: "updater.signedOut",
			message:
				"You were signed out, probably because your hosting restarted the site while publishing. Sign in again and open this page: the update status is kept.",
		});
	return error instanceof Error && error.message ? error.message : fallback;
}

async function post<T>(route: string, body: unknown = {}): Promise<T> {
	const response = await apiFetch(`${API}/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status === 401) throw new SignedOutError();
	const data = await parseApiResponse<T>(response, `Request to ${route} failed`);
	if (data && typeof data === "object" && "ok" in data && data.ok === false) {
		throw new Error(
			"error" in data && typeof data.error === "string" ? data.error : `Request to ${route} failed`,
		);
	}
	return data;
}

function githubUrl(value: string | null | undefined): string | null {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" &&
			url.hostname === "github.com" &&
			!url.username &&
			!url.password
			? url.href
			: null;
	} catch {
		return null;
	}
}

function submitManifest(action: string, manifest: string) {
	const form = document.createElement("form");
	form.method = "POST";
	form.action = "/connect-github";
	for (const [name, value] of Object.entries({ action, manifest })) {
		const input = document.createElement("input");
		input.type = "hidden";
		input.name = name;
		input.value = value;
		form.append(input);
	}
	document.body.append(form);
	form.submit();
	form.remove();
}

function UpdatesPage() {
	const { i18n } = useLingui();
	const [status, setStatus] = React.useState<Status | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [loadError, setLoadError] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [refreshing, setRefreshing] = React.useState(false);
	const [org, setOrg] = React.useState("");
	const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
	const initialized = React.useRef(false);
	const acting = React.useRef(false);
	const loading = React.useRef(false);

	const refresh = React.useMemo(
		() =>
			queuedRefresh(async () => {
				loading.current = true;
				setRefreshing(true);
				try {
					setStatus(await post<Status>("status"));
					setLoadError(null);
				} catch (cause) {
					setLoadError(
						messageOf(
							cause,
							i18n._({
								id: "updater.loadError",
								message: "Could not load update status",
							}),
							i18n,
						),
					);
				} finally {
					loading.current = false;
					setRefreshing(false);
				}
			}),
		[i18n],
	);

	React.useEffect(() => {
		if (initialized.current) return;
		initialized.current = true;
		const url = new URL(window.location.href);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const callbackError = url.searchParams.get("error");
		if (code !== null || state !== null || callbackError !== null) {
			url.searchParams.delete("code");
			url.searchParams.delete("state");
			url.searchParams.delete("error");
			window.history.replaceState(window.history.state, "", url);
		}
		const finishConnection = async () => {
			acting.current = true;
			setBusy(true);
			try {
				if (code !== null || state !== null || callbackError !== null) {
					const expected = sessionStorage.getItem(CONNECTION_STATE);
					sessionStorage.removeItem(CONNECTION_STATE);
					if (callbackError || !code || !state || !expected || state !== expected) {
						throw new Error(
							i18n._({
								id: "updater.invalidState",
								message:
									"The GitHub connection expired or was not started in this tab. Please connect again.",
							}),
						);
					}
					const result = await post<{ installUrl: string }>("connect/finish", {
						code,
						state,
					});
					const installUrl = githubUrl(result.installUrl);
					if (!installUrl)
						throw new Error(
							i18n._({
								id: "updater.invalidGithubUrl",
								message: "GitHub returned an invalid connection URL.",
							}),
						);
					window.location.assign(installUrl);
				}
			} catch (cause) {
				setError(
					messageOf(
						cause,
						i18n._({
							id: "updater.connectionError",
							message: "Could not complete the GitHub connection",
						}),
						i18n,
					),
				);
			} finally {
				await refresh();
				acting.current = false;
				setBusy(false);
			}
		};
		void finishConnection();
	}, [i18n, refresh]);

	React.useEffect(() => {
		if (!status?.update) return;
		const timer = window.setInterval(() => {
			if (!acting.current) void refresh();
		}, POLL_MS);
		return () => window.clearInterval(timer);
	}, [status?.update?.id, refresh]);

	const act =
		<A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
		async (...args: A) => {
			if (acting.current || loading.current) return;
			acting.current = true;
			setBusy(true);
			setError(null);
			try {
				await fn(...args);
			} catch (cause) {
				setError(messageOf(cause, i18n._({ id: "updater.actionError", message: "Action failed" }), i18n));
			} finally {
				await refresh();
				acting.current = false;
				setBusy(false);
			}
		};
	const locked = Boolean(status?.update);
	const disabled = busy || refreshing;
	const installUrl = githubUrl(status?.installUrl);
	const plan = status?.plan;
	const connect = act(async () => {
		const result = await post<{ action: string; manifest: string }>("connect/start", {
			org: org.trim() || undefined,
		});
		const action = githubUrl(result.action);
		const state = action && new URL(action).searchParams.get("state");
		if (!action || !state)
			throw new Error(
				i18n._({
					id: "updater.invalidGithubUrl",
					message: "GitHub returned an invalid connection URL.",
				}),
			);
		sessionStorage.setItem(CONNECTION_STATE, state);
		submitManifest(action, result.manifest);
	});
	const start = act(async () => {
		if (plan) await post("update/start", { planId: plan.id });
	});
	const open = act(async () => {
		if (!status?.update) return;
		// Opened before the request so the browser does not block it as a popup.
		const tab = window.open("", "_blank");
		try {
			const { url } = await post<{ url: string | null }>("update/open", {
				updateId: status.update.id,
			});
			const target = url && new URL(url);
			if (
				!tab ||
				!target ||
				target.protocol !== "https:" ||
				!/\.(workers\.dev|cloudflare\.com)$/.test(target.hostname)
			)
				throw new Error(
					i18n._({ id: "updater.openError", message: "The test version could not be opened." }),
				);
			tab.opener = null;
			tab.location.href = target.href;
		} catch (error) {
			tab?.close();
			throw error;
		}
	});
	const apply = act(async () => {
		if (status?.update) await post("update/apply", { updateId: status.update.id });
	});
	const discard = act(async () => {
		if (status?.update) await post("update/discard", { updateId: status.update.id });
	});
	const undo = act(async (withDatabase: boolean) => {
		if (status?.lastUpdate) await post("update/undo", { id: status.lastUpdate.id, withDatabase });
	});
	const disconnect = act(async () => {
		if (locked) return;
		await post("disconnect");
		setConfirmDisconnect(false);
	});

	return (
		<div className="max-w-3xl space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold">
						{i18n._({ id: "updater.title", message: "Updates" })}
					</h1>
					<p className="mt-1 text-sm text-kumo-subtle">
						{i18n._({
							id: "updater.subtitle",
							message: "See which versions are available and update your site with one click.",
						})}
					</p>
				</div>
				<Button
					variant="secondary"
					onClick={() => void refresh()}
					disabled={disabled}
					loading={refreshing}
				>
					{loadError
						? i18n._({ id: "updater.retry", message: "Retry" })
						: i18n._({ id: "updater.refresh", message: "Refresh" })}
				</Button>
			</header>
			{(error || loadError) && (
				<div
					role="alert"
					className="space-y-2 rounded-md border border-kumo-danger p-3 text-sm text-kumo-danger"
				>
					{error && <p>{error}</p>}
					{loadError && <p>{loadError}</p>}
				</div>
			)}

			<section
				className="space-y-4 rounded-lg border border-kumo-line p-4"
				aria-labelledby="updater-versions-title"
			>
				<h2 id="updater-versions-title" className="text-lg font-medium">
					{i18n._({ id: "updater.versions", message: "Package versions" })}
				</h2>
				<p className="text-sm text-kumo-subtle">
					{i18n._({
						id: "updater.installedHelp",
						message:
							"Installed shows what your live site is running. Latest shows the newest stable release. Available to test shows the version this updater can use.",
					})}
				</p>
				{!status ? (
					<div role="status" className="flex items-center gap-2 text-sm">
						{!loadError && <Loader />}
						{loadError
							? i18n._({
									id: "updater.unavailable",
									message: "Version information is unavailable. Retry to load it.",
								})
							: i18n._({
									id: "updater.loading",
									message: "Loading package versions…",
								})}
					</div>
				) : (
					<>
						<div className="overflow-x-auto">
							<Table aria-labelledby="updater-versions-title">
								<Table.Header>
									<Table.Row>
										<Table.Head>{i18n._({ id: "updater.package", message: "Package" })}</Table.Head>
										<Table.Head>
											{i18n._({
												id: "updater.installed",
												message: "Installed",
											})}
										</Table.Head>
										<Table.Head>{i18n._({ id: "updater.latest", message: "Latest" })}</Table.Head>
										<Table.Head>
											{i18n._({
												id: "updater.eligible",
												message: "Available to test",
											})}
										</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{(status.packages ?? []).map((pkg) => (
										<Table.Row key={pkg.name}>
											<Table.Cell>
												<code>{pkg.name}</code>
											</Table.Cell>
											<Table.Cell>
												<strong>{pkg.installed}</strong>
											</Table.Cell>
											<Table.Cell>
												{pkg.latest ?? i18n._({ id: "updater.unknown", message: "Unknown" })}
												{!status.versionsError &&
													!loadError &&
													pkg.latest &&
													isNewer(pkg.latest, pkg.installed) && (
														<span className="ms-2">
															<Badge variant="secondary">
																{i18n._({
																	id: "updater.available",
																	message: "Update available",
																})}
															</Badge>
														</span>
													)}
											</Table.Cell>
											<Table.Cell>
												{pkg.eligible ??
													i18n._({
														id: "updater.noEligible",
														message: "None available",
													})}
												{pkg.latest &&
													pkg.latest.split(".")[0] !== pkg.installed.split(".")[0] &&
													isNewer(pkg.latest, pkg.installed) && (
														<p className="text-xs text-kumo-subtle">
															{i18n._({
																id: "updater.manualMajor",
																message: "Major upgrade: manual review",
															})}
														</p>
													)}
											</Table.Cell>
										</Table.Row>
									))}
								</Table.Body>
							</Table>
						</div>
						{!status.packages?.length && (
							<p className="text-sm">
								{i18n._({
									id: "updater.noPackages",
									message: "Installed package information is unavailable.",
								})}
							</p>
						)}
						{status.versionsError && (
							<p role="alert" className="text-sm text-kumo-danger">
								{status.versionsError}
							</p>
						)}
						<p className="text-sm text-kumo-subtle">
							{i18n._({
								id: "updater.releasePolicy",
								message:
									"Offered releases are stable, at least 24 hours old and within the installed major version. A major version can contain breaking changes, so it is not offered automatically.",
							})}
						</p>
						{status.checkedAt && (
							<p className="text-xs text-kumo-subtle">
								{i18n._({
									id: "updater.checkedAt",
									message: "Last checked:",
								})}{" "}
								{new Date(status.checkedAt).toLocaleString(i18n.locale)}
							</p>
						)}
					</>
				)}
			</section>

			{status && (
				<>
					<section
						className="space-y-4 rounded-lg border border-kumo-line p-4"
						aria-labelledby="updater-connection-title"
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h2 id="updater-connection-title" className="text-lg font-medium">
								{i18n._({ id: "updater.github", message: "GitHub connection" })}
							</h2>
							<Badge variant="secondary">
								{status.connected
									? i18n._({
											id: "updater.connected",
											message: "App connected",
										})
									: i18n._({
											id: "updater.disconnected",
											message: "Not connected",
										})}
							</Badge>
						</div>
						{status.error && (
							<p role="alert" className="text-sm text-kumo-danger">
								{status.error}
							</p>
						)}
						{status.repo ? (
							<>
								<p className="break-words text-sm">
									<a
										className="underline"
										href={`https://github.com/${encodeURIComponent(status.repo.owner)}/${encodeURIComponent(status.repo.name)}`}
										target="_blank"
										rel="noopener noreferrer"
									>
										{status.repo.owner}/{status.repo.name}
									</a>{" "}
									({status.repo.defaultBranch})
								</p>
								<Button
									variant="secondary"
									onClick={act(async () => {
										if (!locked) await post("change-repo");
									})}
									disabled={disabled || locked}
								>
									{i18n._({
										id: "updater.changeRepository",
										message: "Change repository",
									})}
								</Button>
							</>
						) : status.connected ? (
							<>
								<p className="text-sm">
									{i18n._({
										id: "updater.chooseRepository",
										message:
											"Select the repository this site is built from. A repository is never selected automatically.",
									})}
								</p>
								<div className="flex flex-wrap gap-2">
									{status.choices?.map((repo) => (
										<Button
											key={`${repo.owner}/${repo.name}`}
											variant="primary"
											disabled={disabled || locked}
											onClick={act(async () => {
												if (!locked)
													await post("select-repo", {
														owner: repo.owner,
														name: repo.name,
													});
											})}
										>
											{repo.owner}/{repo.name}
										</Button>
									))}
								</div>
								{!status.choices?.length && !status.error && (
									<p className="text-sm text-kumo-subtle">
										{i18n._({
											id: "updater.noRepositories",
											message:
												"No accessible EmDash repositories were found. Grant the App access, then refresh.",
										})}
									</p>
								)}
								{installUrl && !locked && (
									<p className="flex flex-wrap items-center gap-1 text-sm text-kumo-subtle">
										{i18n._({
											id: "updater.repositoryMissing",
											message: "Repository missing?",
										})}
										<LinkButton variant="ghost" size="sm" href={installUrl} external>
											{i18n._({
												id: "updater.grantAccess",
												message: "Manage repository access on GitHub",
											})}
										</LinkButton>
									</p>
								)}
							</>
						) : (
							<>
								<p className="text-sm text-kumo-subtle">
									{i18n._({
										id: "updater.connectHelp",
										message:
											"Connect GitHub once so the updater can change the EmDash version in your site's code. Package versions stay visible without a connection.",
									})}
								</p>
								<Input
									label={i18n._({
										id: "updater.organization",
										message: "GitHub organization (optional)",
									})}
									value={org}
									onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
										setOrg(event.target.value)
									}
									disabled={disabled || locked}
								/>
								<Button variant="primary" onClick={connect} disabled={disabled || locked}>
									{i18n._({ id: "updater.connect", message: "Connect GitHub" })}
								</Button>
							</>
						)}
						{status.connected && (
							<Button
								variant="ghost"
								onClick={() => {
									setError(null);
									setConfirmDisconnect(true);
								}}
								disabled={disabled || locked}
							>
								{i18n._({ id: "updater.disconnect", message: "Disconnect" })}
							</Button>
						)}
						{locked && (
							<p className="text-sm text-kumo-subtle">
								{i18n._({
									id: "updater.connectionLocked",
									message:
										"The repository and connection cannot be changed while an update is waiting for your decision.",
								})}
							</p>
						)}
					</section>

					<UpdateView
						status={status}
						busy={disabled}
						onStart={start}
						onOpen={open}
						onApply={apply}
						onDiscard={discard}
					/>

					{status.lastUpdate && (
						<UndoView
							lastUpdate={status.lastUpdate}
							restoreWindowMs={status.restoreWindowMs ?? 0}
							cleaning={status.cleaning}
							reverted={status.lastUpdate.bumps.every(
								(bump) =>
									status.packages.find((p) => p.name === bump.name)?.installed === bump.from,
							)}
							busy={disabled}
							onUndo={undo}
						/>
					)}
				</>
			)}

			<Dialog.Root
				open={confirmDisconnect}
				onOpenChange={(open: boolean) => {
					if (!busy) setConfirmDisconnect(open);
				}}
				role="alertdialog"
			>
				<Dialog size="sm" className="space-y-4 p-6">
					<Dialog.Title className="text-lg font-semibold">
						{i18n._({
							id: "updater.disconnectTitle",
							message: "Disconnect GitHub?",
						})}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-kumo-subtle">
						{i18n._({
							id: "updater.disconnectHelp",
							message:
								"This removes the App credentials and repository selection stored on this site. It does not uninstall or delete the GitHub App. You can manage or uninstall it separately on GitHub.",
						})}
					</Dialog.Description>
					{error && (
						<p role="alert" className="text-sm text-kumo-danger">
							{error}
						</p>
					)}
					<div className="flex flex-wrap justify-end gap-2">
						<Button variant="secondary" onClick={() => setConfirmDisconnect(false)} disabled={busy}>
							{i18n._({ id: "updater.cancel", message: "Cancel" })}
						</Button>
						<Button variant="destructive" onClick={disconnect} disabled={disabled || locked}>
							{i18n._({ id: "updater.disconnect", message: "Disconnect" })}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = { "/": UpdatesPage };
