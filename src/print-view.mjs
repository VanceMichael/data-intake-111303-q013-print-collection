// Browser-side helpers for the print-view collector.
//
// Playwright serializes these exported functions and runs them inside Chromium.
// They must stay self contained: no imports, no references to module bindings.

/**
 * Installs a DOM render tracker *before* the generate button is pressed.
 *
 * The tracker gives every element inserted or attribute-updated after the click
 * a render epoch greater than the epoch captured at click time.  That is how a
 * cached preview that happened to be rendered before the click (or re-attached
 * from cache afterwards) can be told apart from the freshly generated print
 * document, without sleeping and without trusting a screen summary.
 */
export function installRenderTracker() {
  if (window.__printCollection) {
    return { installed: true, reused: true, epoch: window.__printCollection.epoch };
  }
  const tracker = {
    epoch: 0,
    mutations: 0,
    fontEpoch: 0,
    installedAt: performance.now(),
    lastMutationAt: performance.now(),
    lastFontAt: performance.now(),
    epochs: new WeakMap(),
    attributeEpochs: new WeakMap(),
    // Every print-document insertion is snapshotted here so evidence of
    // rejected previews survives even if they are replaced between polls.
    history: [],
    historyKeys: new Set(),
  };
  window.__printCollection = tracker;

  const documentSelector = '[data-print-document],[data-print-doc],.print-document,.print-doc';

  const identitySnapshot = element => {
    const get = name => element.getAttribute(name);
    const text = (element.innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
    const heading = element.querySelector?.('[data-doc-header],h1,h2,h3');
    const match = (heading?.textContent ?? '').match(/登记\s*([^\s，,]+)\s*修订\s*(\d+)/);
    const pages = [...(element.querySelectorAll?.('[data-page],.print-page') ?? [])]
      .filter(page => !page.parentElement?.closest('[data-page],.print-page'));
    return {
      docId: get('data-doc-id') || null,
      registration: get('data-registration') ?? match?.[1] ?? null,
      revision: get('data-revision') ?? match?.[2] ?? null,
      generation: get('data-generation') ?? null,
      cached: element.hasAttribute('data-cached') || get('data-preview-state') === 'cached' || get('data-cache') === 'true',
      voided: element.hasAttribute('data-void') || element.hasAttribute('data-voided') || get('data-document-state') === 'void',
      composing: get('data-document-state') === 'composing' || get('data-state') === 'composing' || element.hasAttribute('data-composing'),
      pageCount: pages.length,
      text: text.slice(0, 120),
    };
  };

  const recordHistory = element => {
    if (!element.matches?.(documentSelector)) return;
    const snapshot = identitySnapshot(element);
    const key = [snapshot.docId, snapshot.registration, snapshot.revision, snapshot.generation,
      snapshot.cached, snapshot.voided, snapshot.composing, snapshot.pageCount].join('|');
    if (tracker.historyKeys.has(key)) return;
    tracker.historyKeys.add(key);
    if (tracker.history.length < 40) {
      tracker.history.push({ at: Math.round(performance.now() - tracker.installedAt), ...snapshot });
    }
  };
  document.querySelectorAll(documentSelector).forEach(recordHistory);

  const relevantSelector = [
    '#preview', '[data-preview]', '[data-print-preview]', '[data-print-document]',
    '[data-print-doc]', '.print-document', '.print-doc', '.print-page', '[data-page]',
    '[data-line]', '[data-appendix-id]', '[data-appendix]', '[data-registration]', '[data-revision]',
  ].join(',');
  const relevant = node => {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 3)) return false;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || !element.matches) return false;
    if (element.matches(relevantSelector)) return true;
    if (element.closest('#preview,[data-preview],[data-print-document],[data-print-doc],.print-document,.print-doc,.print-page')) return true;
    return Boolean(element.querySelector?.('#preview,[data-print-document],[data-print-doc],.print-document,.print-doc,.print-page,[data-line]'));
  };

  const stampSubtree = (node, epoch) => {
    if (node.nodeType !== 1) return;
    tracker.epochs.set(node, epoch);
    node.querySelectorAll?.('*').forEach(element => tracker.epochs.set(element, epoch));
  };

  const observer = new MutationObserver(records => {
    let changed = false;
    const nextEpoch = tracker.epoch + 1;
    for (const record of records) {
      if (!relevant(record.target)) continue;
      changed = true;
      if (record.type === 'attributes') {
        tracker.attributeEpochs.set(record.target, nextEpoch);
        recordHistory(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        stampSubtree(node, nextEpoch);
        if (node.nodeType === 1) {
          recordHistory(node);
          node.querySelectorAll?.(documentSelector).forEach(recordHistory);
        }
      }
    }
    if (changed) {
      tracker.epoch = nextEpoch;
      tracker.mutations += records.length;
      tracker.lastMutationAt = performance.now();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'class', 'data-state', 'data-preview-state', 'data-document-state', 'data-registration',
      'data-revision', 'data-generation', 'data-page', 'data-line', 'data-void', 'data-cached',
      'data-summary', 'hidden', 'aria-hidden',
    ],
  });

  const noteFont = () => {
    tracker.fontEpoch += 1;
    tracker.lastFontAt = performance.now();
  };
  if (document.fonts) {
    document.fonts.addEventListener?.('loading', noteFont);
    document.fonts.addEventListener?.('loadingdone', noteFont);
    document.fonts.addEventListener?.('loadingerror', noteFont);
  }

  tracker.installed = true;
  return { installed: true, reused: false, epoch: tracker.epoch, tracked: document.querySelectorAll(relevantSelector).length };
}

