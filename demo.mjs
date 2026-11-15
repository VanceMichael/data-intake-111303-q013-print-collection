import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from './src/source.mjs';

const { run, lookupLine } = await import('./src/workflow.mjs');
setTimeout(() => { console.error('运行超过 75 秒，停止并保留失败状态'); process.exit(124); }, 75000).unref();
const scenarios = JSON.parse(await readFile(new URL('./fixtures/cases.json', import.meta.url)));

// The contract scenarios first (screen summary, stale revision, failure), then
// the print-view scenarios (cross-page appendices, regeneration, cached preview).
const contract = scenarios.slice(0, 3);
const print = scenarios.filter(scenario => scenario.productNumber === 16);

async function execute(scenario) {
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'material-demo-'));
  try {
    const result = await run({ source: source.url, stateDir, input: scenario.input });
    console.log('实际来源访问：' + JSON.stringify(source.history.map(entry => ({ method: entry.method, path: entry.path }))));
    return { result, stateDir, source, scenario };
  } catch (error) {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
    throw error;
  }
}

console.log('== 业务合同场景 ==');
for (const scenario of contract) {
  console.log('\n正在执行：' + scenario.name);
  const { result, stateDir, source } = await execute(scenario);
  try {
    console.log(JSON.stringify({
      state: result.state,
      reason: result.reason ?? null,
      registration: result.registration,
      revision: result.revision,
      ids: result.ids,
      screenOnlyCount: result.screenOnlyCount,
      document: result.document,
      lines: result.collected?.lines?.map(line => ({
        id: line.id, pages: line.pageNumbers, fields: line.fields,
      })),
      excluded: result.collected ? Object.fromEntries(Object.entries(result.collected.excluded).map(([kind, items]) => [kind, items.length])) : undefined,
    }, null, 2));
  } finally { await source.close(); await rm(stateDir, { recursive: true, force: true }); }
}

console.log('\n\n== 打印视图采集：附表跨页 / 重新生成 / 缓存预览 ==');
for (const scenario of print) {
  console.log('\n正在执行：' + scenario.name);
  const { result, stateDir, source } = await execute(scenario);
  try {
    console.log(JSON.stringify({
      state: result.state,
      registration: result.registration,
      revision: result.revision,
      generation: result.generation,
      ids: result.ids,
      screenOnlyCount: result.screenOnlyCount,
      document: result.document,
      counts: result.collected?.counts,
      anomalies: result.collected?.anomalies,
      documentSummary: result.collected?.documents?.map(document => ({
        id: document.id, registration: document.registration, revision: document.revision,
        generation: document.generation, pages: document.pageNumbers, lineIds: document.lineIds,
        appendixKeys: document.appendixKeys,
      })),
      appendices: result.collected?.appendices?.map(appendix => ({
        key: appendix.key, title: appendix.title, pages: appendix.pages,
        rows: appendix.rows.map(row => row.cells.map(cell => cell.value).join(' / ')),
        owners: appendix.owners.map(owner => ({ lineId: owner.lineId, documentId: owner.documentId, pages: owner.pageNumbers })),
        duplicateContentOf: appendix.duplicateContentOf,
      })),
      excluded: result.collected ? Object.fromEntries(Object.entries(result.collected.excluded).map(([kind, items]) => [kind, items.length])) : undefined,
    }, null, 2));
  } finally { await source.close(); await rm(stateDir, { recursive: true, force: true }); }
}

// The final scenario's persisted state is recreated so the trace can be
// inspected; this shows that a record can be looked up in the actual print稿
// long after collection.
console.log('\n\n== 回查一条结构化记录在实际打印稿中的依据 ==');
const scenario = print[0];
const source = await startSource(scenario);
const stateDir = await mkdtemp(path.join(tmpdir(), 'material-demo-'));
try {
  await run({ source: source.url, stateDir, input: scenario.input });
  for (const lineId of ['L2', 'L3']) {
    const trace = await lookupLine(stateDir, lineId);
    console.log('\n记录 ' + lineId + '：');
    console.log(JSON.stringify({
      fields: trace.fields,
      pageNumbers: trace.pageNumbers,
      printPages: trace.pages.map(page => ({
        documentId: page.documentId, pageNumber: page.pageNumber, rowNumber: page.rowNumber,
        role: page.role, cells: page.cells.map(cell => cell.header + '=' + cell.value),
      })),
      appendices: trace.appendices.map(appendix => ({
        key: appendix.key, pages: appendix.pages,
        owners: appendix.owners.map(owner => owner.lineId),
        duplicateContentOf: appendix.duplicateContentOf,
      })),
    }, null, 2));
  }
} finally { await source.close(); await rm(stateDir, { recursive: true, force: true }); }
