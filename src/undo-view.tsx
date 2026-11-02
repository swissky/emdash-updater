import { Button, Checkbox, Dialog, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react";
import * as React from "react";

import type { Bump } from "./versions.js";

export interface LastUpdate {
	id: string;
	finishedAt: string;
	bumps: Bump[];
	appliedSha?: string;
	before?: string;
	undone?: { at: string; withDatabase: boolean };
}

interface Props {
	lastUpdate: LastUpdate;
	restoreWindowMs: number;
	cleaning?: boolean;
	/** The live site runs the versions from before the update again. */
	reverted?: boolean;
	busy: boolean;
	onUndo: (withDatabase: boolean) => Promise<void>;
}

export function UndoView({ lastUpdate, restoreWindowMs, cleaning, reverted, busy, onUndo }: Props) {
	const { i18n } = useLingui();
	const t = (id: string, message: string, values?: Record<string, unknown>) =>
		i18n._({ id, message, values });
	const [confirm, setConfirm] = React.useState(false);
	const [withDatabase, setWithDatabase] = React.useState(false);
	const undone = lastUpdate.undone;
	const before = lastUpdate.before ? new Date(lastUpdate.before) : null;
	const canRestore = Boolean(before && Date.now() - before.getTime() < restoreWindowMs);
	const date = (d: Date | string) => new Date(d).toLocaleString(i18n.locale);

	return (
		<section className="space-y-3 rounded-lg border border-kumo-line p-4">
			<h2 className="text-lg font-medium">{t("updater.lastVerified", "Last update")}</h2>
			<p className="text-sm text-kumo-subtle">{date(lastUpdate.finishedAt)}</p>
			<ul className="space-y-1 text-sm">
				{lastUpdate.bumps.map((bump) => (
					<li key={bump.name}>
						<code>{bump.name}</code>: {bump.from} → {bump.to}
					</li>
				))}
			</ul>
			{cleaning && (
				<p role="status" className="flex items-center gap-2 text-sm">
					<Loader />
					{t(
						"updater.cleaning",
						"The test version and its copy of your content are being deleted. This takes about two minutes.",
					)}
				</p>
			)}
			{undone ? (
				<p role="status" className="text-sm">
					{reverted
						? t("updater.undoneDone", "This update was undone. Your site runs the previous version again.")
						: t(
								"updater.undone",
								"This update was undone. Your site goes back to the previous version within about three minutes.",
							)}
				</p>
			) : (
				lastUpdate.appliedSha && (
					<>
						<p className="text-sm">
							{t(
								"updater.undoHelp",
								"Something does not work since the update? You can go back to the previous version.",
							)}
						</p>
						<Button variant="secondary" onClick={() => setConfirm(true)} disabled={busy || cleaning}>
							{t("updater.undo", "Undo update")}
						</Button>
					</>
				)
			)}

			<Dialog.Root open={confirm} onOpenChange={(open: boolean) => !busy && setConfirm(open)} role="alertdialog">
				<Dialog size="sm" className="space-y-4 p-6">
					<Dialog.Title className="text-lg font-semibold">
						{t("updater.undoTitle", "Undo the update?")}
					</Dialog.Title>
					<Dialog.Description className="text-sm">
						{t(
							"updater.undoExplain",
							"Your site goes back to the previous EmDash version. Your content stays as it is now, including everything you changed since the update. Database changes made by the update stay too. EmDash makes them so that the previous version keeps working, but check your site afterwards.",
						)}
					</Dialog.Description>
					{canRestore && before && (
						<div className="space-y-1">
							<Checkbox
								checked={withDatabase}
								onCheckedChange={(checked: boolean) => setWithDatabase(checked)}
								label={t("updater.undoWithDatabase", "Also reset the content to {when}", {
									when: date(before),
								})}
							/>
							<p className="ps-6 text-sm text-kumo-subtle">
								{t(
									"updater.undoWithDatabaseHelp",
									"Only needed if the update changed or damaged content. Everything saved after this moment is lost: posts, pages, media details, users and settings.",
								)}
							</p>
						</div>
					)}
					<div className="flex flex-wrap justify-end gap-2">
						<Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>
							{t("updater.cancel", "Cancel")}
						</Button>
						<Button
							variant={withDatabase ? "destructive" : "primary"}
							disabled={busy}
							onClick={async () => {
								await onUndo(withDatabase);
								setConfirm(false);
							}}
						>
							{withDatabase
								? t("updater.undoConfirmWithDatabase", "Undo update and reset content")
								: t("updater.undoConfirm", "Undo update")}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</section>
	);
}