/**
 * Waits for a print document that belongs to the requested registration and
 * revision and was produced by the generation action that started at
 * `clickEpoch`.
 *
 * Readiness is not a timer.  It is the conjunction of:
 *   - identity: registration/revision on the print document itself (not on a
 *     screen summary), plus generation when the portal exposes one;
 *   - provenance: the document/pages were inserted or updated after the click
 *     and are not marked as a cached preview;
 *   - print visibility: pages have a real box under print media;
 *   - fonts: document.fonts is loaded and no font event fired during the quiet
 *     window;
 *   - layout: page boxes, page count and a content key stay identical for
 *     `stableFrames` consecutive animation frames while no relevant mutation
 *     happened for `quietMs`.
 */
export async function waitForPrintDocument(options) {
  const {
    registration, revision, generation = null, clickEpoch = -1, requireNewerThan = null,
    timeoutMs = 5000, stableFrames = 3, quietMs = 150,
  } = options;
  const tracker = window.__printCollection;
  if (!tracker) return { status: 'error', reason: 'render-tracker-missing' };

  const started = performance.now();
  const deadline = started + timeoutMs;
  const pause = () => new Promise(resolve => { requestAnimationFrame(() => setTimeout(resolve, 10)); });
  const textOf = element => (element?.innerText ?? element?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const isVisible = element => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const documentRoots = () => {
    const explicit = [...document.querySelectorAll('[data-print-document],.print-document,[data-print-doc],.print-doc')];
    if (explicit.length) return explicit;
    const fallback = document.querySelector('#preview,[data-preview]');
    return fallback ? [fallback] : [];
  };

  const identityOf = root => {
    let reg = root.getAttribute('data-registration');
    let rev = root.getAttribute('data-revision');
    if (reg == null || rev == null) {
      const heading = root.querySelector('[data-doc-header],h1,h2,h3') || root;
      const match = textOf(heading).match(/登记\s*([^\s，,]+)\s*修订\s*(\d+)/);
      if (match) {
        if (reg == null) reg = match[1];
        if (rev == null) rev = match[2];
      }
    }
    const gen = root.getAttribute('data-generation');
    return {
      registration: reg,
      revision: rev == null || rev === '' ? null : Number(rev),
      generation: gen == null || gen === '' ? null : Number(gen),
    };
  };

  const freshnessOf = element => {
    let best = -1;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const inserted = tracker.epochs.get(node);
      const updated = tracker.attributeEpochs.get(node);
      if (inserted != null) best = Math.max(best, inserted);
      if (updated != null) best = Math.max(best, updated);
    }
    return best;
  };

  const pagesOf = root => [...root.querySelectorAll('[data-page],.print-page')]
    .filter(page => !(page.parentElement?.closest('[data-page],.print-page')))
    .filter(isVisible);

  const stateOf = root => {
    const own = root.getAttribute('data-document-state') || root.getAttribute('data-state') || '';
    const preview = document.querySelector('#preview,[data-preview]');
    return (own || preview?.getAttribute('data-state') || '').toLowerCase();
  };

  const flagsOf = root => ({
    cached: root.hasAttribute('data-cached') || root.getAttribute('data-preview-state') === 'cached' || root.getAttribute('data-cache') === 'true',
    voided: root.hasAttribute('data-void') || root.getAttribute('data-document-state') === 'void' || root.getAttribute('data-state') === 'void',
    composing: root.getAttribute('data-document-state') === 'composing' || root.getAttribute('data-state') === 'composing' || root.hasAttribute('data-composing'),
    state: stateOf(root),
  });

  const reasonFor = candidate => {
    if (candidate.identity.registration !== registration) return 'registration-mismatch';
    if (candidate.identity.revision !== revision) return 'revision-mismatch';
    if (candidate.flags.voided) return 'voided-document';
    if (candidate.flags.cached) return 'cached-preview';
    if (candidate.flags.composing) return 'document-composing';
    if (!(candidate.freshness > clickEpoch)) return 'not-fresh-after-generate';
    if (!candidate.pageCount) return 'no-print-pages-visible';
    return 'ready-but-unstable';
  };

  const seen = new Map();
  const remember = candidate => {
    const reason = reasonFor(candidate);
    const key = [
      candidate.docId, candidate.identity.registration, candidate.identity.revision,
      candidate.identity.generation, candidate.flags.cached, candidate.flags.voided,
      candidate.pageCount, candidate.freshness, reason,
    ].join('|');
    // Never serialize DOM nodes: Playwright/JSON cannot represent them and
    // evidence files must stay plain data.
    seen.set(key, {
      docId: candidate.docId,
      identity: candidate.identity,
      pageCount: candidate.pageCount,
      freshness: candidate.freshness,
      flags: candidate.flags,
      reason,
    });
  };

  let stableKey = '';
  let stableCount = 0;
  let matched = null;
  let diagnostics = null;

  while (performance.now() < deadline) {
    const preview = document.querySelector('#preview,[data-preview]');
    const previewState = (preview?.getAttribute('data-state') || '').toLowerCase();
    if (previewState === 'failed') {
      return { status: 'failed', reason: 'preview-state-failed', elapsedMs: Math.round(performance.now() - started), candidates: [...seen.values()] };
    }

    const roots = documentRoots();
    const candidates = roots.map((root, index) => {
      const pages = pagesOf(root);
      const rootFreshness = freshnessOf(root);
      const pageFreshness = pages.reduce((best, page) => Math.max(best, freshnessOf(page)), -1);
      const candidate = {
        root,
        docId: root.getAttribute('data-doc-id') || (root.matches('#preview,[data-preview]') ? null : `doc-${index + 1}`),
        identity: identityOf(root),
        pageCount: pages.length,
        freshness: Math.max(rootFreshness, pageFreshness),
        flags: flagsOf(root),
      };
      remember(candidate);
      return candidate;
    });

    matched = candidates.filter(candidate => {
      if (candidate.identity.registration !== registration) return false;
      if (candidate.identity.revision !== revision) return false;
      if (candidate.flags.cached || candidate.flags.voided || candidate.flags.composing || candidate.flags.state === 'void') return false;
      if (requireNewerThan != null && candidate.identity.generation != null && candidate.identity.generation <= requireNewerThan) return false;
      return candidate.freshness > clickEpoch && candidate.pageCount > 0;
    });
    // A regenerated document with the same registration/revision supersedes
    // older documents rendered by the same generation action.  Compare
    // generation ids only among current documents (never as a content source).
    const generations = matched.map(candidate => candidate.identity.generation).filter(value => value != null);
    const newestGeneration = generations.length ? Math.max(...generations) : null;
    if (newestGeneration != null) {
      matched = matched.filter(candidate => candidate.identity.generation == null || candidate.identity.generation === newestGeneration);
    }
    matched.sort((left, right) => {
      const leftGeneration = left.identity.generation ?? -1;
      const rightGeneration = right.identity.generation ?? -1;
      if (leftGeneration !== rightGeneration) return rightGeneration - leftGeneration;
      return right.freshness - left.freshness;
    });
    matched = matched[0] || null;

    if (matched) {
      await document.fonts?.ready;
      const pages = matched.root.querySelectorAll('[data-page],.print-page');
      const geometry = [...pages].map(page => {
        const rect = page.getBoundingClientRect();
        return [page.getAttribute('data-page') || '', Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(':');
      }).join('|');
      const key = [
        matched.docId, matched.identity.registration, matched.identity.revision, matched.identity.generation,
        geometry, Math.round(document.documentElement.scrollHeight), pages.length,
        tracker.epoch, tracker.fontEpoch, document.fonts?.status || 'unknown',
      ].join('#');
      if (key === stableKey) stableCount += 1;
      else { stableKey = key; stableCount = 1; }
      diagnostics = {
        elapsedMs: Math.round(performance.now() - started),
        stableCount,
        stableFrames,
        trackerEpoch: tracker.epoch,
        fontEpoch: tracker.fontEpoch,
        fontStatus: document.fonts?.status || 'unknown',
        mutations: tracker.mutations,
        lastMutationAgeMs: Math.round(performance.now() - tracker.lastMutationAt),
        lastFontAgeMs: Math.round(performance.now() - tracker.lastFontAt),
        pageGeometry: geometry,
      };
      const quiet = performance.now() - tracker.lastMutationAt >= quietMs;
      const fontsQuiet = performance.now() - tracker.lastFontAt >= quietMs;
      if (stableCount >= stableFrames && quiet && fontsQuiet && (document.fonts?.status || 'loaded') === 'loaded') {
        return {
          status: 'ready',
          docId: matched.docId,
          identity: matched.identity,
          pageCount: matched.pageCount,
          freshness: matched.freshness,
          elapsedMs: Math.round(performance.now() - started),
          diagnostics,
          candidates: [...seen.values()],
          history: [...(tracker.history ?? [])],
        };
      }
    }

    await pause();
  }

  return {
    status: matched ? 'unstable' : 'no-current-document',
    reason: matched ? 'layout-not-stable' : 'no-matching-print-document',
    elapsedMs: Math.round(performance.now() - started),
    diagnostics,
    candidates: [...seen.values()],
    history: [...(tracker.history ?? [])],
  };
}

/**
 * Lightweight page state used only for diagnostics when generation fails.
 * It never feeds registration fields and never replaces DOM collection.
 */
export function describePreviewState() {
  const preview = document.querySelector('#preview,[data-preview]');
  const relevant = document.querySelectorAll('[data-print-document],.print-document,[data-page],.print-page,[data-line]');
  const visible = [...relevant].filter(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  });
  return {
    previewState: preview?.getAttribute('data-state') || null,
    previewRevision: preview?.getAttribute('data-revision') || null,
    previewRegistration: preview?.getAttribute('data-registration') || null,
    previewGeneration: preview?.getAttribute('data-generation') || null,
    printDocumentCount: document.querySelectorAll('[data-print-document],.print-document').length,
    visiblePageCount: [...document.querySelectorAll('[data-page],.print-page')].filter(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }).length,
    visibleRelevantCount: visible.length,
    screenOnlySummary: document.querySelector('#preview .screen-only,[data-preview] .screen-only')?.innerText?.trim() || null,
    fonts: { status: document.fonts?.status || 'unknown', size: document.fonts?.size ?? null },
    tracker: window.__printCollection ? {
      epoch: window.__printCollection.epoch,
      mutations: window.__printCollection.mutations,
      fontEpoch: window.__printCollection.fontEpoch,
    } : null,
  };
}
