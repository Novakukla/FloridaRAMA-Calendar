#!/usr/bin/env node
/**
 * Syncs events.json from FareHarbor's public embed pages.
 *
 * This is intentionally "no-API-key" and conservative:
 * - It scrapes the public items listing page and each item's page.
 * - For each item, it grabs the NEXT visible availability date (the "Prices for ..." link).
 * - It generates one calendar entry per item (next occurrence).
 *
 * Usage (from repo root):
 *   node scripts/sync_fareharbor_events.mjs           (dry run)
 *   node scripts/sync_fareharbor_events.mjs --write   (update events.json)
 *
 * By default, --write OVERWRITES the target file so it matches FareHarbor exactly.
 * If you need to preserve non-FareHarbor/manual events, opt-in with:
 *   node scripts/sync_fareharbor_events.mjs --write --merge-existing
 *
 * Targeting a different events.json (CI / worktrees):
 *   node scripts/sync_fareharbor_events.mjs --browser --write --events-file path/to/events.json
 *
 * Optional env:
 *   FAREHARBOR_COMPANY=floridarama
 *   FAREHARBOR_FLOW=1415736
 *   FAREHARBOR_TZ=America/New_York
 *   EVENTS_FILE=path/to/events.json
 */

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SHOULD_WRITE = process.argv.includes("--write");
const MERGE_EXISTING = process.argv.includes("--merge-existing") || process.env.MERGE_EXISTING === "1";

const COMPANY = process.env.FAREHARBOR_COMPANY || "floridarama";
const FLOW = process.env.FAREHARBOR_FLOW || "1438415";
const TIME_ZONE = process.env.FAREHARBOR_TZ || "America/New_York";

function getArgValue(flag) {
	const i = process.argv.indexOf(flag);
	if (i === -1) return null;
	const v = process.argv[i + 1];
	if (!v || v.startsWith("--")) return null;
	return v;
}

const DEFAULT_EVENTS_FILE = fileURLToPath(
	new URL("../events.json", import.meta.url)
);
const EVENTS_FILE = getArgValue("--events-file") || process.env.EVENTS_FILE || DEFAULT_EVENTS_FILE;

const USE_PLAYWRIGHT =
	process.argv.includes("--browser") ||
	process.env.USE_PLAYWRIGHT === "1" ||
	process.env.CI === "true";

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
		.replaceAll(/\s+/g, " ")
		.trim();
}

function extractMetaContent(html, attrName, attrValue) {
	const re = new RegExp(
		`<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["'][^>]*>`,
		"i"
	);
	const m = html.match(re);
	return m ? decodeHtmlEntities(m[1]) : null;
}

function extractTitleFromHtml(html) {
	// Prefer <h1>, else <title>, else og:title.
	const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
	if (h1) return decodeHtmlEntities(h1[1].replaceAll(/<[^>]+>/g, " "));

	const og = extractMetaContent(html, "property", "og:title") || extractMetaContent(html, "name", "og:title");
	if (og) return og;

	const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (t) return decodeHtmlEntities(t[1]);

	return null;
}

function extractBestImageFromHtml(html, pageUrl) {
	const og =
		extractMetaContent(html, "property", "og:image") ||
		extractMetaContent(html, "name", "og:image") ||
		extractMetaContent(html, "property", "twitter:image") ||
		extractMetaContent(html, "name", "twitter:image");
	if (!og) return null;
	try {
		return new URL(og, pageUrl).toString();
	} catch {
		return null;
	}
}

function todayYmdInTimeZone(timeZone) {
	// en-CA gives YYYY-MM-DD
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
}

function parsePricesForAnchor(html) {
	// Example HTML pattern (approx):
	// Prices for <a href=".../availability/1770373765/book/?...">Saturday, January 31, 2026</a>
	const m = html.match(
		/Prices\s+for\s*<a[^>]+href=["']([^"']*\/availability\/\d+\/book\/[^"']*)["'][^>]*>([^<]+)<\/a>/i
	);
	if (!m) return null;
	return { availabilityUrl: m[1], dateLabel: decodeHtmlEntities(m[2]) };
}

