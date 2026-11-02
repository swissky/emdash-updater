import assert from "node:assert/strict";
import { queuedRefresh } from "../src/refresh.ts";

for (const connected of [true, false]) {
	let server = !connected;
	let displayed = server;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const loading = new Promise<void>((resolve) => {
		started = resolve;
	});
	let calls = 0;
	const refresh = queuedRefresh(async () => {
		calls++;
		const snapshot = server;
		if (calls === 1) {
			started();
			await blocked;
		}
		displayed = snapshot;
	});
	const initial = refresh();
	await loading;
	server = connected;
	const completed = refresh();
	const duplicate = refresh();
	release();
	await Promise.all([initial, completed, duplicate]);
	assert.equal(displayed, connected, "Setup completion replaces an in-flight stale snapshot");
	assert.equal(calls, 2, "Concurrent requests share one trailing refresh");
	await refresh();
	assert.equal(calls, 3);
}
let fail = true;
const retry = queuedRefresh(async () => {
	if (fail) throw new Error("offline");
});
await assert.rejects(retry(), /offline/);
fail = false;
await retry();
console.log("refresh: ok");
