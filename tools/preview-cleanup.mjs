/** Deletes the preview copies so no copy of the live content stays behind. */
export async function deletePreviewCopies(call, names, log = console.log) {
	for (const db of names.d1) {
		const found = (await call(`/d1/database?name=${encodeURIComponent(db.preview)}`)).find(
			(d) => d.name === db.preview,
		);
		if (found) await call(`/d1/database/${found.uuid}`, { method: "DELETE" });
	}
	for (const bucket of names.r2) {
		if (!(await call(`/r2/buckets/${bucket.preview}`, { allow404: true }))) continue;
		// R2 only deletes empty buckets.
		let cursor;
		do {
			const page = await call(
				`/r2/buckets/${bucket.preview}/objects?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
				{ withCursor: true },
			);
			for (const object of page.result) {
				const key = object.key.split("/").map(encodeURIComponent).join("/");
				await call(`/r2/buckets/${bucket.preview}/objects/${key}`, { method: "DELETE" });
			}
			cursor = page.cursor;
		} while (cursor);
		await call(`/r2/buckets/${bucket.preview}`, { method: "DELETE" });
	}
	for (const namespace of names.kv) {
		for (let page = 1; page <= 50; page++) {
			const list = await call(`/storage/kv/namespaces?per_page=100&page=${page}`);
			const found = list.find((n) => n.title === namespace.preview);
			if (found) {
				await call(`/storage/kv/namespaces/${found.id}`, { method: "DELETE" });
				break;
			}
			if (list.length < 100) break;
		}
	}
	log("[emdash-updater] Deleted the test copies of your content.");
}
