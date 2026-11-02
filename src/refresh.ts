export function queuedRefresh(load: () => Promise<void>): () => Promise<void> {
	let running: Promise<void> | null = null;
	let requested = false;
	return () => {
		requested = true;
		if (!running) {
			running = Promise.resolve().then(async () => {
				try {
					while (requested) {
						requested = false;
						await load();
					}
				} finally {
					running = null;
				}
			});
		}
		return running;
	};
}
