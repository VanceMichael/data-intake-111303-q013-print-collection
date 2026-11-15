// Real-browser print-view collector.
//
// The collector never shells out to a JSON export, never sleeps before taking
// a screenshot, and never reads the portal's internal state.  It:
//   1. opens the real portal in Chromium,
//   2. installs a DOM/font render tracker before pressing generate,
//   3. invokes the generate action through the page and captures the moment,
//   4. waits for a print document whose identity (registration/revision) is the
//      requested one *and* whose pages were produced after the click,
//   5. extracts print-media content from that document, retrying if layout
//      shifts between reads.
import { chromium } from 'playwright';
import { installRenderTracker, waitForPrintDocument, describePreviewState } from './print-view.mjs';
import { extractPrintDocument } from './print-extract.mjs';

const DEFAULT_OPTIONS = {
  headless: true,
  path: '/portal',
  generateSelector: null,
  timeoutMs: 7000,
  readyTimeoutMs: 6000,
  generationTimeoutMs: 5000,
  extractionAttempts: 3,
  stableFrames: 3,
  quietMs: 150,
  viewport: { width: 1280, height: 1600 },
  locale: 'zh-CN',
  userAgent: 'print-collection/1.0 (real-browser)',
};

const GENERATE_SELECTORS = [
  '#generate',
  '[data-action="generate"]',
  '[data-generate]',
  'button[data-role="generate"]',
  'button:has-text("生成打印件")',
  'button:has-text("生成打印")',
  'button:has-text("生成")',
];

function nowIso() {
  return new Date().toISOString();
}

/**
 * Opens the portal, invokes generation through the page, and returns a raw
 * collection attempt.  Exceptions are reported as structured failures.
 */
