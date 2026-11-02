/** Committed onto the update branch after the decision; its build deletes the test copies. */
export const CLEANUP_MARKER = ".emdash-update-cleanup";
/** Committed by "Undo update" when the content should go back as well. */
export const ROLLBACK_MARKER = ".emdash-rollback.json";
/** Update branches; on Cloudflare their names double as preview aliases. */
export const UPDATE_BRANCH_PREFIX = "emdash-update-";

export function isUpdatePreviewBuild(env = process.env) {
	return Boolean(env.WORKERS_CI_BRANCH?.startsWith(UPDATE_BRANCH_PREFIX));
}
