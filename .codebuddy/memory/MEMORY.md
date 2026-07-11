# Project Memory — cat-catch

## 项目结构
- 浏览器扩展(cat-catch),主页面 `m3u8.html` / `mpd.html` / `downloader.html`
- 业务代码位于 `js/`,工具/工具库位于 `lib/`
- i18n 在 `_locales/<lang>/messages.json` 中,语言:zh_CN, zh_TW, en, ja, es, pt_BR, tr, vi
- 全局工具函数 `secToTime` / `appendZero` 在 `js/function.js`,先于 `js/m3u8.js` 加载

## 下载范围 (m3u8.html)
- 输入 `#rangeStart` / `#rangeEnd`,支持序号(纯数字,1-based)或 `HH:MM:SS` 时间格式
- 默认值由 `secToTime(0)` 与 `secToTime(data.totalduration)` 设置(2026-07-05 改为时间格式)
- 解析函数 `timeToIndex` 与 `parseTimeToSeconds` 在 `js/m3u8.js` 末尾
- i18n 键:`downloadRange`, `startTime`, `endTime`, `sNumError`, `startGTend`, `sNumMax`

## 范围相关代码点
- `#mergeTs` 解析:js/m3u8.js 行 1163-1193
- `#rangeConfirm` 解析与切片高亮:行 1290-1331
- `#cc` (DISCONTINUITY) 处理:行 1345-1370
- `getM3u8DlREArg` (N_m3u8DL-RE 模式):行 1959-1972
- `getM3u8DlArg` (N_m3u8DL 模式):行 2010-2022

## 失败自动重试 (2026-07-05)
- 复选框 `#autoRetry` 位于 m3u8.html 下载选项区,不持久化
- 逻辑在 `downloadNew` 函数的 `downloadError` 事件处理中(js/m3u8.js)
- 使用 `autoRetryCount` Map 追踪每个切片的失败次数,最多重试 3 次(`MAX_AUTO_RETRY = 3`)
- 成功后 `autoRetryCount.delete(fragment.index)` 清除计数
- 3 次重试均失败后,仍显示错误 UI,允许手动重试
- i18n 键:`autoRetry`(标签), `autoRetrying`(进度提示,参数 $1=序号 $2=当前次数 $3=最大次数)
- Downloader 类(js/m3u8.downloader.js)本身不变,自动重试由 m3u8.js 层实现

## 侧边栏宽度 (2026-07-05)
- Chrome sidePanel API 无宽度参数,通过 `min-width` CSS 控制初始宽度
- `min-width: 1000px` (固定像素) 而非 `50vw`,因为侧边栏 iframe 中 vw 解析值偏小
- 修改位置: `js/m3u8.js` 第139行, `js/mpd.js` 第31行

## 侧边栏状态丢失修复 (2026-07-05)
- 问题: 切标签页后侧边栏从解析页面重置回 popup.html
- 根因: `background.js` 的 `chrome.tabs.onUpdated` 无条件调用 `setOptions(path: "popup.html")`
- 修复: 仅在 `changeInfo.status === 'loading'` 时重置,避免已加载标签切回时被覆盖
- 修改位置: `js/background.js` 第647-652行
