// Client for the print-document portal (productNumber 16).
//
// The portal deliberately makes collection hard in the ways the real one does:
//   - a cached preview of an *older registration* appears first;
//   - a stale preview of revision 2 appears before revision 3;
//   - the print document is composed in two passes: an initial "composing"
//     layout, then a re-pagination after the print font has loaded;
//   - appendices span pages and are repeated by a second document;
//   - screen-only summary fields sit next to the print tree.
const app = document.querySelector('#app');
const state = await fetch('/portal/state').then(response => response.json());
const action = async value => {
  const response = await fetch('/portal/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  const result = await response.json();
  document.querySelector('#feedback').textContent = JSON.stringify(result, null, 2);
  return { ok: response.ok, value: result };
};

app.innerHTML = [
  '<div class="screen-only"><p data-summary="true">摘要旧值：3 条，附表 2 份（不能当完整资料）</p>',
  '<label>登记号 <input id="registration" value="reg-9"></label>',
  '<button id="generate">生成打印件</button>',
  '<button id="regenerate">重新生成</button>',
  '<span id="hidden-note" data-hidden-field="note">屏幕隐藏备注：不属于打印内容</span></div>',
  '<section id="preview" data-state="empty"></section>',
  '<pre id="feedback" aria-live="polite"></pre>',
].join('');

const panel = document.querySelector('#preview');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const row = (id, text, appendix, extra = {}) => {
  const attributes = [`data-line="${id}"`];
  for (const [name, value] of Object.entries(extra)) attributes.push(`${name}="${value}"`);
  const appendixCell = appendix ? `<td>${appendix}</td>` : '<td></td>';
  return `<tr ${attributes.join(' ')}><td>${id}</td><td>${text}</td>${appendixCell}</tr>`;
};

const mainTable = rows => [
  '<table class="main-table">',
  '<thead><tr><th>编号</th><th>内容</th><th>附表</th></tr></thead>',
  `<tbody>${rows.join('')}</tbody>`,
  '</table>',
].join('');

const appendixTable = (id, title, rows, options = {}) => {
  const attributes = [`data-appendix-id="${id}"`];
  if (options.continued) attributes.push('data-appendix-continued="true"');
  return [
    `<h3>${title}</h3>`,
    `<table ${attributes.join(' ')}>`,
    '<thead><tr><th>点号</th><th>深度</th></tr></thead>',
    `<tbody>${rows.join('')}</tbody>`,
    '</table>',
  ].join('');
};

function renderCachedPreview(generation) {
  panel.dataset.state = 'ready';
  panel.dataset.registration = 'reg-8';
  panel.dataset.revision = '1';
  panel.dataset.generation = String(Math.max(1, generation - 1));
  panel.innerHTML = [
    `<section class="print-doc page-ready" data-print-document data-doc-id="cache" data-cached="true"`,
    ` data-registration="reg-8" data-revision="1" data-generation="${Math.max(1, generation - 1)}">`,
    '<article class="print-page" data-page="1"><h2>登记 reg-8 修订 1（缓存预览）</h2>',
    '<table><thead><tr><th>编号</th><th>内容</th></tr></thead>',
    '<tbody><tr data-line="cache-1"><td>cache-1</td><td>旧登记号缓存行</td></tr></tbody></table>',
    '<footer>第1页</footer></article></section>',
  ].join('');
}

function renderStale(generation, registration = 'reg-9', revision = 2) {
  panel.dataset.state = 'ready';
  panel.dataset.registration = registration;
  panel.dataset.revision = String(revision);
  panel.dataset.generation = String(generation);
  panel.innerHTML = [
    '<section class="print-doc page-ready" data-print-document data-doc-id="stale-2"',
    ` data-registration="${registration}" data-revision="${revision}" data-generation="${generation}">`,
    `<article class="print-page" data-page="1"><h2>登记 ${registration} 修订 ${revision}</h2>`,
    '<table><thead><tr><th>编号</th><th>内容</th></tr></thead>',
    '<tbody><tr data-line="old-1"><td>old-1</td><td>上一修订的旧行</td></tr></tbody></table>',
    '<footer>第1页</footer></article></section>',
  ].join('');
}

// First composition pass: two pages, marked "composing" so a collector must
// not judge it readable.  Font loading will re-paginate it into three pages.
function renderComposing(generation, registration = 'reg-9', revision = 3) {
  panel.dataset.state = 'ready';
  panel.dataset.registration = registration;
  panel.dataset.revision = String(revision);
  panel.dataset.generation = String(generation);
  panel.innerHTML = [
    '<section class="print-doc page-ready" data-print-document data-doc-id="doc-main"',
    ` data-registration="${registration}" data-revision="${revision}" data-generation="${generation}" data-document-state="composing">`,
    `<article class="print-page" data-page="1"><h2>登记 ${registration} 修订 ${revision}</h2>`,
    mainTable([row('L1', '湖站水样', '附表A'), row('L2', '岩芯上段', '', { 'data-continued': 'true' })]),
    '<span class="watermark">档案副本</span><span class="void-mark" data-void="true">作废</span>',
    '<div class="screen-only" data-summary="true">摘要：共 3 条（屏幕摘要，不是打印内容）</div>',
    '<footer>第1页/共2页</footer></article>',
    '<article class="print-page" data-page="2">',
    mainTable([row('L2', '附深层说明', '', { 'data-continuation': 'true' })]),
    '<footer>第2页/共2页</footer></article></section>',
  ].join('');
}

// The portal's own release marker: only a document after the print font has
// loaded and re-pagination has finished gets `data-document-state="ready"`.
function renderFinal(generation, registration = 'reg-9', revision = 3) {
  const anomalous = state.mode === 'appendix-missing';
  panel.dataset.state = 'ready';
  panel.dataset.registration = registration;
  panel.dataset.revision = String(revision);
  panel.dataset.generation = String(generation);
  panel.dataset.documentState = 'ready';
  panel.innerHTML = [
    '<section class="print-doc page-ready" data-print-document data-doc-id="doc-main"',
    ` data-registration="${registration}" data-revision="${revision}" data-generation="${generation}" data-document-state="ready">`,
    // Page 1: two logical lines, the second spills to page 2.
    `<article class="print-page" data-page="1"><h2>登记 ${registration} 修订 ${revision}</h2>`,
    mainTable([
      row('L1', '湖站水样', '附表A'),
      row('L2', '岩芯上段', '', { 'data-continued': 'true' }),
      // A screen-only row that exists in the DOM but is hidden for print: it
      // must never become a registration field, and it is reported as
      // screen-only rather than silently dropped.
      '<tr class="screen-only" data-screen-only="true" data-line="S1"><td>S1</td><td>屏幕摘要行</td><td></td></tr>',
    ]),
    '<span class="watermark">档案副本</span><span class="void-mark" data-void="true">作废</span>',
    '<div class="screen-only" data-summary="true">摘要：共 3 条（屏幕摘要，不是打印内容）</div>',
    '<footer>第1页/共3页</footer></article>',
    // Page 2: repeated header + continuation fragment + L3, appendix A starts.
    '<article class="print-page" data-page="2">',
    mainTable([
      row('L2', '附深层说明', '', { 'data-continuation': 'true' }),
      row('L3', '沉积物', '附表B;附表C'),
      '<tr data-placeholder="true" class="placeholder"><td>以下空白</td><td></td><td></td></tr>',
    ]),
    appendixTable('A', '附表A 采样点清单', [
      '<tr><td>a1</td><td>1.5m</td></tr>',
      '<tr><td>a2</td><td>3.0m</td></tr>',
    ]),
    '<footer>第2页/共3页</footer></article>',
    // Page 3: appendix A continues, appendix B is introduced.
    '<article class="print-page" data-page="3">',
    appendixTable('A', '附表A 采样点清单（续）', [
      '<tr><td>a3</td><td>4.5m</td></tr>',
    ], { continued: true }),
    appendixTable('B', '附表B 设备清单', [
      '<tr><td>eq-1</td><td>采水器</td></tr>',
      '<tr><td>eq-2</td><td>流速仪</td></tr>',
    ]),
    '<footer>第3页/共3页</footer></article></section>',
    // Second document in the same print job.  It reuses appendix A (shared,
    // cross-document ownership) and prints appendix C whose content is
    // identical to appendix B; content equality must not erase ownership.
    '<section class="print-doc page-ready" data-print-document data-doc-id="doc-supplement"',
    ` data-registration="${registration}" data-revision="${revision}" data-generation="${generation}" data-document-state="ready">`,
    `<article class="print-page" data-page="1"><h2>补充登记 ${registration} 修订 ${revision}</h2>`,
    mainTable([row('L4', '补充记录', '附表A;附表C')]),
    // In the anomalous mode appendix C is never printed: L3/L4 reference an
    // appendix that does not exist, and the result must say so instead of
    // pretending the document is complete.
    anomalous ? '' : appendixTable('C', '附表C 设备清单（副本）', [
      '<tr><td>eq-1</td><td>采水器</td></tr>',
      '<tr><td>eq-2</td><td>流速仪</td></tr>',
    ]),
    '<footer>第1页/共1页</footer></article></section>',
  ].join('');
}

let generation = 0;
async function generate({ stale = true } = {}) {
  const reply = await action({ action: 'generate', registration: document.querySelector('#registration').value });
  if (!reply.ok || reply.value.failed) {
    panel.dataset.state = 'failed';
    panel.innerHTML = '';
    return;
  }
  generation = reply.value.generation ?? generation + 1;
  const revision = reply.value.revision ?? 3;
  const registration = reply.value.registration ?? document.querySelector('#registration').value;

  // An old registration's cached preview appears first, then a stale revision
  // of this registration.  Neither belongs to the requested print document.
  renderCachedPreview(generation);
  await wait(20);
  if (stale) {
    renderStale(generation, registration, revision - 1);
    await wait(20);
  }

  // First composition pass.  It is visibly incomplete and labelled composing.
  renderComposing(generation, registration, revision);

  // Font load + re-pagination.  `document.fonts.load` resolves only after the
  // print face has settled (or failed); the final layout is emitted after it.
  await document.fonts.load('16px PortalPrint').catch(() => {});
  await document.fonts.ready.catch(() => {});
  await wait(60);
  renderFinal(generation, registration, revision);
}

document.querySelector('#generate').onclick = () => generate({ stale: true });
document.querySelector('#regenerate').onclick = () => generate({ stale: false });
