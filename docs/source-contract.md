# 来源与接收约定

input.registration/revision 指定打印文档。点击生成后 page-ready 与 data-revision 表示当前预览业务状态；打印树须在 print media 下可见。逻辑行使用 data-line，续页同号片段合并并保留页码。输出 ids、registration、revision、screenOnlyCount；失败输出 state=unavailable、ids=[]。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 打印附表跨页重组

业务输入：
```json
{
  "registration": "reg-1",
  "revision": 2
}
```
结果必须包含：
```json
{
  "registration": "reg-1",
  "revision": 2,
  "ids": [
    "l1",
    "l2"
  ],
  "screenOnlyCount": 0
}
```

### 旧预览不是当前修订

业务输入：
```json
{
  "registration": "reg-1",
  "revision": 2
}
```
结果必须包含：
```json
{
  "registration": "reg-1",
  "revision": 2,
  "ids": [
    "l1",
    "l2"
  ]
}
```

### 生成失败不接受屏幕摘要

业务输入：
```json
{
  "registration": "reg-1",
  "revision": 2
}
```
结果必须包含：
```json
{
  "state": "unavailable",
  "ids": []
}
```

## 打印视图采集链路

业务入口 `src/workflow.mjs` 调用 `src/collect.mjs`，用 Playwright 1.56.1 与 Chromium 打开真实门户。采集过程不调用 JSON 导出接口、不读门户内部状态、不以固定 sleep 后截图代替判断。

### 触发与可读取判定

1. 页面加载后先安装 DOM/字体观察器 `installRenderTracker`（`src/print-view.mjs`）。它记录点击前的 epoch，并为点击后插入或更新的节点分配更大的 epoch，同时把每个出现的打印文档快照写入 `history`。
2. 在 screen media 下用真实点击触发“生成打印件”。打印控制本身可能是 `.screen-only`，因此点击不能发生在 print media 下。
3. 立即切换到 print media，此时 `.screen-only` 隐藏、`.print-page` 可见。
4. 只有同时满足以下条件才判定可读取，任一条件不满足就继续等待：
   - **身份**：打印文档自身的 `data-registration` 与 `data-revision`（或标题文本）等于请求值；`data-generation` 只用于在候选间排序，不作为内容来源。
   - **来源新鲜**：文档或页面的 epoch 大于点击时的 epoch，排除点击前就存在的旧预览。
   - **非缓存/非作废/非合成中**：`data-cached`、`data-document-state="void"`、`data-document-state="composing"` 都会被拒绝。
   - **打印可见**：至少有一页 `[data-page]`/`.print-page` 在 print media 下有真实盒模型。
   - **字体稳定**：`document.fonts` 为 loaded，且最近 `quietMs` 内没有字体事件。
   - **布局稳定**：页框坐标、页数、`document.fonts.status` 与观察器 epoch 组成的签名连续 `stableFrames` 帧不变，且 `quietMs` 内无相关 DOM 变更。
5. 读取时在页内再次按同一规则匹配，并把打印文档克隆到离屏宿主（保持 print media），读取前后比较页框签名；签名变化则重试，不返回撕裂的读取。

`waitForPrintDocument` 的返回包含 `candidates`（每个候选及拒绝原因）与 `history`（点击后出现过的全部打印文档快照），因此缓存的旧登记号预览、旧修订预览和首轮 composing 布局都会在证据中单独说明。

### 提取规则

- **正文逻辑行**：主表行带 `data-line`，以 `data-line` 合并跨页片段。`data-continued` 标记溢出的首段，`data-continuation` 标记续页片段；合并后 `fields` 保留各列值，`sourcePages` 保留每个片段所在文档、打印页、行号与角色。
- **重复表头**：`thead` 行、全 `TH` 行，以及后续页重复出现的已知表头签名都记入 `excluded.repeatedHeader`，不产生登记行。
- **页脚/页码/页眉**：`footer`、`tfoot`、`data-page-number` 及“第 N 页/共 M 页”文本记入 `excluded.footer` 或 `excluded.pageNumber`。
- **水印与作废**：`data-watermark`、`watermark`、`data-void`/`data-voided`/`作废` 记入 `excluded.watermark` 或 `excluded.voidMark`，绝不进入字段。
- **空白占位**：`data-placeholder`、`placeholder/blank/empty-row` 类名、全空或全为占位符的行记入 `excluded.placeholder`。
- **屏幕专用内容**：print media 下不可见的 `.screen-only`/`[data-summary]`/`[data-screen-only]` 记入 `excluded.screenOnly`。若其中带 `data-line` 且该行没有出现在打印正文中，计入 `screenOnlyCount`，但不会出现在 `ids`。
- **附表**：以“文档 + 声明的 `data-appendix-id`（缺省时按物理页/表位置）”为键，不以内容为键。附表跨页片段按页序合并；内容完全相同的两份附表仍是两个不同的附表，通过 `contentHash` 和 `duplicateContentOf` 记录相同关系。
- **附表归属**：正文行通过 `data-appendix-id` 等属性或“附表/附录/附件”列引用附表。引用在本文档内解析，同一登记/修订的其它文档也可解析（`crossDocument`）；同一附表可被多份文档、多行引用（`owners`），不会因内容相同而丢失归属。
- **完整性与异常**：`complete` 要求布局稳定、至少一条逻辑行、每行有首段、且没有未解析引用、无主附表、无打印页文档、无缺失 `data-line` 行等阻断异常。异常逐条写入 `anomalies`，并归入对应文档的 `documents[].anomalies`。附表缺失等异常使 `state=incomplete` 而不是 `unavailable`：已读到的行仍保留，但不会伪称完整。
- **异常文档单独说明**：`collected.occurredDocuments` 列出点击后出现过的每个打印文档（含缓存预览、旧修订、composing 首轮、最终稿）及各自原因和时间；`collected.rejectedDocuments` 列出本次读取时仍在页面上但被拒绝的文档。两者均不带 DOM 引用，可安全落盘。

### 演示门户

`productNumber` 16 的门户（`web/print-app.mjs`、`web/print.html`，页面路径 `/print`）模拟真实难点：先出现旧登记号的缓存预览，再出现旧修订预览，随后是一轮标记 `data-document-state="composing"` 的首轮排版，字体加载与重排后才出现最终稿。最终稿含跨页正文、跨页附表 A、内容相同但归属不同的附表 B/C，以及屏幕专用摘要行 S1。`fixtures/portal-font.ttf` 用于制造真实的字体加载与重排等待；运行时不访问外网。

### 持久化与回查

- `stateDir/result.json` 保存与返回值一致的业务结果（含 `ids`、`registration`、`revision`、`screenOnlyCount`、`document`、`collected`）。
- `stateDir/evidence.json` 保存点击与等待步骤、候选与历史、请求记录、提取结果与排除证据。
- 重启时只有输入完全相同、上次状态为 `collected`、`collected.complete === true` 且存在逻辑行的结果才会被复用；其余情况重新采集，失败结果绝不会在重启后变成成功。
- `lookupLine(stateDir, lineId)` 返回该记录各打印页的单元格、行号与角色，以及它引用的附表页序和归属，用于回查一条结构化记录在实际打印稿中的依据。
