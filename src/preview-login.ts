/**
 * Sign-in links from the live admin into the test version.
 *
 * Passkeys are bound to the live hostname, so they cannot sign in on the
 * preview's workers.dev address. The live site signs a short-lived link with
 * a secret that is written before the preview build copies the database, so
 * the preview can verify it without any call back to the live site.
 */

export const LOGIN_SECRET_KEY = "previewLoginSecret";
export const LOGIN_PATH = "/_emdash/updater/preview-login";
export const LOGIN_TTL_MS = 2 * 60_000;

interface Payload {
	u: string;
	e: number;
	n: string;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
function fromBase64url(value: string): Uint8Array {
	const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function key(secret: string, usage: "sign" | "verify") {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export function newLoginSecret(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function signLogin(secret: string, userId: string, now = Date.now()): Promise<string> {
	const payload: Payload = { u: userId, e: now + LOGIN_TTL_MS, n: crypto.randomUUID() };
	const body = base64url(encoder.encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign("HMAC", await key(secret, "sign"), encoder.encode(body));
	return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** Returns the signed user and nonce, or null for a forged, malformed or expired link. */
export async function verifyLogin(
	secret: string,
	token: string,
	now = Date.now(),
): Promise<{ userId: string; nonce: string } | null> {
	const [body, signature, extra] = token.split(".");
	if (!body || !signature || extra !== undefined || token.length > 1024) return null;
	try {
		const valid = await crypto.subtle.verify(
			"HMAC",
			await key(secret, "verify"),
			fromBase64url(signature),
			encoder.encode(body),
		);
		if (!valid) return null;
		const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as Payload;
		if (typeof payload.u !== "string" || typeof payload.n !== "string" || typeof payload.e !== "number")
			return null;
		return payload.e > now ? { userId: payload.u, nonce: payload.n } : null;
	} catch {
		return null;
	}
}
