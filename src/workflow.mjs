import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// 就绪判定的上限等待时间（兜底，不是固定 sleep）
const READY_TIMEOUT_MS = 10_000;
// 打印树静默判定的上限等待时间
const QUIET_TIMEOUT_MS = 3_000;

// 点击生成前注入的观察器：记录 #preview 上出现的每一次业务状态。
// 旧登记号/旧修订的缓存预览会先出现，必须按身份识别跳过，不能按到达顺序取版本。
function installPreviewWatch() {
  const panel = document.querySelector('#preview');
  window.__printWatch = [];
  if (!panel) return;
  const record = () => {
    window.__printWatch.push({
      state: panel.dataset.state ?? null,
      registration: panel.dataset.registration ?? null,
      revision: panel.dataset.revision ?? null,
      ready: panel.classList.contains('page-ready'),
      at: Math.round(performance.now()),
    });
  };
  record();
  new MutationObserver(record).observe(panel, { attributes: true, childList: true });
}

// 就绪探针：只有预览业务状态为 ready 且登记号、修订号都属于本次输入才算可读取；
// 生成失败时立即返回 failed。返回 false 表示继续等（轮询条件，不是固定等待）。
function outcomeProbe({ registration, revision }) {
  const panel = document.querySelector('#preview');
  if (!panel) return false;
  if (panel.dataset.state === 'failed') return { status: 'failed' };
  const ready = panel.dataset.state === 'ready'
    && panel.classList.contains('page-ready')
    && panel.dataset.registration === registration
    && panel.dataset.revision === String(revision);
  return ready ? { status: 'ready' } : false;
}

