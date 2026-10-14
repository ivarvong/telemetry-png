#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) throw new Error('usage: TELEMETRY_AUTH_SECRET=... node tools/browser-smoke.mjs <base-url> [run-id] [artifact-dir] [deployment-id]');
const authSecret = process.env.TELEMETRY_AUTH_SECRET;
if (!authSecret) throw new Error('TELEMETRY_AUTH_SECRET is required for authenticated account telemetry smoke tests');
const runId = process.argv[3] ?? `browser-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}`;
const out = process.argv[4] ?? `artifacts/${runId}`;
const expectedDeployment = process.argv[5] ?? null;
const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
let playwright;
for (const candidate of candidates) {
  try { playwright = require(candidate); break; } catch {}
}
if (!playwright) throw new Error(`Playwright not found; set PLAYWRIGHT_PATH (tried ${candidates.join(', ')})`);

await fs.mkdir(out, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, extraHTTPHeaders: { authorization: `Bearer ${authSecret}` } });
const page = await context.newPage();
const consoleErrors = [], pageErrors = [], requestFailures = [], badResponses = [], responses = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
page.on('response', (response) => {
  const row = { url: response.url(), status: response.status(), contentType: response.headers()['content-type'] ?? '' };
  responses.push(row);
  if (response.status() >= 400) badResponses.push(row);
});

const waitIdle = async (timeout = 90_000) => {
  await page.waitForFunction(() => document.querySelector('#traces')?.getAttribute('aria-busy') === 'false', null, { timeout });
  await page.waitForFunction(() => [...document.querySelectorAll('.trace:not(.placeholder) .loading')].every((el) => el.hidden), null, { timeout });
};
const galleryState = () => page.evaluate(() => ({
  status: document.querySelector('#status')?.textContent ?? '',
  cards: document.querySelectorAll('.trace:not(.placeholder)').length,
  moreVisible: !document.querySelector('#more')?.hidden,
  zeroDurationCards: [...document.querySelectorAll('.trace')].filter((el) => [...el.querySelectorAll('.fact')].some((fact) => fact.textContent === '0 ms')).map((el) => el.dataset.id),
  visibleBrokenImages: [...document.images].filter((img) => !img.hidden && (!img.complete || img.naturalWidth === 0)).map((img) => ({ src: img.src, alt: img.alt })),
  cardErrors: [...document.querySelectorAll('.trace .error')].map((el) => el.textContent.trim()).filter(Boolean),
}));

const health = await (await context.request.get(`${base}/health`)).json();
if (expectedDeployment && health.deploymentId !== expectedDeployment) throw new Error(`unexpected deployment ${health.deploymentId}`);
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await waitIdle();
const initial = await galleryState();
await page.screenshot({ path: path.join(out, 'gallery.png'), fullPage: true });

await page.selectOption('#scope', 'observer');
await page.fill('#minutes', '60');
await page.fill('#minSpans', '1');
await page.click('#refresh');
await waitIdle();
const observerBeforeMore = await galleryState();
if (observerBeforeMore.moreVisible) {
  await page.click('#more');
  await waitIdle();
}
const observerAfterMore = await galleryState();
await page.screenshot({ path: path.join(out, 'observer-load-more.png'), fullPage: true });

// Generate through the actual control. The page waits for telemetry ingestion and
// refreshes with the currently selected workload filter.
await page.selectOption('#scope', 'workload');
await page.fill('#minutes', '15');
await page.fill('#minSpans', '3');
await page.click('#generate');
await waitIdle(150_000);
const generated = await galleryState();
await page.screenshot({ path: path.join(out, 'generated-workload.png'), fullPage: true });

// The all-traces set includes platform spans whose measured duration is exactly
// zero. Their query windows are expanded by the server and must still render.
await page.selectOption('#scope', 'all');
await page.fill('#minutes', '60');
await page.fill('#minSpans', '1');
await page.click('#refresh');
await waitIdle();
let zeroDuration = await galleryState();
while (!zeroDuration.zeroDurationCards.length && zeroDuration.moreVisible && zeroDuration.cards < 30) {
  await page.click('#more');
  await waitIdle();
  zeroDuration = await galleryState();
}
await page.screenshot({ path: path.join(out, 'zero-duration.png'), fullPage: true });

// Use the gallery's real scheduler for 19 cache-busted refresh-like requests.
// Its 18/rolling-minute budget must visibly queue and then recover by itself.
await page.evaluate(() => {
  window.__budgetDone = false;
  window.__budgetResult = null;
  Promise.all(Array.from({ length: 19 }, (_, i) => api('/profile/metadata.json?browser-budget-refresh=' + i).then((r) => r.status)))
    .then((statuses) => { window.__budgetResult = statuses; window.__budgetDone = true; }, (error) => { window.__budgetResult = { error: error.message }; window.__budgetDone = true; });
});
let budgetWaitStatus = null;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const state = await page.evaluate(() => ({ done: window.__budgetDone, result: window.__budgetResult, status: document.querySelector('#status')?.textContent ?? '' }));
  if (state.status.includes('Client budget is 18 requests per rolling minute')) budgetWaitStatus = state.status;
  if (state.done) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const budget = await page.evaluate(() => ({ done: window.__budgetDone, result: window.__budgetResult, finalStatus: document.querySelector('#status')?.textContent ?? '' }));
const finalState = await galleryState();

const evidence = {
  runId, checkedAt: new Date().toISOString(), base, health,
  initial, observerBeforeMore, observerAfterMore, generated, zeroDuration,
  budget: { ...budget, observedWaitStatus: budgetWaitStatus }, finalState,
  network: {
    totalResponses: responses.length,
    pngResponses: responses.filter((row) => row.contentType.startsWith('image/png')).length,
    badResponses, requestFailures,
  },
  consoleErrors, pageErrors,
  assertions: {
    deploymentMatches: !expectedDeployment || health.deploymentId === expectedDeployment,
    initialHasCards: initial.cards > 0,
    observerSelectedAndLoaded: observerAfterMore.cards >= observerBeforeMore.cards && responses.some((row) => row.url.includes('/api/traces?') && row.url.includes('scope=observer')),
    loadMoreExercised: observerBeforeMore.moreVisible && observerAfterMore.cards > observerBeforeMore.cards,
    zeroDurationRendered: zeroDuration.zeroDurationCards.length > 0 && zeroDuration.cardErrors.length === 0,
    generatedWorkloadRendered: generated.cards > 0 && generated.status.includes('matches'),
    budgetWaitObserved: Boolean(budgetWaitStatus),
    budgetRecovered: budget.done && Array.isArray(budget.result) && budget.result.length === 19 && budget.result.every((status) => status === 200),
    noBrokenImages: [initial, observerAfterMore, generated, zeroDuration, finalState].every((state) => state.visibleBrokenImages.length === 0),
    noUnhandledErrors: pageErrors.length === 0 && consoleErrors.every((message) => [429, 502, 503, 504].some((status) => message.startsWith('Failed to load resource: the server responded with a status of ' + status))),
  },
};
await fs.writeFile(path.join(out, 'browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
await browser.close();
const failed = Object.entries(evidence.assertions).filter(([, value]) => !value).map(([name]) => name);
console.log(JSON.stringify({ runId, out, assertions: evidence.assertions, failed }));
if (failed.length) process.exitCode = 1;
