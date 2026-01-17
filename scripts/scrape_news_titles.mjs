#!/usr/bin/env node
/**
 * Local helper to fetch real page titles for the URLs in news.html.
 *
 * Why local:
 * - Wix embedded HTML runs in a browser and is blocked by CORS from scraping other sites.
 *
 * Usage (from repo root):
 *   node scripts/scrape_news_titles.mjs            (dry-run, prints proposed titles)
 *   node scripts/scrape_news_titles.mjs --write    (rewrites news.html ITEMS titles)
 */

import fs from "node:fs/promises";

const NEWS_FILE = new URL("../news.html", import.meta.url);

const SHOULD_WRITE = process.argv.includes("--write");
const REQUEST_DELAY_MS = 250;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(str) {
	return String(str)
		.replaceAll(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
			try {
				return String.fromCodePoint(parseInt(hex, 16));
			} catch {
				return _;
			}
		})
		.replaceAll(/&#([0-9]+);/g, (_, dec) => {
			try {
				return String.fromCodePoint(parseInt(dec, 10));
			} catch {
				return _;
			}
		})
		.replaceAll(/&amp;/g, "&")
		.replaceAll(/&lt;/g, "<")
		.replaceAll(/&gt;/g, ">")
		.replaceAll(/&quot;/g, '"')
		.replaceAll(/&#39;/g, "'")
		.replaceAll(/&#8217;/g, "’")
		.replaceAll(/&#8211;/g, "–")
		.replaceAll(/&#8212;/g, "—")
		.replaceAll(/\s+/g, " ")
		.trim();
}

function extractTitle(html) {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match) return null;
	return decodeHtmlEntities(match[1]);
}

function extractMetaContent(html, attrName, attrValue) {
	// Example: <meta property="og:image" content="...">
	const re = new RegExp(
		`<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["'][^>]*>`,
		"i"
	);
	const m = html.match(re);
	return m ? decodeHtmlEntities(m[1]) : null;
}

function extractFirstImageSrc(html) {
	// Very simple: first <img ... src="...">
	const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
	return m ? decodeHtmlEntities(m[1]) : null;
}

function absolutizeMaybe(url, baseUrl) {
	try {
		return new URL(url, baseUrl).toString();
	} catch {
		return null;
	}
}

function getHostname(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function extractYouTubeId(url) {
	try {
		const u = new URL(url);
		if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
		if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
	} catch {
		// ignore
	}
	return null;
}

function cleanTitle(title, url) {
	if (!title) return null;
	let t = String(title).trim();

	// Common suffix cleanup. Keep conservative.
	if (getHostname(url).includes("youtube.com")) {
		t = t.replace(/\s*-\s*YouTube\s*$/i, "").trim();
	}

	// Normalize whitespace
	t = t.replace(/\s+/g, " ").trim();

	// Avoid writing obvious bot-check / access-block pages as titles.
	if (
		/^(verifying device|just a moment)\b/i.test(t) ||
		/checking your browser/i.test(t) ||
		/attention required/i.test(t) ||
		/access denied/i.test(t)
	) {
		return null;
	}
	return t;
}

async function fetchTitleFromHtml(url) {
	const res = await fetch(url, {
		redirect: "follow",
		headers: {
			"user-agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
			accept: "text/html,application/xhtml+xml",
		},
	});

	const contentType = res.headers.get("content-type") || "";
	if (!res.ok) {
		return { title: null, ok: false, status: res.status, note: `HTTP ${res.status}` };
	}
	if (!contentType.toLowerCase().includes("text/html")) {
		return { title: null, ok: true, status: res.status, note: `Non-HTML: ${contentType}` };
	}

	const html = await res.text();
	const title = extractTitle(html);
	return { title, ok: true, status: res.status, html };
}

async function fetchYouTubeOEmbedTitle(url) {
	// YouTube supports oEmbed without an API key.
	const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
	const res = await fetch(endpoint, { redirect: "follow" });
	if (!res.ok) return { title: null, ok: false, status: res.status, note: `oEmbed HTTP ${res.status}` };
	const data = await res.json();
	return { title: data?.title || null, ok: true, status: res.status };
}

async function fetchBestTitle(url) {
	const ytId = extractYouTubeId(url);
	if (ytId) {
		try {
			const o = await fetchYouTubeOEmbedTitle(url);
			if (o.title) return o;
		} catch {
			// fall back to HTML
		}
	}
	return await fetchTitleFromHtml(url);
}

function extractBestImageFromHtml(html, pageUrl) {
	const og = extractMetaContent(html, "property", "og:image") || extractMetaContent(html, "name", "og:image");
	if (og) return absolutizeMaybe(og, pageUrl);

	const tw = extractMetaContent(html, "name", "twitter:image") || extractMetaContent(html, "property", "twitter:image");
	if (tw) return absolutizeMaybe(tw, pageUrl);

	const first = extractFirstImageSrc(html);
	if (first) return absolutizeMaybe(first, pageUrl);

	return null;
}

function parseItemsFromNewsHtml(fileText) {
	const start = fileText.indexOf("const ITEMS");
	if (start === -1) throw new Error("Could not find `const ITEMS` in news.html");

	const before = fileText.slice(0, start);
	const afterStart = fileText.slice(start);

	const match = afterStart.match(/const\s+ITEMS\s*=\s*(\[[\s\S]*?\n\t\t\t\]);/);
	if (!match) throw new Error("Could not extract the ITEMS array literal.");

	const arrayLiteral = match[1];
	const arrayStart = start + match.index + match[0].indexOf(match[1]);
	const arrayEnd = arrayStart + arrayLiteral.length;

	// Evaluate the array literal. This is local-only tooling.
	// eslint-disable-next-line no-new-func
	const items = new Function(`return ${arrayLiteral};`)();
	if (!Array.isArray(items)) throw new Error("ITEMS did not evaluate to an array.");

	return { before, after: fileText.slice(arrayEnd), items, arrayLiteral, arrayStart, arrayEnd };
}

function formatItemsArray(items) {
	// Match the style in news.html: tabs + 4-space-ish object formatting.
	const indent1 = "\t\t\t"; // inside <script>
	const indent2 = "\t\t\t\t";
	const indent3 = "\t\t\t\t\t";

	const lines = [];
	lines.push("[");
	for (const item of items) {
		lines.push(`${indent2}{`);
		for (const key of ["type", "group", "tag", "title", "source", "url", "thumb", "description"]) {
			if (item[key] === undefined) continue;
			const value = String(item[key]).replaceAll("\\", "\\\\").replaceAll('"', "\\\"");
			lines.push(`${indent3}${key}: "${value}",`);
		}
		lines.push(`${indent2}},`);
	}
	lines.push(`${indent1}];`);
	return lines.join("\n");
}

async function main() {
	if (typeof fetch !== "function") {
		throw new Error("This script requires Node 18+ (global fetch).");
	}

	const newsHtml = await fs.readFile(NEWS_FILE, "utf8");
	const parsed = parseItemsFromNewsHtml(newsHtml);

	console.log(`Found ${parsed.items.length} ITEMS in news.html`);

	const updated = [];
	for (const item of parsed.items) {
		if (!item?.url) {
			updated.push(item);
			continue;
		}

		process.stdout.write(`- Fetching metadata: ${item.url}\n`);
		let fetchedTitle = null;
		let fetchedThumb = null;
		try {
			const r = await fetchBestTitle(item.url);
			fetchedTitle = cleanTitle(r.title, item.url);
			// Scrape thumbnails for articles, and for non-YouTube videos (FOX/etc).
			const isYouTube = Boolean(extractYouTubeId(item.url));
			const shouldTryThumb = item.type === "article" || (item.type === "video" && !isYouTube);
			if (shouldTryThumb && r.html) {
				fetchedThumb = extractBestImageFromHtml(r.html, item.url);
			}
		} catch (e) {
			process.stdout.write(`  (failed) ${String(e)}\n`);
		}
		await sleep(REQUEST_DELAY_MS);

		const next = { ...item };
		if (fetchedTitle) {
			next.title = fetchedTitle;
			process.stdout.write(`  title -> ${fetchedTitle}\n`);
		} else {
			process.stdout.write(`  title -> (no title found; kept existing)\n`);
		}

		if (fetchedThumb) {
			next.thumb = fetchedThumb;
			process.stdout.write(`  thumb -> ${fetchedThumb}\n`);
		} else if (next.thumb) {
			process.stdout.write(`  thumb -> (kept existing)\n`);
		} else {
			process.stdout.write(`  thumb -> (none)\n`);
		}

		updated.push(next);
	}

	if (!SHOULD_WRITE) {
		console.log("\nDry-run only. Re-run with --write to update news.html");
		return;
	}

	const newArray = formatItemsArray(updated);
	const newFile = newsHtml.slice(0, parsed.arrayStart) + newArray + newsHtml.slice(parsed.arrayEnd);
	await fs.writeFile(NEWS_FILE, newFile, "utf8");
	console.log("\nUpdated news.html ITEMS titles.");
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
