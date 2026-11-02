import handler, {
	createScheduledHandler,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

declare const __UPDATER_PREVIEW_BUILD__: boolean;
const scheduled = createScheduledHandler();

export default {
	...handler,
	async fetch(request, env, ctx) {
		const response = await handler.fetch!(request, env, ctx);
		if (!__UPDATER_PREVIEW_BUILD__) return response;
		const marked = new Response(response.body, response);
		marked.headers.set("X-Robots-Tag", "noindex, nofollow");
		return marked;
	},
	scheduled(controller, env, ctx) {
		// Scheduled publishing on the copy must not run twice next to the live site.
		if (__UPDATER_PREVIEW_BUILD__) return;
		return scheduled(controller, env, ctx);
	},
} satisfies ExportedHandler;