export async function collectFromPortal({ source, input, options = {} }) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const startedAt = Date.now();
  const registration = String(input.registration);
  const revision = Number(input.revision);
  if (!registration || !Number.isFinite(revision)) {
    return failure('invalid-input', { registration: registration || null, revision: revision ?? null }, startedAt);
  }

  let browser;
  const evidence = {
    source,
    startedAt: nowIso(),
    steps: [],
    requests: [],
    console: [],
    pageErrors: [],
  };
  const step = (name, detail = {}) => evidence.steps.push({ name, at: nowIso(), elapsedMs: Date.now() - startedAt, ...detail });

  try {
    browser = await chromium.launch({ headless: config.headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      viewport: config.viewport,
      locale: config.locale,
      userAgent: config.userAgent,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on('console', message => {
      if (evidence.console.length < 50) evidence.console.push({ type: message.type(), text: message.text().slice(0, 400) });
    });
    page.on('pageerror', error => evidence.pageErrors.push(error.message.slice(0, 400)));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === new URL(source).origin) evidence.requests.push({ method: request.method(), path: url.pathname + url.search });
    });

    step('portal-open');
    const navigation = await page.goto(source + config.path, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    if (!navigation || !navigation.ok()) {
      step('portal-failed', { status: navigation?.status() ?? null });
      return failure('portal-unavailable', { status: navigation?.status() ?? null }, startedAt, evidence);
    }
    await page.waitForSelector('#app, #generate, [data-action="generate"], [data-generate]', { state: 'attached', timeout: config.readyTimeoutMs });
    await page.evaluate(() => document.fonts?.ready);
    step('portal-ready');

    // The generate affordance is a screen control (it may itself be hidden by
    // print styles), so the tracker is installed and the click performed in
    // screen media.  Print media is enabled only for reading the result.
    const tracker = await page.evaluate(installRenderTracker);
    step('render-tracker-installed', tracker);

    const generate = await findGenerateControl(page, config.generateSelector);
    if (!generate) {
      step('generate-control-missing');
      return failure('generate-control-missing', {}, startedAt, evidence);
    }
    evidence.generateControl = generate.description;

    const clickEpoch = await page.evaluate(() => {
      const value = window.__printCollection?.epoch ?? 0;
      window.__printCollection.markedAt = performance.now();
      return value;
    });
    step('generate-click', { selector: generate.selector, clickEpoch });

    // Perform the click as a real user gesture so the portal's own handlers run
    // exactly as they would for a staff member.
    await page.locator(generate.selector).nth(generate.index).click({ timeout: config.readyTimeoutMs });
    evidence.clickAt = nowIso();

    // From here on, everything is judged in print media: this hides
    // `.screen-only` and reveals `.print-page` content.
    await page.emulateMedia({ media: 'print' });
    step('print-media-emulated');

    // The portal may eventually expose a generation id; it is only used to
    // disambiguate ordering, never as content.  Reading it must not delay the
    // readiness gate, otherwise early candidates (cached/stale/composing)
    // would have already been replaced and become invisible in the evidence.
    // The first generation read is therefore a short, non-blocking hint; the
    // gate itself does not need it.
    const generationId = await readGenerationHint(page, { ...config, generationTimeoutMs: 120 });

    let readiness = await waitReady(page, config, { registration, revision, generationId, clickEpoch });
    evidence.readiness = readiness;
    step('print-document-wait', {
      status: readiness.status,
      elapsedMs: readiness.elapsedMs,
      stableCount: readiness.diagnostics?.stableCount ?? null,
      candidates: readiness.candidates?.length ?? 0,
    });

    // Optional regeneration check: press generate a second time and require a
    // *newer* print document.  This proves the collector re-reads the live
    // result rather than reusing the first preview.
    let secondClickEpoch = null;
    let secondGeneration = null;
    if (readiness.status === 'ready' && config.regenerate) {
      const firstRun = await extractWithRetries(page, config, {
        registration,
        revision,
        generationId,
        clickEpoch,
      });
      evidence.firstPass = summarize(firstRun);
      step('regenerate', { firstDocument: firstRun.document?.id ?? null, firstPages: firstRun.document?.pageCount ?? null });
      if (firstRun.status !== 'collected') {
        step('regenerate-first-pass-failed', { status: firstRun.status });
        return failure('print-document-lost-before-regeneration', { extraction: firstRun }, startedAt, evidence);
      }
      // Second press: the portal must associate it with a new generation id.
      // The control itself is screen-only, so a real user gesture is made under
      // screen media and print media is restored for reading.
      await page.emulateMedia({ media: 'screen' });
      secondClickEpoch = await page.evaluate(() => window.__printCollection?.epoch ?? 0);
      await page.locator(generate.selector).nth(generate.index).click({ timeout: config.readyTimeoutMs });
      await page.evaluate(() => document.fonts?.ready);
      await page.emulateMedia({ media: 'print' });
      secondGeneration = await readGenerationHint(page, { ...config, generationTimeoutMs: Math.min(1200, config.generationTimeoutMs) });
      readiness = await waitReady(page, config, {
        registration,
        revision,
        generationId: null,
        clickEpoch: secondClickEpoch,
        requireNewerThan: firstRun.document?.generation ?? null,
      });
      // The accepted document carries the authoritative generation id; the
      // hint read is only used to pick among simultaneous documents.
      secondGeneration = readiness.identity?.generation ?? secondGeneration;
      evidence.regeneratedAt = nowIso();
      evidence.regeneration = {
        firstAttempt: summarize(firstRun),
        secondClickEpoch,
        secondGeneration,
        readiness: { status: readiness.status, reason: readiness.reason ?? null, candidates: readiness.candidates ?? [] },
      };
      step('regenerate-wait', { status: readiness.status, generation: readiness.identity?.generation ?? null });
    }

    if (readiness.status !== 'ready') {
      const previewState = await page.evaluate(describePreviewState).catch(error => ({ error: error.message }));
      evidence.previewState = previewState;
      const reason = readiness.status === 'failed' ? 'generation-failed'
        : readiness.reason === 'no-matching-print-document' ? 'no-current-print-document'
          : readiness.reason || 'print-document-not-ready';
      step('print-document-unavailable', { status: readiness.status, reason });
      return failure(reason, {
        readiness: {
          status: readiness.status,
          reason: readiness.reason ?? null,
          elapsedMs: readiness.elapsedMs ?? null,
          candidates: readiness.candidates ?? [],
          diagnostics: readiness.diagnostics ?? null,
        },
        previewState,
      }, startedAt, evidence);
    }

    // A generation id read from the page *after* readiness is only used to
    // pick among several current-revision documents; content itself never
    // comes from the hint.
    const extraction = await extractWithRetries(page, config, {
      registration,
      revision,
      generationId: secondGeneration ?? generationId,
      clickEpoch: secondClickEpoch ?? clickEpoch,
    });
    evidence.extraction = extraction;
    if (extraction.status !== 'collected') {
      step('extract-unavailable', { status: extraction.status });
      return failure('print-document-lost-before-extraction', { extraction }, startedAt, evidence);
    }
    if (!extraction.layoutStable) {
      step('extract-unstable');
      return failure('print-document-unstable', { extraction: summarize(extraction) }, startedAt, evidence);
    }
    if (config.regenerate) {
      // The regenerated document must be the one we read.
      const firstExtraction = evidence.firstPass;
      if (firstExtraction?.document?.generation != null && extraction.document?.generation != null
        && extraction.document.generation <= firstExtraction.document.generation) {
        step('regenerate-not-newer', { first: firstExtraction.document.generation, second: extraction.document.generation });
        return failure('regenerate-returned-same-document', {
          first: firstExtraction.document, second: extraction.document,
        }, startedAt, evidence);
      }
    }

    // The read is only accepted when the observable print geometry is still
    // the same after extraction as before it (checked inside the page too).
    evidence.verifiedAt = nowIso();
    step('collected', {
      ids: extraction.ids,
      documents: extraction.counts.documents,
      pages: extraction.counts.pages,
      lines: extraction.counts.lines,
      appendices: extraction.counts.appendices,
      complete: extraction.complete,
    });
    return {
      state: extraction.complete ? 'collected' : 'incomplete',
      ...extraction,
      elapsedMs: Date.now() - startedAt,
      evidence: {
        ...evidence,
        finishedAt: nowIso(),
        elapsedMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    step('exception', { message: error.message });
    return failure('collection-error', { message: error.message }, startedAt, evidence);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function waitReady(page, config, options) {
  return page.evaluate(waitForPrintDocument, {
    registration: options.registration,
    revision: options.revision,
    generation: options.generationId ?? null,
    clickEpoch: options.clickEpoch,
    requireNewerThan: options.requireNewerThan ?? null,
    timeoutMs: config.readyTimeoutMs,
    stableFrames: config.stableFrames,
    quietMs: config.quietMs,
  });
}

async function extractWithRetries(page, config, options) {
  let extraction;
  for (let attempt = 1; attempt <= config.extractionAttempts; attempt += 1) {
    extraction = await page.evaluate(extractPrintDocument, {
      registration: options.registration,
      revision: options.revision,
      generation: options.generationId ?? null,
      clickEpoch: options.clickEpoch,
      includeSecondaryDocuments: true,
    });
    if (extraction.status !== 'collected') return extraction;
    if (extraction.layoutStable) return extraction;
    // Layout moved while reading: wait for the tracked DOM to settle and re-run
    // the readiness gate rather than accepting a torn read.
    await page.evaluate(waitForPrintDocument, {
      registration: options.registration,
      revision: options.revision,
      generation: options.generationId ?? null,
      clickEpoch: options.clickEpoch,
      timeoutMs: 1500,
      stableFrames: config.stableFrames,
      quietMs: config.quietMs,
    });
  }
  return extraction;
}

async function findGenerateControl(page, preferred) {
  const selectors = preferred ? [preferred, ...GENERATE_SELECTORS] : GENERATE_SELECTORS;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (!count) continue;
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (!(await candidate.isEnabled().catch(() => false))) continue;
      return { selector, index, description: { selector, index, text: (await candidate.innerText().catch(() => '')).slice(0, 80) } };
    }
  }
  return null;
}

/**
 * Reads a generation hint the portal may publish after the action.  This is
 * strictly an ordering/disambiguation aid (never content).  It is intentionally
 * tolerant: a portal without hints simply returns null.
 */
async function readGenerationHint(page, config) {  try {
    const hinted = await page.evaluate(async timeoutMs => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const preview = document.querySelector('#preview,[data-preview]');
        const raw = preview?.getAttribute('data-generation')
          ?? document.querySelector('[data-print-document],[data-print-doc],.print-document')?.getAttribute('data-generation')
          ?? null;
        if (raw != null && raw !== '') {
          const parsed = Number(String(raw).replace(/[^\d.-]/g, ''));
          if (Number.isFinite(parsed)) return parsed;
        }
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
      }
      return null;
    }, Math.min(800, config.generationTimeoutMs));
    return hinted;
  } catch {
    return null;
  }
}

function summarize(extraction) {
  return {
    status: extraction.status,
    document: extraction.document ?? null,
    complete: extraction.complete,
    layoutStable: extraction.layoutStable,
    counts: extraction.counts,
    ids: extraction.ids,
    anomalies: extraction.anomalies,
  };
}

function failure(reason, detail = {}, startedAt, evidence = null) {
  return {
    state: 'unavailable',
    reason,
    ids: [],
    registration: detail.registration ?? null,
    revision: detail.revision ?? null,
    detail,
    elapsedMs: Date.now() - startedAt,
    evidence: evidence ? { ...evidence, finishedAt: nowIso(), elapsedMs: Date.now() - startedAt } : undefined,
  };
}
