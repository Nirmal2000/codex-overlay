import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCH_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 5;

function decodeDuckDuckGoHref(href) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg") || url.searchParams.get("u");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

function stripTags(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDuckDuckGoHtml(html) {
  const results = [];
  const seen = new Set();
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = blockRe.exec(html)) && results.length < MAX_RESULTS) {
    const url = decodeDuckDuckGoHref(match[1]);
    const title = stripTags(match[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const after = html.slice(match.index, match.index + 1200);
    const snippetMatch = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/i);
    results.push({
      title,
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : "",
    });
  }
  return results;
}

export function formatSearchResults(query, results) {
  if (!results.length) {
    return `No web results for: ${query}`;
  }
  return results
    .map((item, index) => {
      const snippet = item.snippet ? `\n${item.snippet}` : "";
      return `${index + 1}. ${item.title}\n${item.url}${snippet}`;
    })
    .join("\n\n");
}

async function fetchText(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CodexOverlay/1.0",
        Accept: "text/html,application/json",
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function searchDuckDuckGo(query) {
  const body = new URLSearchParams({ q: query, kl: "us-en" });
  const html = await fetchText("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return parseDuckDuckGoHtml(html);
}

async function searchWikipedia(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${MAX_RESULTS}&namespace=0&format=json`;
  const payload = JSON.parse(await fetchText(url, { headers: { Accept: "application/json" } }));
  const titles = payload[1] || [];
  const snippets = payload[2] || [];
  const urls = payload[3] || [];
  return titles.map((title, index) => ({
    title,
    url: urls[index] || "",
    snippet: snippets[index] || "",
  })).filter((item) => item.url);
}

export async function webSearch(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return "Search query was empty.";
  let results = [];
  let error;
  try {
    results = await searchDuckDuckGo(trimmed);
  } catch (caught) {
    error = caught;
  }
  if (!results.length) {
    try {
      results = await searchWikipedia(trimmed);
    } catch (caught) {
      error = error || caught;
    }
  }
  if (!results.length && error) {
    return `Web search failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return formatSearchResults(trimmed, results);
}

export function createWebSearchTool() {
  return defineTool({
    name: "web_search",
    label: "web_search",
    description: "Search the public web for a topic you are not sure about. Use for theory, algorithms, LeetCode, APIs, and current public facts that are not already in the packed notes or screenshots. One search per turn.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: await webSearch(params.query) }],
      details: { query: params.query },
    }),
  });
}
