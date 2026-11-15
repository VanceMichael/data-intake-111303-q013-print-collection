// Browser-side extraction of structured content from a matched print document.
//
// Playwright serializes this exported function and runs it inside Chromium, so
// everything it needs is declared inside it.  The function never returns the
// page's screen summary; it reads a clone of the print document with print
// media active and classifies page furniture instead of folding it into fields.
export function extractPrintDocument(options) {
  const {
    registration, revision, generation = null, clickEpoch = -1,
    includeSecondaryDocuments = true,
  } = options;
  const tracker = window.__printCollection;

  // ---------------------------------------------------------------------------
  // Small helpers (kept inside for serialization)
  // ---------------------------------------------------------------------------
  const textOf = element => (element?.innerText ?? element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const textOfDirect = element => (element?.innerText ?? element?.textContent ?? '').replace(/\r/g, '');
  const attr = (element, names) => {
    for (const name of names) {
      const value = element.getAttribute?.(name);
      if (value != null && value !== '') return value;
    }
    return null;
  };
  const numeric = value => {
    if (value == null || value === '') return null;
    const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const hashText = value => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  const normalizeAppendixToken = token => String(token)
    .replace(/^(附表|附录|附件|appendix|schedule)[\s:：#-]*/i, '')
    .replace(/^#/, '')
    .trim()
    .toLowerCase();
  const normalizeLineId = value => String(value).replace(/\s*(续|cont(inued)?\.?|continued)\s*$/i, '').trim();
  const refTokens = value => String(value || '')
    .split(/[\s,，;；|]+/)
    .map(token => token.replace(/^#/, '').trim())
    .filter(Boolean);

  const classAndAttributes = element => [
    element.getAttribute?.('class') || '',
    element.getAttribute?.('role') || '',
    element.getAttribute?.('aria-label') || '',
    element.getAttribute?.('data-kind') || '',
    element.getAttribute?.('data-role') || '',
    element.getAttribute?.('data-type') || '',
  ].join(' ').toLowerCase();

  // Screen/media visibility of an element, walking ancestors.  This is the
  // print-media decision: `.screen-only` elements are display:none here.
  const visibility = element => {
    if (!element || element.nodeType !== 1) return { visible: false, reason: 'not-element' };
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.getAttribute?.('aria-hidden') === 'true') return { visible: false, reason: 'aria-hidden' };
      if (node.hasAttribute?.('hidden')) return { visible: false, reason: 'hidden-attribute' };
      const style = getComputedStyle(node);
      if (style.display === 'none') return { visible: false, reason: 'display-none' };
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return { visible: false, reason: 'visibility-' + style.visibility };
    }
    return { visible: true, reason: 'visible' };
  };

  // Page furniture that must never become a registration field.
  const furnitureKind = element => {
    const tag = element.tagName?.toLowerCase?.() || '';
    const marks = classAndAttributes(element);
    const text = textOf(element);
    if (element.closest?.('tfoot')) return 'page-footer';
    if (attr(element, ['data-watermark']) != null || /(^|[\s_-])watermark([\s_-]|$)|水印/.test(marks)) return 'watermark';
    if (attr(element, ['data-void', 'data-voided', 'data-cancelled', 'data-cancel-stamp']) != null || /(^|[\s_-])(void|voided|cancelled|cancel-stamp)([\s_-]|$)|作废/.test(marks)) return 'void-mark';
    if (attr(element, ['data-page-number', 'data-pagination']) != null || /(^|[\s_-])(page-number|pagination|页码)([\s_-]|$)/.test(marks)) return 'page-number';
    if (tag === 'tfoot' || /(^|[\s_-])(page-footer|pagefoot|页脚)([\s_-]|$)/.test(marks)) return 'page-footer';
    if (tag === 'footer' || /(^|[\s_-])footer([\s_-]|$)|页脚/.test(marks)) return 'footer';
    if (tag === 'header' || /(^|[\s_-])page-header([\s_-]|$)/.test(marks)) return 'header';
    if (/^第\s*\d+\s*页(\s*[\/／]?\s*共\s*\d+\s*页)?$/.test(text) || /^(page|p\.)\s*\d+(\s*(of|\/)\s*\d+)?$/i.test(text)) return 'page-number';
    if (/^(以下空白|本页无内容|无内容|空白页|blank page)$/i.test(text)) return 'blank-placeholder';
    return null;
  };

  // A printable row that is a placeholder rather than a registration line.
  const placeholderKind = (row, cells) => {
    if (attr(row, ['data-void', 'data-placeholder', 'data-blank']) != null) return 'marked-placeholder';
    const marks = classAndAttributes(row);
    if (/(^|[\s_-])(placeholder|blank|empty-row|spacer)([\s_-]|$)/.test(marks)) return 'marked-placeholder';
    const values = cells.map(cell => textOf(cell));
    const joined = values.filter(Boolean).join(' ');
    if (!joined) return 'empty';
    if (values.every(value => value === '' || /^(—+|-{2,}|–+|\/|n\/a|暂无|无|以下空白)$/i.test(value))) return 'blank-token';
    return null;
  };

  const docFlags = root => ({
    cached: root.hasAttribute('data-cached') || root.getAttribute('data-preview-state') === 'cached' || root.getAttribute('data-cache') === 'true',
    voided: root.hasAttribute('data-void') || root.hasAttribute('data-voided') || root.getAttribute('data-document-state') === 'void',
    composing: root.getAttribute('data-document-state') === 'composing' || root.getAttribute('data-state') === 'composing' || root.hasAttribute('data-composing'),
  });

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
    return { registration: reg, revision: numeric(rev), generation: numeric(gen) };
  };

  const freshnessOf = element => {
    let best = -1;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const inserted = tracker?.epochs?.get(node);
      const updated = tracker?.attributeEpochs?.get(node);
      if (inserted != null) best = Math.max(best, inserted);
      if (updated != null) best = Math.max(best, updated);
    }
    return best;
  };

  const documentRoots = () => {
    const explicit = [...document.querySelectorAll('[data-print-document],.print-document,[data-print-doc],.print-doc')];
    if (explicit.length) return explicit;
    const fallback = document.querySelector('#preview,[data-preview]');
    return fallback ? [fallback] : [];
  };

  const pagesOf = root => [...root.querySelectorAll('[data-page],.print-page')]
    .filter(page => !page.parentElement?.closest('[data-page],.print-page'))
    .filter(page => visibility(page).visible);

  // ---------------------------------------------------------------------------
  // Match current document again (same rules as readiness, so extraction never
  // silently slides onto an old cached preview).
  // ---------------------------------------------------------------------------
  const candidates = documentRoots().map((root, index) => {
    const identity = identityOf(root);
    const flags = docFlags(root);
    const pages = pagesOf(root);
    const freshness = Math.max(freshnessOf(root), ...pages.map(page => freshnessOf(page)));
    const docId = root.getAttribute('data-doc-id') || (root.matches('#preview,[data-preview]') ? 'preview' : 'document-' + (index + 1));
    return { root, index, docId, identity, flags, pages, freshness };
  });

  const current = candidates.filter(candidate => {
    if (candidate.identity.registration !== registration) return false;
    if (candidate.identity.revision !== revision) return false;
    if (candidate.flags.cached || candidate.flags.voided || candidate.flags.composing) return false;
    return candidate.freshness > clickEpoch && candidate.pages.length > 0;
  });
  const generations = current.map(candidate => candidate.identity.generation).filter(value => value != null);
  const newestGeneration = generations.length ? Math.max(...generations) : null;
  const matched = (newestGeneration == null ? current : current.filter(candidate => candidate.identity.generation == null || candidate.identity.generation === newestGeneration))
    .sort((left, right) => {
      const leftGeneration = left.identity.generation ?? -1;
      const rightGeneration = right.identity.generation ?? -1;
      if (leftGeneration !== rightGeneration) return rightGeneration - leftGeneration;
      return right.freshness - left.freshness;
    });

  if (!matched.length) {
    return {
      status: 'no-current-document',
      candidates: candidates.map(candidate => ({
        docId: candidate.docId, identity: candidate.identity, cached: candidate.flags.cached,
        voided: candidate.flags.voided, pageCount: candidate.pages.length, freshness: candidate.freshness,
      })),
    };
  }

  const primary = matched[0];
  const selected = includeSecondaryDocuments ? matched : [primary];

  // Documents that were on the page but deliberately not collected.  Each one
  // is described individually, with the reason it was rejected, so an abnormal
  // document is reported rather than silently skipped.  The render tracker's
  // history also covers previews that existed after the click but were replaced
  // before this read (cached preview, old revision, composing pass).
  const rejectedDocuments = candidates.filter(candidate => !selected.includes(candidate)).map(candidate => ({
    id: candidate.docId,
    registration: candidate.identity.registration,
    revision: candidate.identity.revision,
    generation: candidate.identity.generation,
    pageCount: candidate.pages.length,
    renderEpoch: candidate.freshness,
    reason: candidate.flags.cached ? 'cached-preview'
      : candidate.flags.voided ? 'voided-document'
        : candidate.flags.composing ? 'document-composing'
          : candidate.identity.registration !== registration ? 'registration-mismatch'
            : candidate.identity.revision !== revision ? 'revision-mismatch'
              : !(candidate.freshness > clickEpoch) ? 'not-fresh-after-generate'
                : 'not-selected',
  }));
  const occurredDocuments = (tracker?.history ?? []).map(item => ({
    id: item.docId,
    registration: item.registration,
    revision: item.revision == null ? null : Number(item.revision),
    generation: item.generation == null ? null : Number(item.generation),
    pageCount: item.pageCount,
    seenAtMs: item.at,
    reason: item.cached ? 'cached-preview'
      : item.voided ? 'voided-document'
        : item.composing ? 'document-composing'
          : item.registration !== registration ? 'registration-mismatch'
            : Number(item.revision) !== revision ? 'revision-mismatch'
              : 'candidate',
  }));

  // ---------------------------------------------------------------------------
  // Off-screen print-media host.  All selected documents stay attached at the
  // same time so stylesheet-driven print styles (`.print-page`, `.screen-only`,
  // page breaks) are computed rather than defaulted.
  // ---------------------------------------------------------------------------
  const host = document.createElement('div');
  host.setAttribute('data-print-collection-host', '');
  host.style.cssText = 'position:absolute;left:-100000px;top:0;width:100%;pointer-events:none;';
  document.body.appendChild(host);
  const geometryHost = document.createElement('div');
  geometryHost.setAttribute('data-print-collection-geometry', '');
  geometryHost.style.cssText = 'position:absolute;left:-100000px;top:0;width:100%;pointer-events:none;';
  document.body.appendChild(geometryHost);

  const geometryOf = clone => [...clone.querySelectorAll('[data-page],.print-page')]
    .filter(page => !page.parentElement?.closest('[data-page],.print-page'))
    .filter(page => visibility(page).visible)
    .map(page => {
      const rect = page.getBoundingClientRect();
      return [page.getAttribute('data-page') || '', Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(':');
    }).join('|');
  const cloneForGeometry = candidate => {
    geometryHost.textContent = '';
    const clone = candidate.root.cloneNode(true);
    geometryHost.appendChild(clone);
    return clone;
  };
  const beforeSignatures = selected.map(candidate => geometryOf(cloneForGeometry(candidate)));

  const excluded = {
    screenOnly: [], watermark: [], voidMark: [], footer: [], header: [],
    pageNumber: [], placeholder: [], repeatedHeader: [], summary: [], otherFurniture: [],
  };
  const bucketFor = kind => {
    if (kind === 'watermark') return 'watermark';
    if (kind === 'void-mark') return 'voidMark';
    if (kind === 'footer' || kind === 'page-footer') return 'footer';
    if (kind === 'header') return 'header';
    if (kind === 'page-number') return 'pageNumber';
    if (kind === 'placeholder' || kind === 'blank-placeholder') return 'placeholder';
    return 'otherFurniture';
  };
  const anomalies = [];
  const linesById = new Map();
  const lineOrder = [];
  const appendixByKey = new Map();
  let screenOnlyExcluded = 0;
  // Logical line ids that exist only in screen-only (print-hidden) material.
  const screenOnlyLineIds = new Set();
  // Logical line ids that were successfully read from print media.
  const printLineIds = new Set();
  const excludedId = new Set();
  const pushExcluded = (bucket, payload) => {
    const identity = [bucket, payload.documentId, payload.pageNumber, payload.kind || '', payload.text].join('\u0000');
    if (excludedId.has(identity)) return;
    excludedId.add(identity);
    (excluded[bucket] || excluded.otherFurniture).push(payload);
  };

  const headerCellsOf = row => [...row.children].filter(cell => ['TH', 'TD'].includes(cell.tagName));
  const headerSignature = row => headerCellsOf(row).map(cell => textOf(cell)).join('\u0001');

  const appendixRefsOf = (row, header) => {
    const refs = [];
    for (const name of ['data-appendix-id', 'data-appendix-refs', 'data-appendix-ref', 'data-appendix', 'data-schedule-ref']) {
      const value = row.getAttribute(name);
      if (value) for (const token of refTokens(value)) refs.push({ raw: token, via: 'attribute', attribute: name });
    }
    const cells = headerCellsOf(row);
    header.forEach((name, index) => {
      if (!/附表|附录|附件|appendix|schedule/i.test(name)) return;
      const cell = cells[index];
      if (!cell) return;
      const value = attr(cell, ['data-appendix-id', 'data-appendix-ref']);
      const tokens = value ? refTokens(value) : refTokens(textOf(cell));
      for (const token of tokens) {
        if (!value && !/^(附表|附录|附件|appendix|schedule)/i.test(token)) continue;
        refs.push({ raw: token, via: 'cell', header: name });
      }
    });
    const seen = new Set();
    return refs.filter(ref => {
      const key = ref.raw + '|' + ref.via + '|' + (ref.attribute || ref.header || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Extracts rows from one table.  Header rows (thead / all-TH / a later
  // repetition of a known header signature) initialize or are excluded as
  // repeated headers; placeholders and furniture are excluded with evidence.
  const extractTableRows = (table, pageNumber, documentId, options = {}) => {
    const { seenHeaders, inheritedHeader = null, inheritedSignature = '' } = options;
    const allRows = [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table);
    let header = inheritedHeader ? [...inheritedHeader] : [];
    let lastHeaderSignature = inheritedSignature;
    let ownHeader = false;
    // Set when this table emitted a repeated header, so the data rows that
    // follow it can be linked back to that repetition.
    let repeatedHeaderOnPage = null;
    const rows = [];
    const headerEvents = [];
    for (const row of allRows) {
      const rowVisibility = visibility(row);
      if (!rowVisibility.visible) {
        const lineId = row.getAttribute?.('data-line') ?? row.getAttribute?.('data-line-id') ?? null;
        if (lineId != null) screenOnlyLineIds.add(lineId);
        pushExcluded('screenOnly', { documentId, pageNumber, text: textOf(row), reason: rowVisibility.reason, lineId });
        continue;
      }
      const furniture = furnitureKind(row);
      if (furniture) {
        const bucket = furniture === 'page-number' ? 'pageNumber'
          : furniture === 'footer' || furniture === 'page-footer' ? 'footer'
            : furniture === 'blank-placeholder' ? 'placeholder'
              : bucketFor(furniture);
        pushExcluded(bucket, { documentId, pageNumber, text: textOf(row), tag: row.tagName, kind: furniture });
        continue;
      }
      const cells = headerCellsOf(row);
      if (!cells.length) continue;
      const allTh = cells.every(cell => cell.tagName === 'TH');
      const inHead = Boolean(row.closest('thead'));
      const signature = headerSignature(row);
      // A later page's header row repeats a signature this document already
      // emitted.  Record it as an exclusion so the page is traceable, and never
      // treat it as data even if it is plain <td> cells.
      const repeatsKnownHeader = Boolean(seenHeaders?.has(signature)
        || (ownHeader && lastHeaderSignature && signature === lastHeaderSignature));
      if ((inHead || allTh) && repeatsKnownHeader) {
        pushExcluded('repeatedHeader', { documentId, pageNumber, signature, text: textOf(row), source: inHead ? 'thead-repetition' : 'th-row-repetition' });
        headerEvents.push({ pageNumber, signature, repeated: true, source: inHead ? 'thead-repetition' : 'th-row-repetition' });
        repeatedHeaderOnPage = signature;
        // Keep the inherited header for this table's data rows.
        if (!header.length && inheritedHeader) header = [...inheritedHeader];
        lastHeaderSignature = signature;
        continue;
      }
      if (inHead || allTh) {
        header = cells.map((cell, index) => textOf(cell) || '列' + (index + 1));
        lastHeaderSignature = signature;
        ownHeader = true;
        seenHeaders?.add(signature);
        headerEvents.push({ pageNumber, signature, repeated: false, source: inHead ? 'thead' : 'th-row' });
        continue;
      }
      // A data row whose text repeats a known header signature is a repeated
      // header emitted as plain cells on a later page.
      if ((ownHeader || seenHeaders?.has(signature)) && signature === lastHeaderSignature) {
        pushExcluded('repeatedHeader', { documentId, pageNumber, signature, text: textOf(row), source: 'plain-repetition' });
        headerEvents.push({ pageNumber, signature, repeated: true, source: 'plain-repetition' });
        repeatedHeaderOnPage = signature;
        continue;
      }
      const placeholder = placeholderKind(row, cells);
      if (placeholder) {
        pushExcluded('placeholder', { documentId, pageNumber, text: textOf(row), kind: placeholder, rowNumber: rows.length + 1 });
        continue;
      }
      const lineIdRaw = row.getAttribute('data-line') ?? row.getAttribute('data-line-id') ?? null;
      const rowMarks = classAndAttributes(row);
      // data-continued marks the *base* fragment whose row spills onto the
      // next page; data-continuation marks the spill fragment itself.
      let role = 'base';
      if (attr(row, ['data-continuation', 'data-continued-from']) != null) role = 'continuation';
      else if (rowMarks && /(^|[\s_-])(continuation|continued-from)([\s_-]|$)/.test(rowMarks)) role = 'continuation';
      const continuedFromThis = attr(row, ['data-continued', 'data-row-continued']) != null
        || /(^|[\s_-])(continued|spills)([\s_-]|$)/.test(rowMarks);
      const record = {
        rowNumber: rows.length + 1,
        pageNumber,
        lineId: lineIdRaw != null ? normalizeLineId(lineIdRaw) : null,
        lineIdRaw,
        rowId: row.getAttribute('data-row-id') ?? null,
        role,
        continuedFromThis,
        rowClass: role === 'continuation' ? 'row-continuation' : continuedFromThis ? 'row-continued' : null,
        anchor: row.getAttribute('data-anchor') || row.id || null,
        header: [...header],
        // When this table emitted a repeated header on this page, link the row
        // to it so a continuation row and its repeated header can be related.
        repeatedHeaderSignature: repeatedHeaderOnPage,
        cells: cells.map((cell, index) => {
          const span = cell.colSpan > 1 || cell.rowSpan > 1 ? { colSpan: cell.colSpan, rowSpan: cell.rowSpan } : null;
          return { header: header[index] || '列' + (index + 1), value: textOf(cell), raw: textOfDirect(cell), pageNumber, rowNumber: rows.length + 1, ...(span ? { span } : {}) };
        }),
        text: textOf(row),
        appendixRefs: appendixRefsOf(row, header),
      };
      rows.push(record);
    }
    return { header, headerOwned: ownHeader, rows, headerEvents, repeatedHeaderOnPage };
  };

  // ---------------------------------------------------------------------------
  // Pass 1: clone every selected document, walk pages and tables, collect
  // fragments (main lines and appendix rows) with physical page positions.
  // ---------------------------------------------------------------------------
  const documentContexts = selected.map((candidate, index) => {
    const clone = candidate.root.cloneNode(true);
    host.appendChild(clone);
    const pages = pagesOf(clone);
    const context = {
      candidate,
      clone,
      pages,
      documentId: candidate.docId,
      registration: candidate.identity.registration,
      revision: candidate.identity.revision,
      generation: candidate.identity.generation,
      primary: index === 0,
      pageCount: pages.length,
      pageNumbers: [],
      lineFragments: [],
      appendixKeys: [],
      body: [],
      pageEvidence: [],
      repeatedHeaders: [],
      mainHeaders: new Set(),
      mainHeader: null,
      mainHeaderSignature: '',
    };
    if (!pages.length) {
      anomalies.push({ code: 'document-without-print-pages', documentId: candidate.docId });
      context.pages = [clone];
    }
    context.pages.forEach((page, pageIndex) => {
      const number = numeric(page.getAttribute('data-page')) ?? pageIndex + 1;
      context.pageNumbers.push(number);
    });
    return context;
  });

  for (const context of documentContexts) {
    for (const [pageIndex, page] of context.pages.entries()) {
      const pageNumber = context.pageNumbers[pageIndex];
      const pageInfo = {
        pageNumber, index: pageIndex, tables: 0, lineRows: 0,
        appendixTables: 0, bodyBlocks: 0, repeatedHeaders: 0, furniture: [], screenOnly: [],
      };

      // Screen-only material inside the print document is evidence of what was
      // *not* read as print content.  It never becomes a registration field.
      for (const element of page.querySelectorAll('.screen-only,[data-summary],[data-screen-only]')) {
        if (visibility(element).visible) continue;
        screenOnlyExcluded += 1;
        const lineId = element.getAttribute?.('data-line')
          ?? element.querySelector?.('[data-line]')?.getAttribute('data-line')
          ?? null;
        if (lineId != null) screenOnlyLineIds.add(lineId);
        pageInfo.screenOnly.push({ text: textOf(element), reason: visibility(element).reason, lineId });
        pushExcluded('screenOnly', { documentId: context.documentId, pageNumber, text: textOf(element), reason: visibility(element).reason, lineId });
      }

      const tables = [...page.querySelectorAll('table')].filter(table => !table.parentElement?.closest('table'));
      for (const [tableIndex, table] of tables.entries()) {
        pageInfo.tables += 1;
        const tableMarks = [
          table.getAttribute('data-appendix-id') || '',
          table.getAttribute('data-appendix') || '',
          table.getAttribute('aria-label') || '',
          table.getAttribute('class') || '',
          table.caption ? textOf(table.caption) : '',
        ].join(' ');
        let precedingHeading = '';
        let cursor = table;
        while (!precedingHeading && cursor && cursor !== page) {
          let sibling = cursor.previousElementSibling;
          while (sibling && !precedingHeading) {
            if (/^H[1-6]$/.test(sibling.tagName) || sibling.hasAttribute('data-section-title')) precedingHeading = textOf(sibling);
            sibling = sibling.previousElementSibling;
          }
          cursor = cursor.parentElement;
        }
        const declaredAppendix = /附录|附表|附件|appendix|schedule/i.test(tableMarks + ' ' + precedingHeading);
        const hasLines = Boolean(table.querySelector('[data-line],[data-line-id]'));
        const isAppendix = !hasLines && (declaredAppendix || table.hasAttribute('data-appendix-id') || table.hasAttribute('data-appendix'));

        if (!isAppendix) {
          const extracted = extractTableRows(table, pageNumber, context.documentId, {
            seenHeaders: context.mainHeaders,
            inheritedHeader: context.mainHeader,
            inheritedSignature: context.mainHeaderSignature,
          });
          const repeatedEvents = extracted.headerEvents.filter(event => event.repeated);
          pageInfo.repeatedHeaders += repeatedEvents.length;
          for (const event of repeatedEvents) {
            context.repeatedHeaders.push({
              documentId: context.documentId,
              pageNumber: event.pageNumber,
              signature: event.signature,
              columnNames: event.signature.split('\u0001'),
              source: event.source,
              // Data rows on the same page follow this repeated header.
              linkedLineIds: extracted.rows.filter(row => row.repeatedHeaderSignature === event.signature && row.lineId).map(row => row.lineId),
            });
          }
          pageInfo.lineRows += extracted.rows.length;
          if (extracted.header.length) {
            context.mainHeader = extracted.header;
            context.mainHeaderSignature = extracted.header.join('\u0001');
            context.mainHeaders.add(context.mainHeaderSignature);
          }
          for (const row of extracted.rows) {
            if (!row.lineId) {
              anomalies.push({ code: 'line-row-without-data-line', documentId: context.documentId, pageNumber, text: row.text });
              continue;
            }
            context.lineFragments.push({ ...row, documentId: context.documentId, pageIndex, tableIndex });
          }
          continue;
        }

        // Appendix fragment.
        pageInfo.appendixTables += 1;
        const appendixId = table.getAttribute('data-appendix-id') || table.getAttribute('data-appendix') || null;
        const continued = table.hasAttribute('data-appendix-continued')
          || table.hasAttribute('data-continued')
          || table.getAttribute('data-continuation') === 'true';
        const title = precedingHeading || (table.caption ? textOf(table.caption) : '') || appendixId || ('附表 ' + (context.appendixKeys.length + 1));
        // An id-less continuation table belongs to the previous appendix
        // fragment in the same document.  Identity is never content based.
        const previousAppendixKey = context.appendixKeys[context.appendixKeys.length - 1];
        const previousAppendix = previousAppendixKey ? appendixByKey.get(previousAppendixKey) : null;
        let identityKey;
        if (appendixId) identityKey = `${context.documentId}::appendix:${normalizeAppendixToken(appendixId)}`;
        else if (continued && previousAppendixKey) identityKey = previousAppendixKey;
        else identityKey = `${context.documentId}::appendix:page-${pageNumber}-table-${tableIndex}`;
        const existingAppendix = appendixByKey.get(identityKey);
        // A continuation table without its own header row inherits the current
        // appendix fragment's header, so rows on later pages keep the same
        // column names.  Identity stays declaration/document based.
        const inherited = existingAppendix ?? (appendixId ? null : previousAppendix);
        const extracted = extractTableRows(table, pageNumber, context.documentId, {
          inheritedHeader: inherited?.header || null,
          inheritedSignature: inherited?.headerSignature || '',
        });
        const fragment = {
          documentId: context.documentId,
          pageNumber,
          pageIndex,
          tableIndex,
          tableOrdinal: pageInfo.appendixTables,
          continued,
          title,
          header: extracted.header,
          headerSignature: extracted.header.join('\u0001'),
          rows: extracted.rows,
          rowCount: extracted.rows.length,
        };
        let appendix = appendixByKey.get(identityKey);
        if (!appendix) {
          appendix = {
            key: identityKey,
            declaredId: appendixId,
            normalizedId: appendixId ? normalizeAppendixToken(appendixId) : null,
            title,
            documentId: context.documentId,
            registration: context.registration,
            revision: context.revision,
            pages: [],
            fragments: [],
            rows: [],
            owners: [],
            orphan: true,
            shared: false,
            anomalies: [],
          };
          appendixByKey.set(identityKey, appendix);
          context.appendixKeys.push(identityKey);
        } else if (!continued) {
          appendix.anomalies.push({ code: 'appendix-key-repeated-without-continuation-marker', pageNumber });
        }
        appendix.fragments.push(fragment);
        if (!appendix.pages.includes(pageNumber)) appendix.pages.push(pageNumber);
        appendix.rows.push(...extracted.rows.map(row => ({ ...row, appendixKey: identityKey, documentId: context.documentId, title })));
      }

      // Body blocks (headings/paragraphs) are anchored evidence, never fields.
      for (const element of page.querySelectorAll('h1,h2,h3,h4,p,li')) {
        if (element.parentElement?.closest('table,tfoot,thead')) continue;
        const furniture = furnitureKind(element);
        if (furniture) {
          pageInfo.furniture.push({ kind: furniture, text: textOf(element) });
          pushExcluded(furniture === 'page-number' ? 'pageNumber' : furniture === 'footer' || furniture === 'page-footer' ? 'footer' : furniture, {
            documentId: context.documentId, pageNumber, text: textOf(element), tag: element.tagName,
          });
          continue;
        }
        const visible = visibility(element);
        if (!visible.visible) {
          screenOnlyExcluded += 1;
          pushExcluded('screenOnly', { documentId: context.documentId, pageNumber, text: textOf(element), reason: visible.reason });
          continue;
        }
        const text = textOf(element);
        if (!text) continue;
        pageInfo.bodyBlocks += 1;
        context.body.push({ kind: element.tagName.toLowerCase(), text, pageNumber, pageIndex });
      }
      context.pageEvidence.push(pageInfo);
    }

    // Watermarks / void stamps / page furniture anywhere in the print document,
    // including absolutely-positioned overlays outside normal flow.
    for (const [pageIndex, page] of context.pages.entries()) {
      const pageNumber = context.pageNumbers[pageIndex];
      const pageInfo = context.pageEvidence[pageIndex];
      if (!pageInfo) continue;
      for (const element of page.querySelectorAll('[data-watermark],[class*="watermark"],[data-void],[data-voided],[data-cancel-stamp],[class*="cancel-stamp"]')) {
        const marks = classAndAttributes(element);
        const kind = attr(element, ['data-cancel-stamp', 'data-void', 'data-voided']) != null || /作废|void|cancel/.test(marks) ? 'void-mark' : 'watermark';
        const text = textOf(element);
        if (!text) continue;
        pageInfo.furniture.push({ kind, text });
        pushExcluded(kind === 'watermark' ? 'watermark' : 'voidMark', { documentId: context.documentId, pageNumber, text, tag: element.tagName });
      }
      for (const element of page.querySelectorAll('tfoot,footer,header,[data-page-number],[data-pagination],.page-number,.page-footer')) {
        const kind = furnitureKind(element);
        if (!kind) continue;
        const text = textOf(element);
        if (!text) continue;
        pageInfo.furniture.push({ kind, text });
        pushExcluded(kind === 'footer' || kind === 'page-footer' ? 'footer' : kind === 'header' ? 'header' : 'pageNumber', {
          documentId: context.documentId, pageNumber, text, tag: element.tagName,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 2: merge logical lines sharing data-line across print pages.
  // ---------------------------------------------------------------------------
  for (const context of documentContexts) {
    for (const fragment of context.lineFragments) {
      const key = context.documentId + '\u0000' + fragment.lineId;
      let line = linesById.get(key);
      if (!line) {
        line = {
          id: fragment.lineId,
          documentId: context.documentId,
          registration: context.registration,
          revision: context.revision,
          fragments: [],
          pageNumbers: [],
          headerSequence: [],
          appendixRefs: [],
          anomalies: [],
        };
        linesById.set(key, line);
        lineOrder.push(key);
      }
      const rawValues = {};
      for (const cell of fragment.cells) {
        if (!cell.header) continue;
        rawValues[cell.header] = rawValues[cell.header] || [];
        if (cell.value !== '') rawValues[cell.header].push(cell.value);
      }
      line.fragments.push({ ...fragment, rawValues });
      if (!line.pageNumbers.includes(fragment.pageNumber)) line.pageNumbers.push(fragment.pageNumber);
      for (const cell of fragment.cells) if (cell.header && !line.headerSequence.includes(cell.header)) line.headerSequence.push(cell.header);
    }
  }

  const lines = [];
  for (const key of lineOrder) {
    const line = linesById.get(key);
    line.fragments.sort((left, right) => left.pageNumber - right.pageNumber || left.rowNumber - right.rowNumber);
    line.pageNumbers.sort((left, right) => left - right);
    const base = line.fragments.filter(fragment => fragment.role !== 'continuation');
    const continuations = line.fragments.filter(fragment => fragment.role === 'continuation');

    const fields = {};
    const raw = {};
    for (const header of line.headerSequence) {
      const values = [];
      const all = [];
      for (const fragment of line.fragments) {
        for (const value of fragment.rawValues[header] || []) {
          all.push(value);
          const trimmed = String(value).trim();
          const cleaned = /编号|ID/i.test(header) && trimmed.replace(/\s*(续|cont(inued)?\.?|continued)\s*$/i, '') === line.id
            ? line.id
            : trimmed;
          if (!values.includes(cleaned)) values.push(cleaned);
        }
      }
      raw[header] = all;
      fields[header] = values.length === 0 ? '' : values.length === 1 ? values[0] : values;
    }
    line.fields = fields;
    line.rawValues = raw;
    line.text = line.fragments.map(fragment => fragment.text).join(' ');
    // Per-fragment physical location, so each merged value can be traced back
    // to the exact print page and row it came from.
    line.sourcePages = line.fragments.map(fragment => ({
      documentId: fragment.documentId,
      pageNumber: fragment.pageNumber,
      tableIndex: fragment.tableIndex,
      rowNumber: fragment.rowNumber,
      lineIdRaw: fragment.lineIdRaw,
      role: fragment.role,
      rowClass: fragment.rowClass,
      continued: fragment.continuedFromThis,
      continuation: fragment.role === 'continuation',
      cells: fragment.cells.map(cell => ({ header: cell.header, value: cell.value, ...(cell.span ? { span: cell.span } : {}) })),
      text: fragment.text,
      anchor: fragment.anchor,
      // On pages that repeat the table header, link this fragment to it so a
      // continuation row is related to the header printed above it.
      repeatedHeader: fragment.repeatedHeaderSignature
        ? { signature: fragment.repeatedHeaderSignature, columns: fragment.repeatedHeaderSignature.split('\u0001'), pageNumber: fragment.pageNumber }
        : null,
    }));
    line.documentIds = [...new Set(line.fragments.map(fragment => fragment.documentId))];
    line.continued = continuations.length > 0;
    // Repeated-header evidence: pages whose main table emitted a header row
    // that had already been seen for this document.
    line.pageRows = line.fragments.map(fragment => ({ pageNumber: fragment.pageNumber, rowNumber: fragment.rowNumber }));

    if (!base.length && continuations.length) line.anomalies.push({ code: 'orphan-continuation', pageNumbers: line.pageNumbers });
    const samePageBases = base.filter(fragment => fragment.pageNumber === base[0]?.pageNumber);
    if (samePageBases.length > 1) line.anomalies.push({ code: 'duplicate-base-fragment', pageNumbers: [base[0].pageNumber] });
    if (continuations.length && base.length && continuations.some(fragment => fragment.pageNumber < base[0].pageNumber)) {
      line.anomalies.push({ code: 'continuation-before-base', pageNumbers: line.pageNumbers });
    }
    for (let index = 1; index < line.pageNumbers.length; index += 1) {
      if (line.pageNumbers[index] !== line.pageNumbers[index - 1] + 1) line.anomalies.push({ code: 'page-gap', from: line.pageNumbers[index - 1], to: line.pageNumbers[index] });
    }
    line.complete = Boolean(base.length) && !line.anomalies.some(anomaly => ['orphan-continuation', 'duplicate-base-fragment', 'page-gap', 'continuation-before-base'].includes(anomaly.code));
    for (const anomaly of line.anomalies) anomalies.push({ code: anomaly.code, lineId: line.id, documentId: line.documentId, ...anomaly });
    delete line.fragments;
    lines.push(line);
  }

  // ---------------------------------------------------------------------------
  // Pass 3: appendix ownership.  Key is document + declared identity (or
  // physical page/table).  Identical content in two documents remains two
  // appendices; the duplicate is reported via contentHash, never merged away.
  // ---------------------------------------------------------------------------
  const appendices = [...appendixByKey.values()];
  const byDocument = new Map();
  for (const appendix of appendices) {
    appendix.fragments.sort((left, right) => left.pageNumber - right.pageNumber || left.tableOrdinal - right.tableOrdinal);
    appendix.pages.sort((left, right) => left - right);
    appendix.header = appendix.fragments[0]?.header || [];
    appendix.totalRows = appendix.rows.length;
    appendix.contentHash = hashText(appendix.header.join('\u0001') + '\u0002' + appendix.rows.map(row => row.cells.map(cell => cell.value).join('\u0001')).join('\u0003'));
    if (!byDocument.has(appendix.documentId)) byDocument.set(appendix.documentId, []);
    byDocument.get(appendix.documentId).push(appendix);
  }
  for (const appendix of appendices) {
    appendix.duplicateContentOf = appendices.filter(other => other !== appendix && other.contentHash === appendix.contentHash).map(other => other.key);
  }

  const resolveAppendix = (reference, line) => {
    const token = normalizeAppendixToken(reference);
    const score = appendix => {
      if (appendix.declaredId && appendix.declaredId === reference) return 100;
      if (appendix.normalizedId && appendix.normalizedId === token) return 90;
      if (appendix.key === reference) return 80;
      if (token && appendix.normalizedId && appendix.normalizedId.endsWith(token)) return 60;
      if (token && normalizeAppendixToken(appendix.title) === token) return 50;
      if (token && normalizeAppendixToken(appendix.title).endsWith(token)) return 40;
      return 0;
    };
    let best = null;
    let bestScore = 0;
    let crossDocument = false;
    for (const appendix of appendices) {
      const value = score(appendix);
      if (!value) continue;
      const sameDocument = appendix.documentId === line.documentId;
      const adjusted = value + (sameDocument ? 10 : 0);
      if (adjusted > bestScore) {
        best = appendix;
        bestScore = adjusted;
        crossDocument = !sameDocument;
      }
    }
    return { appendix: best, crossDocument };
  };

  for (const line of lines) line.appendixRefs = [];
  for (const context of documentContexts) {
    for (const fragment of context.lineFragments) {
      const line = linesById.get(context.documentId + '\u0000' + fragment.lineId);
      if (!line) continue;
      for (const ref of fragment.appendixRefs) {
        const resolved = resolveAppendix(ref.raw, line);
        const evidence = {
          lineId: line.id,
          documentId: line.documentId,
          pageNumber: fragment.pageNumber,
          rowNumber: fragment.rowNumber,
          via: ref.via,
          attribute: ref.attribute || null,
          header: ref.header || null,
          raw: ref.raw,
          resolvedKey: resolved.appendix?.key || null,
          crossDocument: resolved.crossDocument,
        };
        line.appendixRefs.push(evidence);
        if (!resolved.appendix) {
          anomalies.push({ code: 'unresolved-appendix-reference', lineId: line.id, documentId: line.documentId, pageNumber: fragment.pageNumber, raw: ref.raw });
          continue;
        }
        const appendix = resolved.appendix;
        let owner = appendix.owners.find(candidate => candidate.lineId === line.id && candidate.documentId === line.documentId);
        if (!owner) {
          owner = { lineId: line.id, documentId: line.documentId, registration: line.registration, revision: line.revision, pageNumbers: [], evidence: [] };
          appendix.owners.push(owner);
        }
        if (!owner.pageNumbers.includes(fragment.pageNumber)) owner.pageNumbers.push(fragment.pageNumber);
        owner.evidence.push(evidence);
        appendix.orphan = false;
      }
    }
  }
  for (const appendix of appendices) {
    for (const owner of appendix.owners) owner.pageNumbers.sort((left, right) => left - right);
    appendix.shared = appendix.owners.length > 1;
    if (appendix.orphan) anomalies.push({ code: 'appendix-without-owner', appendixKey: appendix.key, documentId: appendix.documentId, pages: appendix.pages });
  }

  const ids = [];
  for (const line of lines) {
    if (!ids.includes(line.id)) ids.push(line.id);
    printLineIds.add(line.id);
  }

  // Screen-only material that sits beside the print tree (e.g. a summary row in
  // the preview panel but outside any print document) is also classified: it
  // must not be read as content, but its `data-line` values are counted so the
  // result shows what screen-only data existed.
  for (const container of document.querySelectorAll('#preview,[data-preview]')) {
    for (const element of container.querySelectorAll('.screen-only,[data-summary],[data-screen-only]')) {
      if (element.closest('[data-print-document],[data-print-doc],.print-document,.print-doc,.print-page,[data-page]')) continue;
      const reason = visibility(element).reason;
      if (reason !== 'display-none' && reason !== 'visibility-hidden' && reason !== 'aria-hidden' && reason !== 'hidden-attribute') continue;
      screenOnlyExcluded += 1;
      const lineId = element.getAttribute?.('data-line')
        ?? element.querySelector?.('[data-line]')?.getAttribute('data-line')
        ?? null;
      if (lineId != null) screenOnlyLineIds.add(lineId);
      pushExcluded('screenOnly', { documentId: primary.docId, pageNumber: null, text: textOf(element), reason, scope: 'outside-print-document', lineId });
    }
  }

  // screenOnlyCount reports logical lines that only exist in screen-only
  // (print-hidden) material.  Those lines are intentionally not returned in
  // `ids`, but counting them proves they were seen and classified rather than
  // silently folded into the print content.
  const screenOnlyCount = [...screenOnlyLineIds].filter(lineId => !printLineIds.has(lineId)).length;

  const afterSignatures = selected.map(candidate => geometryOf(cloneForGeometry(candidate)));
  const layoutStable = beforeSignatures.every((signature, index) => signature === afterSignatures[index]);
  if (!layoutStable) anomalies.push({ code: 'unstable-during-extraction' });
  host.remove();
  geometryHost.remove();

  const documentEntries = documentContexts.map(context => {
    const documentAnomalies = anomalies.filter(anomaly =>
      (anomaly.documentId === context.documentId)
      || (anomaly.lineId && context.lineFragments.some(fragment => fragment.lineId === anomaly.lineId))
      || (anomaly.appendixKey && context.appendixKeys.includes(anomaly.appendixKey))
    );
    return {
      id: context.documentId,
      registration: context.registration,
      revision: context.revision,
      generation: context.generation,
      primary: context.primary,
      pageCount: context.pageCount,
      pageNumbers: context.pageNumbers,
      lineIds: [...new Set(context.lineFragments.map(fragment => fragment.lineId).filter(Boolean))],
      appendixKeys: context.appendixKeys,
      repeatedHeaders: context.repeatedHeaders,
      bodyBlocks: context.body.length,
      renderEpoch: context.candidate.freshness,
      media: 'print',
      pages: context.pageEvidence,
      anomalies: documentAnomalies,
    };
  });

  const blocking = new Set([
    'unresolved-appendix-reference', 'appendix-without-owner', 'document-without-print-pages',
    'line-row-without-data-line', 'unstable-during-extraction', 'appendix-key-repeated-without-continuation-marker',
  ]);
  const complete = layoutStable
    && lines.length > 0
    && lines.every(line => line.complete)
    && !anomalies.some(anomaly => blocking.has(anomaly.code));

  return {
    status: 'collected',
    document: {
      id: primary.docId,
      registration: primary.identity.registration,
      revision: primary.identity.revision,
      generation: primary.identity.generation,
      pageCount: primary.pages.length,
      renderEpoch: primary.freshness,
      media: 'print',
    },
    registration: primary.identity.registration,
    revision: primary.identity.revision,
    generation: primary.identity.generation,
    ids,
    screenOnlyCount,
    screenOnlyExcluded,
    complete,
    layoutStable,
    geometryBefore: beforeSignatures,
    geometryAfter: afterSignatures,
    documents: documentEntries,
    rejectedDocuments,
    occurredDocuments,
    lines,
    appendices,
    body: documentContexts.flatMap(context => context.body),
    excluded,
    anomalies,
    counts: {
      documents: documentEntries.length,
      pages: documentEntries.reduce((total, entry) => total + entry.pageCount, 0),
      lines: lines.length,
      fragments: lines.reduce((total, line) => total + line.sourcePages.length, 0),
      appendices: appendices.length,
      appendixRows: appendices.reduce((total, appendix) => total + appendix.totalRows, 0),
    },
    candidates: candidates.map(candidate => ({
      docId: candidate.docId,
      identity: candidate.identity,
      cached: candidate.flags.cached,
      voided: candidate.flags.voided,
      pageCount: candidate.pages.length,
      freshness: candidate.freshness,
      selected: selected.includes(candidate),
    })),
  };
}
