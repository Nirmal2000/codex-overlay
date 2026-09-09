import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSearchResults, parseDuckDuckGoHtml } from "./web-search.mjs";

const SAMPLE_HTML = `
<html><body>
<a rel="nofollow" class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fleetcode.com%2Fproblems%2Ftrapping-rain-water-ii">Trapping Rain Water II</a>
<a class="result__snippet" href="#">Given an m x n integer matrix heightMap representing the height of each unit cell in a 2D elevation map.</a>
<a class="result__a" href="https://en.wikipedia.org/wiki/Dijkstra%27s_algorithm">Dijkstra's algorithm</a>
<a class="result__snippet">Dijkstra's algorithm is an algorithm for finding the shortest paths between nodes in a weighted graph.</a>
</body></html>
`;

test("parses DuckDuckGo HTML titles, urls, and snippets", () => {
  const results = parseDuckDuckGoHtml(SAMPLE_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Trapping Rain Water II");
  assert.equal(results[0].url, "https://leetcode.com/problems/trapping-rain-water-ii");
  assert.match(results[0].snippet, /heightMap/);
  assert.equal(results[1].title, "Dijkstra's algorithm");
});

test("formats numbered search results", () => {
  const text = formatSearchResults("dijkstra", [
    { title: "Dijkstra's algorithm", url: "https://en.wikipedia.org/wiki/Dijkstra%27s_algorithm", snippet: "shortest paths" },
  ]);
  assert.match(text, /1\. Dijkstra's algorithm/);
  assert.match(text, /shortest paths/);
});