// 静默探针：字体加载完成且打印树连续三帧无 DOM 变动（分页重排结束）才放行。
function quietProbe() {
  return new Promise(resolve => {
    const panel = document.querySelector('#preview');
    if (!panel) { resolve('no-panel'); return; }
    let dirty = 0;
    const observer = new MutationObserver(() => { dirty += 1; });
    observer.observe(panel, { subtree: true, childList: true, attributes: true, characterData: true });
    let calmFrames = 0;
    const step = () => {
      if (dirty === 0 && document.fonts.status === 'loaded') calmFrames += 1;
      else calmFrames = 0;
      dirty = 0;
      if (calmFrames >= 3) { observer.disconnect(); resolve('quiet'); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// 读取并压缩预览时间线（连续相同状态只保留一条），用于证明缓存预览被识别并跳过。
function readPreviewTimeline() {
  const raw = window.__printWatch ?? [];
  const compact = [];
  for (const entry of raw) {
    const last = compact[compact.length - 1];
    if (!last || last.state !== entry.state || last.registration !== entry.registration
      || last.revision !== entry.revision || last.ready !== entry.ready) compact.push(entry);
  }
  return compact;
}

// 打印媒体下的结构化提取。只在 emulateMedia('print') 之后调用：
// 打印树在屏幕样式下 display:none，打印样式下才可见；屏幕摘要等隐藏字段在此不可见，
// 不会被当作打印内容。页脚、水印、空白占位只计入 furniture，不产生登记字段。
function extractPrintDocument() {
  const panel = document.querySelector('#preview');
  const printVisible = element => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible') return false;
    }
    return element.getClientRects().length > 0;
  };
  const pages = [...panel.querySelectorAll('.print-page')];
  const furniture = { repeatedHeaders: 0, footers: 0, watermarks: 0, placeholders: 0 };
  const lines = [];
  const byId = new Map();
  let hiddenCandidates = 0;
  for (const [index, pageEl] of pages.entries()) {
    const pageNo = Number(pageEl.dataset.page ?? index + 1);
    furniture.repeatedHeaders += pageEl.querySelectorAll('thead').length;
    furniture.footers += pageEl.querySelectorAll('footer').length;
    furniture.watermarks += pageEl.querySelectorAll('.watermark').length;
    furniture.placeholders += pageEl.querySelectorAll('[data-placeholder]').length;
    for (const row of pageEl.querySelectorAll('[data-line]')) {
      if (row.closest('footer, .watermark, .screen-only, [aria-hidden="true"]') || !printVisible(row)) {
        hiddenCandidates += 1;
        continue;
      }
      const id = row.dataset.line;
      let line = byId.get(id);
      if (!line) { line = { id, fragments: [] }; byId.set(id, line); lines.push(line); }
      line.fragments.push({
        page: pageNo,
        cells: [...row.children].map(cell => cell.textContent.trim()),
        continued: row.dataset.continued === 'true' || undefined,
        continuation: row.dataset.continuation === 'true' || undefined,
        selector: `#preview .print-page[data-page="${pageNo}"] [data-line="${id}"]`
          + (row.dataset.continuation === 'true' ? '[data-continuation]' : ''),
      });
    }
  }
  // 续页同号片段合并：同一 data-line 的多个片段归入一条逻辑行，保留各自打印页码
  for (const line of lines) line.pages = [...new Set(line.fragments.map(fragment => fragment.page))];
  // 回查校验：最终逻辑行片段必须都能定位到打印媒体下可见的节点，
  // 屏幕专属内容混入数（screenOnlyCount）由此实测得出，而不是硬编码 0。
  let screenOnlyCount = 0;
  for (const line of lines) {
    for (const fragment of line.fragments) {
      const node = document.querySelector(fragment.selector);
      if (!node || !printVisible(node) || node.closest('.screen-only')) screenOnlyCount += 1;
    }
  }
  return {
    registration: panel.dataset.registration,
    revision: Number(panel.dataset.revision),
    pageCount: pages.length,
    lines,
    furniture,
    hiddenCandidates,
    screenOnlyElements: document.querySelectorAll('.screen-only').length,
    screenOnlyCount,
  };
}

export async function run({ source, stateDir, input }) {
  const registration = input?.registration;
  const revision = input?.revision;
  const anomalies = [];
  const diagnostics = {};
  let result;
  let browser;
  try {
    if (!registration || revision === undefined) throw new Error('input.registration/revision 缺失');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`${source}/portal`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#generate');
    await page.evaluate(installPreviewWatch);
    // 通过真实页面动作触发生成，登记号以本次输入为准
    await page.fill('#registration', registration);
    await page.click('#generate');
    // 等待属于当前登记号及修订号的打印文档；旧修订缓存预览不满足身份条件，继续等
    const handle = await page.waitForFunction(outcomeProbe, { registration, revision }, { timeout: READY_TIMEOUT_MS });
    const outcome = await handle.jsonValue();
    diagnostics.previewTimeline = await page.evaluate(readPreviewTimeline);
    for (const entry of diagnostics.previewTimeline) {
      if (entry.ready && (entry.registration !== registration || entry.revision !== String(revision))) {
        anomalies.push({
          code: 'STALE_PREVIEW_SKIPPED',
          detail: `生成后先出现 ${entry.registration} 修订 ${entry.revision} 的缓存预览，已跳过并等待修订 ${revision}`,
        });
      }
    }
    if (outcome.status === 'failed') {
      anomalies.push({ code: 'GENERATION_FAILED', detail: '门户返回生成失败，预览未就绪；屏幕摘要不能当作打印资料' });
      result = { state: 'unavailable', ids: [], registration, revision, anomalies, diagnostics };
    } else {
      // 字体加载与分页重排结束后再读；超时则记录异常并按现状提取
      const quietProbePromise = page.evaluate(quietProbe).catch(() => 'error');
      const quiet = await Promise.race([
        quietProbePromise,
        new Promise(resolve => setTimeout(resolve, QUIET_TIMEOUT_MS, 'timeout')),
      ]);
      diagnostics.layout = quiet;
      if (quiet !== 'quiet') anomalies.push({ code: 'LAYOUT_NOT_QUIET', detail: `打印树静默判定未通过（${quiet}），按当前状态提取` });
      // 按打印媒体样式提取正文与附表，屏幕隐藏字段在此不可见
      await page.emulateMedia({ media: 'print' });
      const extracted = await page.evaluate(extractPrintDocument);
      // 回查依据：就绪后的打印 DOM 快照与实际打印稿 PDF
      const evidence = { dom: 'evidence/print-view.html', pdf: 'evidence/print.pdf' };
      try {
        const evidenceDir = path.join(stateDir, 'evidence');
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(path.join(evidenceDir, 'print-view.html'), await page.content());
        await page.pdf({ path: path.join(evidenceDir, 'print.pdf'), printBackground: true });
      } catch (error) {
        anomalies.push({ code: 'EVIDENCE_ERROR', detail: String(error?.message ?? error) });
      }
      // 归属按“登记号@修订号”键控：内容相同的行在不同文档实例下各自归属，不按内容合并
      const documentKey = `${extracted.registration}@${extracted.revision}`;
      result = {
        state: 'collected',
        registration: extracted.registration,
        revision: extracted.revision,
        ids: extracted.lines.map(line => line.id),
        screenOnlyCount: extracted.screenOnlyCount,
        lines: extracted.lines,
        documents: {
          [documentKey]: { lineIds: extracted.lines.map(line => line.id), pageCount: extracted.pageCount },
        },
        evidence,
        diagnostics: {
          ...diagnostics,
          pageCount: extracted.pageCount,
          furniture: extracted.furniture,
          hiddenCandidatesExcluded: extracted.hiddenCandidates,
          screenOnlyElements: extracted.screenOnlyElements,
        },
        anomalies,
        collectedAt: new Date().toISOString(),
      };
    }
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? 'READY_TIMEOUT' : 'COLLECTION_ERROR';
    anomalies.push({ code, detail: String(error?.message ?? error) });
    result = { state: 'unavailable', ids: [], registration, revision, anomalies, diagnostics };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  // 结果落盘，恢复不依赖调用方内存
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}
