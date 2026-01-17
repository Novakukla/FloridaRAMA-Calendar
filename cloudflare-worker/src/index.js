/**
 * Cloudflare Worker: FareHarbor webhook receiver → triggers GitHub Actions sync.
 *
 * Security options (choose one; both can be enabled):
 * - Token auth: set WEBHOOK_TOKEN secret; require Authorization: Bearer <token> (or X-Webhook-Token)
 * - HMAC auth: set WEBHOOK_HMAC_SECRET secret; require X-Signature-256 header
 *
 * GitHub dispatch:
 * - Set GITHUB_TOKEN secret (fine-grained PAT recommended)
 * - Uses workflow_dispatch on GITHUB_WORKFLOW_FILE and GITHUB_REF.
 */

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return new Response("ok", { status: 200 });
		}

		if (url.pathname !== "/fareharbor/webhook") {
			return new Response("not found", { status: 404 });
		}

		if (request.method !== "POST") {
			return new Response("method not allowed", {
				status: 405,
				headers: { Allow: "POST" },
			});
		}

		// Basic body size guard (1MB)
		const contentLength = Number(request.headers.get("content-length") || "0");
		if (contentLength && contentLength > 1_000_000) {
			return new Response("payload too large", { status: 413 });
		}

		const raw = await request.arrayBuffer();

		const authOk =
			(await verifyTokenAuth(request, env)) && (await verifyHmacAuth(request, env, raw));

		if (!authOk) {
			return new Response("unauthorized", { status: 401 });
		}

		// Fire-and-forget: respond quickly to webhook sender.
		ctx.waitUntil(dispatchGitHubWorkflow(env));
		return new Response("accepted", { status: 202 });
	},
};

async function verifyTokenAuth(request, env) {
	// If no token is configured, skip this check.
	if (!env.WEBHOOK_TOKEN) return true;

	const auth = request.headers.get("authorization") || "";
	if (auth.toLowerCase().startsWith("bearer ")) {
		const token = auth.slice("bearer ".length).trim();
		return timingSafeEqualStr(token, env.WEBHOOK_TOKEN);
	}

	const headerToken = request.headers.get("x-webhook-token");
	if (headerToken) return timingSafeEqualStr(headerToken.trim(), env.WEBHOOK_TOKEN);

	return false;
}

async function verifyHmacAuth(request, env, rawBody) {
	// If no HMAC secret is configured, skip this check.
	if (!env.WEBHOOK_HMAC_SECRET) return true;

	const sigHeader =
		request.headers.get("x-signature-256") || request.headers.get("x-hub-signature-256");
	if (!sigHeader) return false;

	const provided = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : sigHeader;
	const providedHex = provided.trim().toLowerCase();

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.WEBHOOK_HMAC_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);

	const mac = await crypto.subtle.sign("HMAC", key, rawBody);
	const macHex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

	return timingSafeEqualStr(macHex, providedHex);
}

async function dispatchGitHubWorkflow(env) {
	if (!env.GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN secret");
	if (!env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("Missing GITHUB_OWNER/GITHUB_REPO");
	if (!env.GITHUB_WORKFLOW_FILE) throw new Error("Missing GITHUB_WORKFLOW_FILE");

	const endpoint = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`;

	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${env.GITHUB_TOKEN}`,
			"accept": "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": "floridarama-webhook-worker",
		},
		body: JSON.stringify({ ref: env.GITHUB_REF || "main" }),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`GitHub dispatch failed: HTTP ${res.status} ${text}`);
	}
}

function timingSafeEqualStr(a, b) {
	const aa = new TextEncoder().encode(String(a));
	const bb = new TextEncoder().encode(String(b));
	if (aa.length !== bb.length) return false;

	let out = 0;
	for (let i = 0; i < aa.length; i++) out |= aa[i] ^ bb[i];
	return out === 0;
}