function parseDateLabelToYmd(dateLabel) {
	// Expected: "Saturday, January 31, 2026" (weekday optional)
	const text = String(dateLabel).trim();
	const m = text.match(/(?:\w+\s*,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
	if (!m) return null;
	const [, monthName, dayStr, yearStr] = m;

	const monthIndex = [
		"january",
		"february",
		"march",
		"april",
		"may",
		"june",
		"july",
		"august",
		"september",
		"october",
		"november",
		"december",
	].indexOf(monthName.toLowerCase());
	if (monthIndex === -1) return null;

	const year = Number(yearStr);
	const day = Number(dayStr);
	const month = monthIndex + 1;

	const y = String(year).padStart(4, "0");
	const mo = String(month).padStart(2, "0");
	const d = String(day).padStart(2, "0");
	return `${y}-${mo}-${d}`;
}

function parseEventTimeRange(html) {
	// Look for "Event is 10AM - 12PM" (minutes optional)
	const m = html.match(
		/Event\s+is\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i
	);
	if (!m) return null;
	const [, sh, sm, sap, eh, em, eap] = m;
	return {
		start: { h: Number(sh), m: Number(sm || "0"), ap: sap.toUpperCase() },
		end: { h: Number(eh), m: Number(em || "0"), ap: eap.toUpperCase() },
	};
}

function to24Hour({ h, m, ap }) {
	let hour = h % 12;
	if (ap === "PM") hour += 12;
	return { hour, minute: m };
}

function ymdAndTimeToIsoLocal(ymd, hour, minute) {
	const hh = String(hour).padStart(2, "0");
	const mm = String(minute).padStart(2, "0");
	return `${ymd}T${hh}:${mm}:00`;
}

async function fetchHtml(url) {
	const res = await fetch(url, {
		redirect: "follow",
		headers: {
			"user-agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
			accept: "text/html,application/xhtml+xml",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return await res.text();
}

async function withPlaywright(fn) {
	let pw;
	try {
		pw = await import("playwright");
	} catch (err) {
		throw new Error(
			"Playwright is not installed. Run `npm install` at repo root, or run without --browser."
		);
	}

	const browser = await pw.chromium.launch({ headless: true });
	const context = await browser.newContext();
	try {
		return await fn({ browser, context });
	} finally {
		await context.close().catch(() => {});
		await browser.close().catch(() => {});
	}
}

async function getItemUrlsFromListing(listingUrl) {
	// Try plain HTML first.
	const listingHtml = await fetchHtml(listingUrl);
	let itemUrls = extractItemUrlsFromItemsListing(listingHtml)
		.map(normalizeFareharborUrl)
		.filter((u) => u.includes(`/embeds/book/${COMPANY}/items/`));

	if (itemUrls.length > 0 && !USE_PLAYWRIGHT) {
		return { itemUrls: [...new Set(itemUrls)], usedBrowser: false };
	}

	// FareHarbor often renders the item cards via JS; fall back to a headless browser.
	return await withPlaywright(async ({ context }) => {
		const page = await context.newPage();
		try {
			await page.goto(listingUrl, { waitUntil: "domcontentloaded" });
			await page.waitForTimeout(1500);
			await page.waitForLoadState("networkidle").catch(() => {});

			const abs = await page.evaluate((company) => {
				const hrefs = Array.from(document.querySelectorAll('a[href*="/items/"]'))
					.map((a) => a.getAttribute("href"))
					.filter(Boolean);

				const out = [];
				for (const h of hrefs) {
					try {
						const u = new URL(h, "https://fareharbor.com");
						if (!u.pathname.includes(`/embeds/book/${company}/items/`)) continue;
						if (!/\/items\/\d+\/?/i.test(u.pathname)) continue;
						out.push(u.toString());
					} catch {
						// ignore
					}
				}
				return out;
			}, COMPANY);

			itemUrls = [...new Set(abs)];
			return { itemUrls, usedBrowser: true };
		} finally {
			await page.close().catch(() => {});
		}
	});
}

async function scrapeItemViaPlaywright(context, itemUrl) {
	const page = await context.newPage();
	try {
		await page.goto(itemUrl, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(1500);
		await page.waitForLoadState("networkidle").catch(() => {});

		// Wait a bit for template placeholders to resolve.
		await page
			.waitForFunction(() => {
				const h1 = document.querySelector("h1");
				const t = (h1?.textContent || "").trim();
				return t && !/\[!\s*item\.name\s*!\]/i.test(t);
			}, { timeout: 10_000 })
			.catch(() => {});

		const dom = await page.evaluate(() => {
			const h1 = document.querySelector("h1");
			const title = (h1?.textContent || document.title || "").trim();

			const meta = (name, value) => {
				const sel = `meta[${name}="${value}"]`;
				return document.querySelector(sel)?.getAttribute("content") || null;
			};

			const thumbnail =
				meta("property", "og:image") ||
				meta("name", "og:image") ||
				meta("name", "twitter:image") ||
				meta("property", "twitter:image");

			// Pick the first visible availability link.
			const links = Array.from(document.querySelectorAll("a"));
			const a = links.find((x) => {
				const href = x.getAttribute("href") || "";
				const txt = (x.textContent || "").trim();
				return /\/availability\/\d+\/book\//i.test(href) && /\d{4}/.test(txt);
			});

			const availabilityUrl = a ? a.getAttribute("href") : null;
			const dateLabel = a ? (a.textContent || "").trim() : null;

			const bodyText = document.body?.innerText || "";
			return { title, thumbnail, availabilityUrl, dateLabel, bodyText };
		});

		return dom;
	} finally {
		await page.close().catch(() => {});
	}
}

function extractItemUrlsFromItemsListing(html) {
	const urls = new Set();
	for (const m of html.matchAll(/https:\/\/fareharbor\.com\/embeds\/book\/[^\s"']+\/items\/\d+\/?[^"'\s<]*/gi)) {
		urls.add(m[0]);
	}
	// Also accept relative links.
	for (const m of html.matchAll(/href=["'](\/embeds\/book\/[\w-]+\/items\/\d+\/?[^"']*)["']/gi)) {
		try {
			urls.add(new URL(m[1], "https://fareharbor.com").toString());
		} catch {
			// ignore
		}
	}
	return [...urls];
}

function normalizeFareharborUrl(url) {
	// Ensure full URL, and keep full-items+flow query if present.
	try {
		return new URL(url, "https://fareharbor.com").toString();
	} catch {
		return url;
	}
}

function isFareharborEvent(e) {
	try {
		const u = new URL(e.url);
		return u.hostname.includes("fareharbor.com") && u.pathname.includes(`/embeds/book/${COMPANY}/items/`);
	} catch {
		return false;
	}
}

async function main() {
	const listingUrl = `https://fareharbor.com/embeds/book/${COMPANY}/items/?flow=${encodeURIComponent(FLOW)}&full-items=yes`;
	console.log(`Fetching items listing: ${listingUrl}`);

	const { itemUrls, usedBrowser } = await getItemUrlsFromListing(listingUrl);
	const uniqueItemUrls = itemUrls.slice(0, 50);
	console.log(`Found ${uniqueItemUrls.length} item link(s).${usedBrowser ? " (via browser render)" : ""}`);

	let keep = [];
	if (MERGE_EXISTING) {
		let existing = [];
		try {
			existing = JSON.parse(await fs.readFile(EVENTS_FILE, "utf8"));
			if (!Array.isArray(existing)) existing = [];
		} catch {
			existing = [];
		}
		keep = existing.filter((e) => !isFareharborEvent(e));
		console.log(`Merging: keeping ${keep.length} non-FareHarbor event(s) from existing file.`);
	} else {
		console.log("Overwrite mode: output will match FareHarbor booking flow exactly.");
	}
	const scraped = [];

	if (!USE_PLAYWRIGHT) {
		for (let i = 0; i < uniqueItemUrls.length; i++) {
			const itemUrl = uniqueItemUrls[i];
			console.log(`\n[${i + 1}/${uniqueItemUrls.length}] Fetching item: ${itemUrl}`);

			let html;
			try {
				html = await fetchHtml(itemUrl);
			} catch (err) {
				console.warn(`  Skipping (fetch failed): ${err?.message || err}`);
				continue;
			}

			const title = extractTitleFromHtml(html);
			const thumbnail = extractBestImageFromHtml(html, itemUrl);
			const prices = parsePricesForAnchor(html);
			if (!prices) {
				console.warn("  No availability found; skipping.");
				continue;
			}

			const ymd = parseDateLabelToYmd(prices.dateLabel);
			if (!ymd) {
				console.warn(`  Could not parse date from: ${prices.dateLabel}`);
				continue;
			}

			const tr = parseEventTimeRange(html);
			let startIso;
			let endIso;
			if (tr) {
				const s = to24Hour(tr.start);
				const e = to24Hour(tr.end);
				startIso = ymdAndTimeToIsoLocal(ymd, s.hour, s.minute);
				endIso = ymdAndTimeToIsoLocal(ymd, e.hour, e.minute);
			} else {
				startIso = ymdAndTimeToIsoLocal(ymd, 10, 0);
				endIso = ymdAndTimeToIsoLocal(ymd, 20, 0);
			}

			const availabilityUrl = normalizeFareharborUrl(prices.availabilityUrl);
			scraped.push({
				title: title || "Untitled Event",
				start: startIso,
				end: endIso,
				url: availabilityUrl,
				thumbnail: thumbnail || undefined,
			});

			await sleep(250);
		}
	} else {
		await withPlaywright(async ({ context }) => {
			for (let i = 0; i < uniqueItemUrls.length; i++) {
				const itemUrl = uniqueItemUrls[i];
				console.log(`\n[${i + 1}/${uniqueItemUrls.length}] Fetching item: ${itemUrl}`);

				let dom;
				try {
					dom = await scrapeItemViaPlaywright(context, itemUrl);
				} catch (err) {
					console.warn(`  Skipping (fetch failed): ${err?.message || err}`);
					continue;
				}

				if (!dom?.availabilityUrl || !dom?.dateLabel) {
					console.warn("  No availability link found; skipping.");
					continue;
				}

				const ymd = parseDateLabelToYmd(dom.dateLabel);
				if (!ymd) {
					console.warn(`  Could not parse date from: ${dom.dateLabel}`);
					continue;
				}

				const tr = parseEventTimeRange(dom.bodyText || "");
				let startIso;
				let endIso;
				if (tr) {
					const s = to24Hour(tr.start);
					const e = to24Hour(tr.end);
					startIso = ymdAndTimeToIsoLocal(ymd, s.hour, s.minute);
					endIso = ymdAndTimeToIsoLocal(ymd, e.hour, e.minute);
				} else {
					startIso = ymdAndTimeToIsoLocal(ymd, 10, 0);
					endIso = ymdAndTimeToIsoLocal(ymd, 20, 0);
				}

				const availabilityUrl = normalizeFareharborUrl(dom.availabilityUrl);
				scraped.push({
					title: dom.title || "Untitled Event",
					start: startIso,
					end: endIso,
					url: availabilityUrl,
					thumbnail: dom.thumbnail || undefined,
				});

				await sleep(250);
			}
		});
	}

	// Remove undefined fields and obvious duplicates
	const byKey = new Map();
	for (const e of scraped) {
		const clean = {
			title: e.title,
			start: e.start,
			end: e.end,
			url: e.url,
		};
		if (e.thumbnail) clean.thumbnail = e.thumbnail;

		const key = `${clean.url}::${clean.start}`;
		if (!byKey.has(key)) byKey.set(key, clean);
	}

	const todayYmd = todayYmdInTimeZone(TIME_ZONE);
	const out = [...keep, ...byKey.values()].filter((e) => {
		// Keep the "kept" non-FareHarbor events as-is; filter FareHarbor events by date.
		if (keep.length && !isFareharborEvent(e)) return true;
		const endYmd = String(e.end || e.start || "").slice(0, 10);
		return endYmd && endYmd >= todayYmd;
	});

	out.sort((a, b) => String(a.start).localeCompare(String(b.start)));

	if (!SHOULD_WRITE) {
		console.log(`\nDry-run: would write ${out.length} event(s) to ${EVENTS_FILE}.`);
		console.log("First few:");
		for (const e of out.slice(0, 5)) {
			console.log(`- ${e.start} ${e.title}`);
		}
		return;
	}

	await fs.writeFile(EVENTS_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
	console.log(`\nWrote ${out.length} event(s) to ${EVENTS_FILE}`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
