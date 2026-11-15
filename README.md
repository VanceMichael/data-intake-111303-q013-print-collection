# 打印视图中的跨页登记资料采集

这是 print-collection 的 Node.js 项目。包含本地资料源、来源检查、接口演练，以及从真实浏览器打印视图采集结构化登记资料的工作流（`src/workflow.mjs`）。

工作流在 Chromium 中触发“生成打印件”，等待属于当前登记号与修订号的打印文档完成字体加载与分页重排，再按 print media 样式提取正文与附表。它不会调用现成 JSON 导出，也不用固定 sleep 后截图；屏幕隐藏字段、页脚、作废水印和空白占位都不会变成登记字段。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。浏览器使用 Playwright 1.56.1 与 Chromium，镜像中包含匹配的浏览器。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t print-collection:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
npm start -- --host 127.0.0.1 --port 3000
```

`npm test` 检查已有资料源与真实浏览器页面。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

`npm start` 启动带业务接口的门户服务，首页与 `/portal` 均可操作。可用 `HOST`、`PORT` 配置监听地址，也可通过 `--host`、`--port` 覆盖；默认使用回环地址和自动分配端口。页面与 `/portal/state`、`/portal/action` 必须由同一进程提供，不能只用静态文件服务器托管 web 目录。

## 工作流接入

业务入口约定为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入，stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json，其他持久状态布局由业务模块决定。不能依赖调用方持有的内存来完成恢复。

input.registration/revision 指定打印文档。点击生成后 page-ready 与 data-revision 表示当前预览业务状态；打印树须在 print media 下可见。逻辑行使用 data-line，续页同号片段合并并保留页码。输出 ids、registration、revision、screenOnlyCount；失败输出 state=unavailable、ids=[]。`input.portalPath` 可指定门户页面（默认 `/portal`，打印演示为 `/print`），`input.regenerate` 为真时点击两次生成并证明读到的是新的打印文档。

除上述最小字段外，结果还包含 `document`、`collected.documents`、`collected.lines`（每行 `fields` 与 `sourcePages`）、`collected.appendices`（页序、行、归属、相同内容关系）、`collected.occurredDocuments`（点击后出现过、被拒绝的文档及原因）、`collected.excluded`（页脚/水印/作废/占位/屏幕专用证据）与 `collected.anomalies`。`evidence.json` 保存等待判定、候选、历史与请求证据；`lookupLine(stateDir, lineId)` 回查一条记录所处打印页与行。

采集实现位于 `src/collect.mjs`（浏览器编排与判定）、`src/print-view.mjs`（页内观察器与就绪判定）、`src/print-extract.mjs`（print media 提取）。等待判定基于身份、点击后新鲜度、非缓存/非合成、打印可见、字体与布局稳定，而非固定 sleep。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm test          # 含 test/print-collection.test.mjs 的打印视图采集核对
npm run demo
```

acceptance 检查结果、落盘内容和实际来源访问；demo 从干净临时状态启动本地服务，依次执行业务合同场景与打印视图场景（附表跨页、重新生成、缓存预览），并回查一条记录在实际打印稿中的依据。演示不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none print-collection:local npm test`。工作流开发完成后执行 `docker run --rm --network none print-collection:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
