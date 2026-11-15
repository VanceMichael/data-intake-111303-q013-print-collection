import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';

const { run, lookupLine, internals } = await import('../src/workflow.mjs');
const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
const printScenario = cases.find(item => item.productNumber === 16);

async function withPrintRun(callback, input = printScenario.input) {
  const source = await startSource(printScenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'print-collection-'));
  try {
    const result = await run({ source: source.url, stateDir, input });
    return await callback({ result, stateDir, source });
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('打印视图采集：正文逻辑行来自打印媒体而非屏幕摘要', { timeout: 20000 }, async () => {
  await withPrintRun(async ({ result }) => {
    assert.equal(result.state, 'collected');
    assert.equal(result.registration, 'reg-9');
    assert.equal(result.revision, 3);
    assert.deepEqual(result.ids, ['L1', 'L2', 'L3', 'L4']);
    // The screen-only summary row S1 is counted and excluded.
    assert.equal(result.screenOnlyCount, 1);
    assert.ok(!result.ids.includes('S1'));
    assert.ok(!JSON.stringify(result.collected.lines).includes('屏幕摘要行'));
    assert.ok(result.document.media === 'print');
  });
});

test('打印视图采集：分页续行按 data-line 合并且保留每一打印页', { timeout: 20000 }, async () => {
  await withPrintRun(async ({ result }) => {
    const line = result.collected.lines.find(candidate => candidate.id === 'L2');
    assert.deepEqual(line.pageNumbers, [1, 2]);
    assert.deepEqual(line.fields['内容'], ['岩芯上段', '附深层说明']);
    assert.equal(line.fields['编号'], 'L2');
    assert.equal(line.complete, true);
    const roles = line.sourcePages.map(source => source.role);
    assert.deepEqual(roles, ['base', 'continuation']);
    // Each value is attributable to a concrete print page and row.
    assert.deepEqual(line.sourcePages.map(source => source.pageNumber), [1, 2]);
    assert.ok(line.sourcePages.every(source => Number.isInteger(source.rowNumber)));
  });
});

test('打印视图采集：页脚、水印、作废标记、空白占位不进入登记字段', { timeout: 20000 }, async () => {
  await withPrintRun(async ({ result }) => {
    for (const bucket of ['footer', 'watermark', 'voidMark', 'repeatedHeader']) {
      assert.ok(result.collected.excluded[bucket].length > 0, '缺少排除证据 ' + bucket);
    }
    const values = JSON.stringify(result.collected.lines.map(line => line.fields));
    for (const noise of ['第1页', '第2页', '第3页', '档案副本', '作废', '以下空白']) {
      assert.ok(!values.includes(noise), '噪声进入登记字段：' + noise);
    }
    // Repeated headers across pages never become data rows.
    const repeated = result.collected.excluded.repeatedHeader[0];
    assert.equal(repeated.pageNumber, 2);
    assert.equal(result.collected.documents[0].pages[1].repeatedHeaders, 1);
    // ...and the repeated header is linked to the continuation rows below it.
    const headerRegistry = result.collected.documents[0].repeatedHeaders;
    assert.equal(headerRegistry.length, 1);
    assert.deepEqual(headerRegistry[0].columnNames, ['编号', '内容', '附表']);
    assert.ok(headerRegistry[0].linkedLineIds.includes('L2'));
    const l2 = result.collected.lines.find(line => line.id === 'L2');
    const continuation = l2.sourcePages.find(source => source.pageNumber === 2);
    assert.equal(continuation.repeatedHeader.pageNumber, 2);
    assert.deepEqual(continuation.repeatedHeader.columns, ['编号', '内容', '附表']);
  });
});

test('打印视图采集：跨页附表按声明标识合并并保留页序', { timeout: 20000 }, async () => {
  await withPrintRun(async ({ result }) => {
    const appendix = result.collected.appendices.find(item => item.key === 'doc-main::appendix:a');
    assert.ok(appendix);
    assert.deepEqual(appendix.pages, [2, 3]);
    assert.equal(appendix.totalRows, 3);
    assert.deepEqual(appendix.rows.map(row => row.cells[0].value), ['a1', 'a2', 'a3']);
    assert.deepEqual(appendix.rows.map(row => row.pageNumber), [2, 2, 3]);
    assert.equal(appendix.orphan, false);
  });
});

test('打印视图采集：跨文档共用的附表不因内容相同丢失归属', { timeout: 20000 }, async () => {
  await withPrintRun(async ({ result }) => {
    const byKey = new Map(result.collected.appendices.map(item => [item.key, item]));
    // Appendix A is referenced from two documents and keeps both owners.
    const shared = byKey.get('doc-main::appendix:a');
    assert.deepEqual(shared.owners.map(owner => owner.lineId).sort(), ['L1', 'L4']);
    assert.equal(shared.shared, true);
    // B and C have identical content but remain distinct appendices with their
    // own document ownership; content equality is recorded, not merged.
    const b = byKey.get('doc-main::appendix:b');
    const c = byKey.get('doc-supplement::appendix:c');
    assert.ok(b && c && b.key !== c.key);
    assert.equal(b.contentHash, c.contentHash);
    assert.ok(b.duplicateContentOf.includes(c.key));
    assert.ok(c.duplicateContentOf.includes(b.key));
    assert.equal(b.documentId, 'doc-main');
    assert.equal(c.documentId, 'doc-supplement');
    assert.deepEqual(c.owners.map(owner => owner.lineId).sort(), ['L3', 'L4']);
  });
});

test('打印视图采集：等待生成完成，不接受 composing 首轮布局', { timeout: 20000 }, async () => {
  await withPrintRun(async ({ result, stateDir }) => {
    const evidence = JSON.parse(await readFile(path.join(stateDir, internals.EVIDENCE_FILE), 'utf8'));
    const readiness = evidence.readiness;
    // The render tracker snapshots every print document inserted after the
    // click, so cached/stale/composing previews remain visible in the evidence
    // even though they were replaced before the gate settled.
    const history = readiness.history;
    assert.ok(history.some(item => item.cached), '未记录缓存预览');
    assert.ok(history.some(item => item.revision === '2'), '未记录旧修订预览');
    assert.ok(history.some(item => item.composing), '未记录 composing 首轮布局');
    // The accepted document is the final three-page main document.
    assert.equal(result.document.id, 'doc-main');
    assert.equal(result.document.pageCount, 3);
    // Readiness is gate-based, not a fixed sleep.
    assert.ok(readiness.diagnostics.stableCount >= readiness.diagnostics.stableFrames);
    assert.equal(readiness.diagnostics.fontStatus, 'loaded');
    assert.ok(readiness.diagnostics.mutations > 0);
  });
});

test('打印视图采集：重新生成后读取新的打印文档', { timeout: 25000 }, async () => {
  const scenario = cases.find(item => item.mode === 'regenerate');
  const source = await startSource(printScenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'print-collection-'));
  try {
    const result = await run({ source: source.url, stateDir, input: scenario.input });
    assert.equal(result.state, 'collected');
    assert.deepEqual(result.ids, ['L1', 'L2', 'L3', 'L4']);
    const evidence = JSON.parse(await readFile(path.join(stateDir, internals.EVIDENCE_FILE), 'utf8'));
    assert.equal(evidence.regeneration.firstAttempt.document.generation, 1);
    assert.equal(result.document.generation, 2);
    assert.ok(evidence.regeneration.secondGeneration >= 2);
    assert.equal(source.portal.actions.filter(action => action.action === 'generate').length, 2);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('打印视图采集：结果落盘并可回查一条记录的打印稿依据', { timeout: 20000 }, async () => {
  await withPrintRun(async ({ result, stateDir }) => {
    const saved = JSON.parse(await readFile(path.join(stateDir, internals.RESULT_FILE), 'utf8'));
    assert.equal(saved.state, 'collected');
    assert.deepEqual(saved.ids, result.ids);
    assert.equal(saved.registration, 'reg-9');
    assert.equal(saved.revision, 3);

    const lookup = await lookupLine(stateDir, 'L3');
    assert.equal(lookup.id, 'L3');
    assert.deepEqual(lookup.pageNumbers, [2]);
    // L3 points at appendices B and C; B lives on page 3 of the main document.
    const appendixB = lookup.appendices.find(item => item.key === 'doc-main::appendix:b');
    assert.ok(appendixB);
    assert.deepEqual(appendixB.pages, [3]);
    assert.ok(lookup.pages[0].cells.some(cell => cell.header === '附表' && cell.value.includes('附表B')));
  });
});

test('打印视图采集：失败结果为 unavailable 且不落屏幕摘要', { timeout: 20000 }, async () => {
  const failing = cases.find(item => item.mode === 'failed');
  const source = await startSource(failing);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'print-collection-'));
  try {
    const result = await run({ source: source.url, stateDir, input: failing.input });
    assert.equal(result.state, 'unavailable');
    assert.deepEqual(result.ids, []);
    assert.equal(result.document, null);
    assert.equal(result.reason, 'generation-failed');
    const saved = JSON.parse(await readFile(path.join(stateDir, internals.RESULT_FILE), 'utf8'));
    assert.equal(saved.state, 'unavailable');
    assert.deepEqual(saved.ids, []);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('打印视图采集：重启只复用可追溯的完整进度', { timeout: 25000 }, async () => {
  const source = await startSource(printScenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'print-collection-'));
  try {
    const first = await run({ source: source.url, stateDir, input: printScenario.input });
    assert.equal(first.state, 'collected');
    const requestsBefore = source.history.length;
    const second = await run({ source: source.url, stateDir, input: printScenario.input });
    assert.equal(second.state, 'collected');
    assert.deepEqual(second.ids, first.ids);
    // A traceable, complete persisted result is reused without reopening the
    // portal; no additional source access happens.
    assert.equal(source.history.length, requestsBefore);

    // A different revision must not reuse the persisted result.
    const third = await run({ source: source.url, stateDir, input: { ...printScenario.input, revision: 2 } });
    assert.notDeepEqual(third.ids, first.ids);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('打印视图采集：不完整进度不会被当成成功复用', { timeout: 15000 }, async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'print-collection-'));
  const inputKey = JSON.stringify({
    registration: printScenario.input.registration,
    revision: printScenario.input.revision,
    portalPath: printScenario.input.portalPath,
    generateSelector: null,
    regenerate: false,
    source: 'http://127.0.0.1:1',
  });
  try {
    // A result that claims success but whose evidence is incomplete must not be
    // resumed; the workflow has to re-collect (and here, fails honestly).
    await writeFile(path.join(stateDir, internals.RESULT_FILE), JSON.stringify({
      state: 'collected', registration: 'reg-9', revision: 3, ids: ['L1', 'L2', 'L3', 'L4'],
      screenOnlyCount: 0, collected: { complete: false, lines: [] }, inputKey,
    }));
    await writeFile(path.join(stateDir, internals.EVIDENCE_FILE), JSON.stringify({
      resultState: 'collected', collected: { complete: false, lines: [] },
    }));
    const resumable = await internals.loadResumable(stateDir, inputKey);
    assert.equal(resumable, null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('打印视图采集：附表缺失时结果标记不完整并说明异常', { timeout: 20000 }, async () => {
  const anomalous = cases.find(item => item.mode === 'appendix-missing');
  const source = await startSource(anomalous);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'print-collection-'));
  try {
    const result = await run({ source: source.url, stateDir, input: anomalous.input });
    // The rows are still readable, but completeness is not claimed.
    assert.deepEqual(result.ids, ['L1', 'L2', 'L3', 'L4']);
    assert.equal(result.state, 'incomplete');
    assert.equal(result.collected.complete, false);
    const unresolved = result.collected.anomalies.filter(anomaly => anomaly.code === 'unresolved-appendix-reference');
    assert.deepEqual(unresolved.map(anomaly => anomaly.lineId).sort(), ['L3', 'L4']);
    assert.ok(!result.collected.appendices.some(appendix => appendix.declaredId === 'C'));
    // The other appendix stays fully attributed.
    const appendixA = result.collected.appendices.find(appendix => appendix.key === 'doc-main::appendix:a');
    assert.deepEqual(appendixA.owners.map(owner => owner.lineId).sort(), ['L1', 'L4']);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('打印视图采集：异常文档在结果中单独说明', { timeout: 20000 }, async () => {
  await withPrintRun(async ({ result }) => {
    // Healthy documents must not fabricate anomalies.
    assert.deepEqual(result.collected.anomalies, []);
    for (const document of result.collected.documents) {
      assert.ok(Array.isArray(document.anomalies));
      assert.ok(document.pageNumbers.length === document.pageCount);
    }
    // Every print document that appeared after the click is described with
    // its own reason, including the cached preview and the composing pass.
    const occurred = result.collected.occurredDocuments;
    assert.ok(occurred.some(item => item.reason === 'cached-preview'));
    assert.ok(occurred.some(item => item.reason === 'revision-mismatch'));
    assert.ok(occurred.some(item => item.reason === 'document-composing'));
    assert.ok(occurred.every(item => Number.isFinite(item.seenAtMs)));
  });
});
