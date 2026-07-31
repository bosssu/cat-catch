# LocalMediaWeb

本地媒体聚合浏览服务：把网页上的图片 / 动图 / 视频 / m3u8 **下载到本机 `Medias/`**，局域网用手机或 PC 以 **短视频 Feed（默认）** 或 **网格缩略图** 浏览。

- **管理页**：支持从手机相册上传图片/视频（服务端视频默认 remux）。
- **Feed**：可对当前媒体写点评（二次编辑）；删除请到网格或管理页。

配套浏览器扩展：同仓库 **猫抓 (cat-catch)** 的「解析页面图片 + 多选入库」。

## 快速开始（Windows）

1. 安装 [uv](https://github.com/astral-sh/uv)、建议安装 [ffmpeg](https://ffmpeg.org/)（m3u8 合并与视频封面需要）。
2. 双击 **`start.bat`**（或 `restart.bat`）。默认**不弹浏览器、隐藏控制台**（见 `config/settings.yaml`）。
3. 本机浏览器打开 <http://127.0.0.1:8790/>  
4. **手机访问**：同一 Wi‑Fi，地址为 `http://<电脑局域网IP>:8790/`
5. **开机自启（可选）**：双击 **`install-autostart.bat`** 一次 → 登录后后台启动。卸载：`uninstall-autostart.bat`。

### `settings.yaml` 启动相关

```yaml
open_browser: false    # true = 启动成功后打开桌面网页
hide_console: true     # true = 隐藏控制台（日志 data/logs/startup.log）
autostart: true        # install-autostart 时是否启用计划任务
autostart_uv_sync: false
```

### 手机打不开时

1. **服务必须监听 `0.0.0.0`，不能是 `127.0.0.1`**  
   在电脑 PowerShell 执行：  
   `Get-NetTCPConnection -LocalPort 8790 -State Listen`  
   - `LocalAddress` 应为 `0.0.0.0` 或 `::`  
   - 若是 `127.0.0.1`，手机永远进不来 → 用 `stop.bat` 后重新 `start.bat`
2. **Windows 防火墙放行 8790**  
   右键 **`open-firewall.bat` → 以管理员身份运行**（只需一次）
3. 手机与电脑同一局域网；电脑 Wi‑Fi 网络配置建议为 **专用/专用网络**（Private）
4. 关闭或放行第三方安全软件对入站的拦截

停止：`stop.bat`。

## 目录

| 路径 | 说明 |
|------|------|
| `Medias/{分类}/` | 媒体文件（可备份/手拷） |
| `data/media.db` | 索引与任务 |
| `data/thumbs/` | 缩略图缓存 |
| `config/settings.example.yaml` | 配置示例 → 复制为 `settings.yaml` |

环境变量前缀：`LMW_`（如 `LMW_PORT=8790`、`LMW_ACCESS_TOKEN=secret`）。

### 外站 m3u8 / CDN 连不上（ConnectError）

双击 `start.bat` 启动的进程**通常没有**终端里的 `HTTPS_PROXY`。请在 `config/settings.yaml` 写本地代理，例如 Clash 默认：

```yaml
http_proxy: "http://127.0.0.1:7897"
http_proxy_auto_probe: true
```

改完后用 `restart.bat` 重启。启动日志应出现 `Proxy: http://127.0.0.1:7897` 与 `Download modes: config:...`。

### 大文件直链加速（Gopeed）

PC 上安装 [Gopeed CLI](https://github.com/GopeedLab/gopeed) 后，**仅直链大文件**（HEAD `Content-Length` ≥ `gopeed_min_bytes`，默认 5MB）会先尝试 Gopeed 多连接下载；失败自动回退现有 httpx multi-range。**m3u8 / DASH / 截取不受影响。**

```yaml
gopeed_enabled: true
gopeed_path: ""            # 空=自动探测 PATH 与 ~/.grok/bin/gopeed.exe
gopeed_connections: 16
gopeed_min_bytes: 5242880
```

`/api/health` 中 `gopeed: true` 表示开关已开且找到了二进制。成功任务的 `warning` 字段为 `gopeed`。

### Jasna 去马赛克（可选）

视频入库时若客户端勾选 **「使用 jasna 去马赛克」**（管理库上传 / 浮动入库 / 录制 / 缓存捕捉；扩展选项里也有全局默认），服务端在入库成功后把任务加入 **串行 GPU 队列**，调用本机 [jasna](https://github.com/Kruk2/jasna) CLI：

```yaml
jasna_enabled: true
jasna_path: "D:/TMP/jasna-windows-nvidia-0.8.1/jasna.exe"
jasna_codec: "h264"   # 输出 mp4，成功后替换原文件
```

- 同一时刻只跑 **1** 个 jasna 进程；后续任务 `queued` 排队。
- **独立控制台**：`jasna.exe` 在**新开的黑窗口**里跑（默认**最小化**，任务栏可点开看 tqdm），与 LocalMediaWeb **无管道连接**，避免拖死媒体库 API。
- API 侧进度为粗略估计（输出文件体积）；失败保留原片。
- 健康检查：`/api/health` 的 `jasna: true` 表示 enabled 且找到了二进制。
- 手动：`POST /api/media/{id}/jasna`。

### 手机打不开、电脑要刷新两遍

**根因（已修）：**
1. 以前启动后**立刻开浏览器**，服务还没起来 → PC 第一次白屏/失败，刷新才正常。
2. 以前把 `HTTP_PROXY` 写进**整个服务进程**，可能干扰局域网访问；现已改为 **仅下载用代理**（`settings.yaml` → httpx），服务进程**清除**环境代理。

**手机访问步骤：**
1. `restart.bat` 后看窗口里的 `Phone / LAN: http://192.168.x.x:8790/`
2. 手机连**同一 Wi‑Fi**，打开该地址（不要用 `127.0.0.1`）
3. 管理员运行一次 `open-firewall.bat`
4. Wi‑Fi 设为**专用网络**；Clash **TUN** 勾选允许/绕过局域网
5. PC 浏览器先打开 `http://192.168.x.x:8790/api/health` 应返回 `"ok":true` 和 `lan_ips`；手机浏览器同样测这个 URL

### 手机 PWA（推荐：去掉 Safari 地址栏 / 页签）

普通 Safari 标签页里，网页**无法**强制隐藏系统地址栏和页签栏。自用可「添加到主屏幕」，用 **独立模式** 打开——仍是完整 LocalMediaWeb（Feed / 网格 / 搜索 / 管理），不是只能播视频。

**iPhone / iPad：**

1. Safari 打开 `http://<电脑局域网IP>:8790/`
2. 底部分享 → **添加到主屏幕** → 添加  
3. 以后从 **主屏幕图标** 进入（不要从 Safari 历史再开标签）

**Android Chrome：** 菜单 → **安装应用** / 添加到主屏幕（读 `/manifest.webmanifest`）。

说明：

- 未做 Service Worker（避免局域网媒体 Range/缓存踩坑）；不要求离线。
- 主屏幕 App 与 Safari 标签的 localStorage **可能隔离**，token/偏好要在图标里再设一次。
- 前端改版后若界面旧：划掉后台里的 LocalMedia 再从图标打开，或强刷一次。

## Feed 浏览（短视频式）

默认打开 **竖滑 Feed**（类似短视频）：一屏一条、snap 吸附、单击显示进度条、双击沉浸（隐藏顶栏/HUD）。另有 **网格缩略图**、**搜索**、**管理** 页。

| 操作 | 说明 |
|------|------|
| 上下滑 | 切下一条 / 上一条 |
| 单击画面 | 显示进度与暂停键 |
| 双击画面 | 隐藏/恢复界面 |
| 喇叭 | 静音 ↔ 有声（见下方「手机有声」） |
| ♥ | 喜欢 |
| 🗑 | 删除磁盘文件 + 索引 |

### 推荐模式（轻量）

个人局域网库，**不做**社交协同过滤 / 深度学习。形态对齐主流短视频「多通道 + 探索 + 疲劳 + 多样性」。

| mode | 含义 |
|------|------|
| `random` | **全库** `ORDER BY RANDOM()` 抽样 + 类型/标签防扎堆（前端常用默认） |
| `recommend` | 多通道：兴趣 / 新鲜 / 探索 / 回访；喜欢与停留↑、跳过与刚看过↓；标签亲和 + Gumbel + MMR 打散 + 周期探索位 |
| `recent` | 最新入库 |
| `liked` | 仅已喜欢 |
| `similar` | 按当前媒体或标签的相似推荐（`similar_to` / `tag`） |
| 搜索 | 搜索结果可点进同一套 Feed UI，尾部按页预取 |

可调：`config/settings.yaml` 中 `feed_*`（见 `settings.example.yaml`）。

- `POST /api/media/{id}/like` 切换喜欢  
- `POST /api/media/{id}/interact` `{event: view|dwell|skip, dwell_ms?}`  
- `DELETE /api/media/{id}` 删文件+索引  

### 手机 Feed：单例播放器与有声

浏览器**禁止**「每个新 `<video>` 自动有声播放」；解锁有声通常绑定在**收到过用户手势的那个元素**上。

因此 Feed 采用 **全页唯一 `#lmwFeedPlayer`**：

1. 用户点一次喇叭 **打开声音** → 在该元素上解锁有声（session 记住偏好）。
2. 上下滑切条时 **只改 `src`、把同一节点挪到当前页**，不再每条新建 `<video>`。
3. 切图时 park 播放器；切回视频再 mount。历史过长时 **外科式裁剪 DOM**（不整页 `innerHTML` 毁掉正在播的节点）。

**使用注意：**

- 首次进入仍可能静音起播（策略要求）；点一次喇叭后，后续切条应能保持有声。
- 若系统短暂拦截有声，画面可继续、界面仍显示「开声」；再点一次喇叭即可重新解锁。
- 改 `frontend/public/assets/*` 后手机请 **强刷**（静态资源约 `max-age=60`）。

### 手机黑屏 / 一直 loading（已针对性修过）

常见原因与现状：

| 现象 | 原因方向 | 现状 |
|------|----------|------|
| 仅手机黑屏，PC 正常 | 解码器槽位 / 多 `<video>` | 单例 + 非当前页卸流 |
| 滑几条后整段挂 | 裁历史时 `scrollTop` 触发假滚动、打断激活 | 程序化滚动护栏；加载中不裁剪 |
| 开声后隔几秒转圈重载 | unmute 短暂停住被当成卡死 → 硬重载 | 看门狗只软 `play()`；有缓冲不整段 `load()` |
| 开声后下一条没声音 | 每条新 video 丢失解锁 | 单例播放器 |

仍异常时：看服务端是否在拉 `/api/media/{id}/file`（Range）；强刷后再试。

## API 摘要

- `GET /api/health` — 健康检查（无需 Token）
- `POST /api/ingest` — 插件批量提交 URL（含 headers）
- `POST /api/upload` — 插件回退上传本地已下载文件
- `GET /api/feed?mode=recommend|recent|random|liked|similar&limit=&exclude_ids=&similar_to=&tag=`
- `GET /api/media`（含搜索 `q`）、`/api/jobs` …
- `GET /api/media/{id}/file` — 文件流（**支持 Range**，原生 `<video>` 用）
- 文档：服务启动后访问 `/docs`

鉴权：Header `X-LMW-Token`，或媒体 URL 查询参数 `?token=`（`<video>` / `<img>` 无法自定义 Header）。

## 与猫抓

扩展选项中配置 LocalMediaWeb 地址（默认 `http://127.0.0.1:8790`）。popup 底部：**媒体库** 打开浏览页；勾选嗅探资源后点 **入库** 直接提交（不必开库页）。缓存捕捉 / 视频录制 / 录屏 / WebRTC 停止后可 blob 上传入库。

## TR3000

见 [docs/deploy-tr3000.md](docs/deploy-tr3000.md)。默认建议服务跑在 PC；路由仅做局域网。

## 许可

与猫抓仓库一致时遵循仓库根目录 LICENSE；本子项目代码可同仓维护。
