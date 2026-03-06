const fs = require('fs');
const https = require('https');
const http = require('http');

const feeds = JSON.parse(fs.readFileSync('./feeds.json', 'utf-8'));

const TIMEOUT = 15000;
const CONCURRENCY = 10;

function fetchUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const start = Date.now();
    const req = client.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0 RSS Reader' } }, (res) => {
      let data = '';
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve);
      }
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, size: data.length, time: Date.now() - start, error: null, data });
      });
    });
    req.on('error', (err) => resolve({ status: 0, size: 0, time: Date.now() - start, error: err.message, data: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, size: 0, time: TIMEOUT, error: 'TIMEOUT', data: '' }); });
  });
}

function extractItemCount(data) {
  const itemMatches = data.match(/<item[\s>]/gi) || [];
  const entryMatches = data.match(/<entry[\s>]/gi) || [];
  return Math.max(itemMatches.length, entryMatches.length);
}

function extractTitle(data) {
  const match = data.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
  return match ? match[1].trim().substring(0, 50) : '-';
}

async function runBatch(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function main() {
  console.log(`Testing ${feeds.length} RSS feeds (concurrency: ${CONCURRENCY}, timeout: ${TIMEOUT}ms)\n`);

  const tasks = feeds.map((feed, i) => async () => {
    const result = await fetchUrl(feed.url);
    const items = result.data ? extractItemCount(result.data) : 0;
    const title = result.data ? extractTitle(result.data) : '-';
    const statusIcon = result.status === 200 && items > 0 ? '✅' : result.status === 200 ? '⚠️' : '❌';
    console.log(`${statusIcon} [${String(i).padStart(2)}] ${feed.id.padEnd(25)} | HTTP ${String(result.status).padStart(3)} | ${String(items).padStart(3)} items | ${String(result.time).padStart(5)}ms | ${result.error || title}`);
    return { feed, result, items };
  });

  const results = await runBatch(tasks, CONCURRENCY);

  // Summary
  const ok = results.filter(r => r.result.status === 200 && r.items > 0);
  const noItems = results.filter(r => r.result.status === 200 && r.items === 0);
  const failed = results.filter(r => r.result.status !== 200);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SUMMARY: ${ok.length} OK | ${noItems.length} OK but 0 items | ${failed.length} Failed | Total: ${feeds.length}`);

  if (noItems.length > 0) {
    console.log(`\n⚠️  OK but 0 items:`);
    noItems.forEach(r => console.log(`   - ${r.feed.id}: ${r.feed.url}`));
  }
  if (failed.length > 0) {
    console.log(`\n❌ Failed:`);
    failed.forEach(r => console.log(`   - ${r.feed.id} (HTTP ${r.result.status}${r.result.error ? ', ' + r.result.error : ''}): ${r.feed.url}`));
  }

  // Category breakdown
  const catStats = {};
  results.forEach(r => {
    const cat = r.feed.category;
    if (!catStats[cat]) catStats[cat] = { ok: 0, warn: 0, fail: 0 };
    if (r.result.status === 200 && r.items > 0) catStats[cat].ok++;
    else if (r.result.status === 200) catStats[cat].warn++;
    else catStats[cat].fail++;
  });
  console.log(`\nBy category:`);
  Object.entries(catStats).forEach(([cat, s]) => {
    console.log(`   ${cat}: ${s.ok} ok, ${s.warn} warn, ${s.fail} fail`);
  });
}

main().catch(console.error);
