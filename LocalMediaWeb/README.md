# LocalMediaWeb

本地媒体聚合浏览服务：把网页上的图片 / 动图 / 视频 / m3u8 **下载到本机 `Medias/`**，局域网用手机或 PC 以 **短视频 Feed（默认）** 或 **网格缩略图** 浏览。

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

## Feed 推荐（轻量）

个人局域网库，**不做**社交协同过滤 / 深度学习。

| mode | 含义 |
|------|------|
| `recommend`（默认） | 喜欢↑、停留/浏览↑、跳过↓、新内容↑、分类偏好↑ + 少量随机 |
| `recent` | 最新入库 |
| `random` | 随机 |
| `liked` | 仅已喜欢 |

前端：Feed 右侧 **♥ / ⏭ / 🗑**；管理页可批量看列表并删除。

- `POST /api/media/{id}/like` 切换喜欢  
- `POST /api/media/{id}/interact` `{event: view|dwell|skip, dwell_ms?}`  
- `DELETE /api/media/{id}` 删文件+索引  

## API 摘要

- `GET /api/health` — 健康检查（无需 Token）
- `POST /api/ingest` — 插件批量提交 URL（含 headers）
- `POST /api/upload` — 插件回退上传本地已下载文件
- `GET /api/feed?mode=recommend|recent|random|liked`
- `GET /api/media`、`/api/jobs` …
- 文档：服务启动后访问 `/docs`

可选 Header：`X-LMW-Token`。

## 与猫抓

扩展选项中配置 LocalMediaWeb 地址（默认 `http://127.0.0.1:8790`），在 popup 打开「本地库」网格页，多选后选择分类入库。

## TR3000

见 [docs/deploy-tr3000.md](docs/deploy-tr3000.md)。默认建议服务跑在 PC；路由仅做局域网。

## 许可

与猫抓仓库一致时遵循仓库根目录 LICENSE；本子项目代码可同仓维护。
