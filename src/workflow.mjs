// Business workflow entry point.
//
// run({ source, stateDir, input }) -> structured result
//
// Contract (docs/source-contract.md):
//   - input.registration/revision select the print document;
//   - a click on generate starts the print document, page-ready/data-revision
//     describe the preview state, print content must be visible in print media;
//   - logical rows use data-line, continuation fragments merge and keep page
//     numbers;
//   - result contains ids, registration, revision, screenOnlyCount;
//   - on failure: state=unavailable, ids=[].
//
// This implementation collects from the real portal with a real Chromium
// browser (see src/collect.mjs).  It never calls a JSON export endpoint and
// never derives content from the screen summary.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectFromPortal } from './collect.mjs';

const RESULT_FILE = 'result.json';
const EVIDENCE_FILE = 'evidence.json';

export async function run({ source, stateDir, input }) {
  const registration = input?.registration == null ? null : String(input.registration);
  const revision = input?.revision == null ? null : Number(input.revision);
  const portalPath = typeof input?.portalPath === 'string' ? input.portalPath : '/portal';
  const generateSelector = typeof input?.generateSelector === 'string' ? input.generateSelector : null;
  const regenerate = input?.regenerate === true;
  const inputKey = JSON.stringify({ registration, revision, portalPath, generateSelector, regenerate, source });

  await mkdir(stateDir, { recursive: true });

  // A restart may only reuse persisted progress that is traceable to a real
  // collected print document.  Anything else is re-collected.
  const cached = await loadResumable(stateDir, inputKey);
  if (cached) return persist(stateDir, cached, { resumed: true });

  const attempt = await collectWithEvidence(
    source,
    { registration, revision },
    { path: portalPath, generateSelector, regenerate },
  );
  const result = toBusinessResult(attempt, { registration, revision });
  return persist(stateDir, result, { attempt, inputKey });
}

async function collectWithEvidence(source, input, options) {
  try {
    return await collectFromPortal({ source, input, options });
  } catch (error) {
    return {
      state: 'unavailable',
      reason: 'collection-error',
      ids: [],
      registration: input.registration,
      revision: input.revision,
      detail: { message: error?.message ?? String(error) },
      evidence: { source, startedAt: new Date().toISOString(), steps: [], pageErrors: [error?.message ?? String(error)] },
    };
  }
}

function toBusinessResult(attempt, input) {
  const base = {
    ids: [],
    registration: input.registration,
    revision: input.revision,
    screenOnlyCount: 0,
  };
  if (attempt.state !== 'collected' && attempt.state !== 'incomplete') {
    return {
      state: 'unavailable',
      reason: attempt.reason ?? 'unavailable',
      ...base,
      document: null,
      collected: null,
      detail: attempt.detail ?? {},
      evidenceRef: evidenceRefOf(attempt),
    };
  }

  const collected = {
    document: attempt.document,
    documents: attempt.documents,
    rejectedDocuments: attempt.rejectedDocuments,
    occurredDocuments: attempt.occurredDocuments,
    lines: attempt.lines,
    appendices: attempt.appendices,
    body: attempt.body,
    excluded: attempt.excluded,
    anomalies: attempt.anomalies,
    counts: attempt.counts,
    complete: attempt.complete,
    layoutStable: attempt.layoutStable,
    candidates: attempt.candidates,
    geometry: {
      before: attempt.geometryBefore,
      after: attempt.geometryAfter,
    },
    screenOnlyExcluded: attempt.screenOnlyExcluded,
  };

  return {
    state: attempt.state,
    ...base,
    ids: attempt.ids,
    screenOnlyCount: attempt.screenOnlyCount,
    generation: attempt.generation ?? null,
    document: attempt.document,
    collected,
    anomalies: attempt.anomalies,
    evidenceRef: evidenceRefOf(attempt),
  };
}

function evidenceRefOf(attempt) {
  const key = attempt.document ? {
    documentId: attempt.document.id,
    registration: attempt.document.registration,
    revision: attempt.document.revision,
    pageCount: attempt.document.pageCount,
  } : null;
  const digest = attempt.ids?.length || attempt.lines?.length ? hash(JSON.stringify({
    ids: attempt.ids,
    lines: attempt.lines?.map(line => [line.id, line.pageNumbers, line.fields]),
    appendices: attempt.appendices?.map(appendix => [appendix.key, appendix.pages, appendix.owners]),
  })) : null;
  return {
    file: EVIDENCE_FILE,
    document: key,
    contentDigest: digest,
    collectedAt: attempt.evidence?.finishedAt ?? null,
  };
}

function hash(value) {
  let state = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 0).toString(16).padStart(8, '0');
}

async function persist(stateDir, result, extra) {
  // result.json always holds the same business result returned to the caller.
  // evidence.json holds the full trace used to look up a record later.
  const attempt = extra.attempt;
  if (attempt) {
    const evidence = {
      input: { registration: result.registration, revision: result.revision },
      resultState: result.state,
      startedAt: attempt.evidence?.startedAt ?? null,
      finishedAt: attempt.evidence?.finishedAt ?? null,
      elapsedMs: attempt.elapsedMs ?? null,
      steps: attempt.evidence?.steps ?? [],
      requests: attempt.evidence?.requests ?? [],
      pageErrors: attempt.evidence?.pageErrors ?? [],
      console: attempt.evidence?.console ?? [],
      readiness: attempt.evidence?.readiness ?? null,
      regeneration: attempt.evidence?.regeneration ?? null,
      firstPass: attempt.evidence?.firstPass ?? null,
      previewState: attempt.evidence?.previewState ?? null,
      extraction: attempt.evidence?.extraction ?? null,
      document: attempt.document ?? null,
      collected: result.collected ?? null,
      reason: result.reason ?? null,
      detail: result.detail ?? null,
    };
    await atomicWrite(path.join(stateDir, EVIDENCE_FILE), evidence);
  }
  const envelope = {
    state: result.state,
    reason: result.reason ?? null,
    registration: result.registration,
    revision: result.revision,
    ids: result.ids,
    screenOnlyCount: result.screenOnlyCount,
    document: result.document ?? null,
    collected: result.collected ?? null,
    anomalies: result.anomalies ?? [],
    evidenceRef: result.evidenceRef ?? null,
    persistedAt: new Date().toISOString(),
  };
  if (extra.inputKey) envelope.inputKey = extra.inputKey;
  await atomicWrite(path.join(stateDir, RESULT_FILE), envelope);
  return result;
}

async function loadResumable(stateDir, inputKey) {
  try {
    const raw = JSON.parse(await readFile(path.join(stateDir, RESULT_FILE), 'utf8'));
    const evidence = JSON.parse(await readFile(path.join(stateDir, EVIDENCE_FILE), 'utf8'));
    // Only a prior success for the identical input with matching, complete
    // evidence may be reused.  Failures are never silently turned into
    // successes on restart.
    if (raw.inputKey !== inputKey) return null;
    if (!['collected'].includes(raw.state)) return null;
    if (!evidence.collected?.lines?.length) return null;
    if (evidence.collected?.complete !== true) return null;
    if (evidence.resultState !== 'collected') return null;
    return {
      state: raw.state,
      registration: raw.registration,
      revision: raw.revision,
      ids: raw.ids,
      screenOnlyCount: raw.screenOnlyCount,
      document: raw.document,
      collected: raw.collected,
      anomalies: raw.anomalies,
      evidenceRef: raw.evidenceRef,
      resumedFrom: path.join(stateDir, RESULT_FILE),
    };
  } catch {
    return null;
  }
}

async function atomicWrite(file, value) {
  const temporary = file + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file);
}

/**
 * Lookup helper used by tests/demo: given a line id and (optionally) a value,
 * return the print-page evidence for it from a persisted result.
 */
export async function lookupLine(stateDir, lineId, options = {}) {
  const result = JSON.parse(await readFile(path.join(stateDir, RESULT_FILE), 'utf8'));
  const line = result.collected?.lines?.find(candidate => candidate.id === lineId);
  if (!line) return null;
  const pages = line.sourcePages.map(source => ({
    documentId: source.documentId,
    pageNumber: source.pageNumber,
    rowNumber: source.rowNumber,
    role: source.role,
    repeatedHeader: source.repeatedHeader ?? null,
    cells: source.cells,
    text: source.text,
  }));
  const appendices = (result.collected?.appendices ?? [])
    .filter(appendix => appendix.owners?.some(owner => owner.lineId === lineId))
    .map(appendix => ({
      key: appendix.key,
      title: appendix.title,
      pages: appendix.pages,
      rows: options.includeRows === false ? undefined : appendix.rows,
      owners: appendix.owners,
      duplicateContentOf: appendix.duplicateContentOf,
      shared: appendix.shared,
      // The exact reference the line made, so the record can be tied back to
      // the printed cell or attribute that pointed at this appendix.
      reference: (line.appendixRefs ?? []).find(ref => ref.resolvedKey === appendix.key) ?? null,
    }));
  return {
    id: line.id,
    fields: line.fields,
    pageNumbers: line.pageNumbers,
    complete: line.complete,
    continued: line.continued,
    anomalies: line.anomalies,
    pages,
    appendices,
    registration: result.registration,
    revision: result.revision,
    document: result.document,
  };
}

export const internals = { RESULT_FILE, EVIDENCE_FILE, loadResumable };
