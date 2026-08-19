# LocalMediaWeb 局域网迁机部署说明

把 **LocalMediaWeb 服务端** 从当前开发机迁到局域网另一台 Windows 主机（NAS / N5095 / 闲置 PC 等）。目标：库不丢、手机与插件改 URL 即可用。

相关旧笔记：`deploy-n5095.md`（弱主机并发与 QSV）、`deploy-tr3000.md`（路由不推荐全栈）。

---

## 1. 架构：迁什么、不迁什么

| 组件 | 是否上新主机 | 说明 |
|------|--------------|------|
| **LocalMediaWeb**（本目录） | **是** | 入库、Feed、下载、remux/转码、静态前端 |
| `Medias/` + `data/media.db` + `data/thumbs/` | **是（必拷）** | 媒体本体 + 索引 + 封面 |
| 浏览器扩展 **猫抓** | 否（仍在使用机） | 只改扩展里的 LMW 地址 |
| **JasnaBridge** / jasna | **否（默认）** | 去码留在有 GPU 的本机；`jasna_enabled: false` |
| **FFmpegBridge** | 否 | 改推库目标 URL 为新主机 |

弱主机上 **不要** 在服务端开 jasna；开发机跑 JasnaBridge → 成品再 `POST /api/upload` 到新主机。

---

## 2. 需要拷哪些文件

### 2.1 必须拷贝（业务数据 + 可运行包）

在**旧机停服之后**再拷（见 §3）。

| 路径（相对 `LocalMediaWeb/`） | 内容 | 建议落盘 |
|------------------------------|------|----------|
| **`Medias/`** | 全部媒体文件 | 大容量盘（HDD/大 SSD） |
| **`data/media.db`** | SQLite 主库 | 快盘（SSD） |
| **`data/media.db-wal` / `media.db-shm`**（若存在） | WAL 未合并数据 | 与 `media.db` **同目录一起拷** |
| **`data/thumbs/`** | 缩略图 | 与 `data` 同盘即可 |
| **`config/settings.yaml`** | 本机配置（勿只拷 example） | 代码旁；到新机再改路径 |
| **代码与启动脚本** | 见下方清单 | 任意固定目录 |

**代码与运行所需（建议整目录同步，排除大体积临时文件）：**

```
LocalMediaWeb/
  backend/                 # Python 应用
  frontend/public/         # 静态页
  config/
    settings.yaml          # 真实配置
    settings.example.yaml
  scripts/                 # start/stop/防火墙/自启
  start.bat / stop.bat / restart.bat
  open-firewall.bat
  install-autostart.bat / uninstall-autostart.bat
  pyproject.toml
  uv.lock                  # 锁定依赖，新机 uv sync 用
  README.md
  docs/                    # 可选
```

### 2.2 建议不要拷 / 可清空

| 路径 | 原因 |
|------|------|
| `data/tmp/`（jobs、reencode、jasna 日志等） | 下载/转码临时目录，体积大、无必要保留 |
| `data/logs/` | 旧日志；可空目录重建 |
| `backend/**/__pycache__/`、`.venv/` | 新机用 `uv sync` 重建 |
| `_dbg_*.py`、`_mk_*.py` | 本地调试脚本 |

`data/tmp` 若不拷，新机首次启动会按配置自动创建。

### 2.3 最小数据备份（灾备）

日常只备份两样也能重建索引侧业务（缺 thumbs 可重生成，但旧封面会丢）：

1. 整个 **`Medias/`**
2. **`data/media.db`**（停服后最好无 wal/shm，或三者一起备）

---

## 3. 旧机：安全停服与拷贝步骤

1. 旧机双击 **`stop.bat`**，确认 8790 已不在监听：
   ```powershell
   Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue
   ```
2. （推荐）合并 WAL，避免只拷到半截库：
   ```powershell
   # 需本机有 sqlite3 或 python
   uv run python -c "import sqlite3; c=sqlite3.connect(r'data/media.db'); c.execute('PRAGMA wal_checkpoint(FULL)'); c.close(); print('ok')"
   ```
   若仍有 `media.db-wal` / `media.db-shm`，**与 media.db 一并拷走**。
3. 用网线/SMB/robocopy 等拷贝到新机。大数据量示例（PowerShell，按实际路径改）：
   ```powershell
   # 示例：拷到新机共享 \\NEWHOST\LMW\
   robocopy "D:\GIT\fur\cat-catch\LocalMediaWeb\Medias" "\\NEWHOST\LMW\Medias" /E /J /MT:8 /R:2 /W:5
   robocopy "D:\GIT\fur\cat-catch\LocalMediaWeb\data" "\\NEWHOST\LMW\data" /E /XD tmp logs /R:2 /W:5
   robocopy "D:\GIT\fur\cat-catch\LocalMediaWeb" "\\NEWHOST\LMW\app" /E /XD Medias data .venv __pycache__ /R:2 /W:5
   ```
   也可把整个 `LocalMediaWeb` 放在同一盘（路径简单），SSD 紧张时再把 `Medias` 拆到 HDD。

4. 拷完后旧机可**先不要删**，新机验证 Feed 旧条目正常后再下线旧服务。

---

## 4. 新机：系统依赖

| 依赖 | 用途 | 安装 |
|------|------|------|
| **Windows 10/11 x64**（本文默认） | 启动脚本为 bat/ps1 | — |
| **[uv](https://github.com/astral-sh/uv)** | Python 环境与依赖 | 安装后 `uv` 在 PATH |
| **ffmpeg** | m3u8 合并、封面、remux/转码 | 加入 PATH；`ffmpeg -version` 可用 |
| **Gopeed CLI**（可选） | 大文件直链多连接 | PATH 或 `gopeed_path` |
| **代理**（可选） | 外站 m3u8/CDN | 新机本机 Clash 等，或写死 `http_proxy` |

不要拷开发机的 `.venv`；在项目根执行：

```bat
cd /d X:\path\to\LocalMediaWeb
uv sync
```

### 4.1 硬件相关（可选）

- **Intel 核显 QSV**（如 N5095）：`ffmpeg -hide_banner -encoders | findstr qsv` 应见 `h264_qsv`；配置 `ffmpeg_hw_encode: "auto"`。
- **无核显弱机**：`ffmpeg_hw_encode: "none"`，避免无效探测；并降低并发（见 §5）。

---

## 5. 新机：配置 `config/settings.yaml`

以已拷过来的 `settings.yaml` 为底，**重点改路径与并发**；**不要**删掉库后让程序“空库重来”覆盖旧 `media.db`。

库内路径是 **相对 `medias_dir` / `data_dir` 的 rel_path**，只要目录内容完整，改绝对路径后旧条目仍能播。

### 5.1 同盘整包部署（最简单）

项目根例如 `C:\LMW\LocalMediaWeb`，`Medias` 与 `data` 仍在根下：

```yaml
host: "0.0.0.0"          # 必须 0.0.0.0，手机才能访问
port: 8790
access_token: "换成你的口令"   # 局域网建议设；空=不鉴权

open_browser: false
hide_console: true
autostart: true

medias_dir: "Medias"     # 相对项目根
data_dir: "data"

# 新机若跑代理：写本机地址；无代理则清空并关探测
http_proxy: "http://127.0.0.1:7897"   # 无代理改为 ""
http_proxy_auto_probe: true
http_trust_env: true

jasna_enabled: false     # 弱主机务必 false
ffmpeg_hw_encode: "auto" # 无 QSV 可改 none

profile: "n5095"         # 或 pc / router
download_concurrency: 2
hls_concurrency: 3
direct_connections: 2
gopeed_connections: 8
```

### 5.2 分盘（SSD 放库，HDD 放媒体）

```yaml
medias_dir: "E:/LMW/Medias"
data_dir: "C:/LMW/data"
```

注意：

- 正斜杠/反斜杠均可；路径存在且进程有读写权限。
- 若 `data_dir` 不在项目根下，请**整份**把旧 `data`（含 `media.db`、`thumbs`）放到该路径，而不是留空目录。
- `Medias` 同理：目录结构须与旧库 `rel_path` 一致（通常为 `Medias/{分类}/...`）。

### 5.3 并发与 profile 建议

| 主机类型 | profile | download_concurrency | hls_concurrency | 备注 |
|----------|---------|----------------------|-----------------|------|
| 日常 PC | `pc` | 4 | 8 | 可开 Gopeed 更高连接 |
| N5095 / 7×24 弱 U | `n5095` | 2 | 3 | QSV remux |
| 极弱 / 路由实验 | `router` | 1 | ≤3 | 禁止重编码 |

### 5.4 环境变量（可选）

前缀 `LMW_`，可覆盖 yaml，例如 `LMW_PORT=8790`、`LMW_ACCESS_TOKEN=...`。一般迁机只改 yaml 即可。

---

## 6. 新机：启动、防火墙、自启

1. **依赖**：`uv sync` 已成功。
2. **防火墙**（管理员，只需一次）：右键 **`open-firewall.bat`** → 以管理员运行，放行 TCP **8790**。
3. **启动**：双击 **`start.bat`**（或 `restart.bat`）。  
   - 日志：`data/logs/startup.log`（`hide_console: true` 时看这个）。  
   - 应监听 `0.0.0.0:8790`。
4. **本机自检**：
   ```text
   http://127.0.0.1:8790/api/health
   ```
   期望 `"ok": true`，并带 `lan_ips`。
5. **局域网自检**：手机/另一台电脑打开  
   `http://<新主机局域网IP>:8790/api/health`  
   与 Feed 页抽查若干**旧**条目（封面 + 播放）。
6. **开机自启（可选）**：双击 **`install-autostart.bat`** 一次。卸载：`uninstall-autostart.bat`。

### 6.1 手机仍打不开时

1. `Get-NetTCPConnection -LocalPort 8790 -State Listen` → `LocalAddress` 必须是 `0.0.0.0` 或 `::`，不能是 `127.0.0.1`。
2. 新主机 Wi‑Fi/网线配置为 **专用网络（Private）**。
3. 代理 TUN 模式允许/绕过局域网（否则可能劫持局域网回环）。
4. 确认 `access_token`：前端/插件需带同一 Token。

---

## 7. 客户端与周边改址

新主机 IP 示例：`192.168.1.50`，端口 `8790`。

| 端 | 改哪里 |
|----|--------|
| 手机浏览器 / PWA | 打开 `http://192.168.1.50:8790/`；PWA 需重新「添加到主屏幕」 |
| 猫抓扩展 | 选项里 LocalMediaWeb 地址改为新 URL；Token 与 `access_token` 一致 |
| FFmpegBridge | 推库 LMW 基址改为新 URL |
| JasnaBridge | 上传目标 LMW URL 改为新主机；**服务仍跑在 GPU 本机** |
| 旧机上的 LMW | 验证通过后 `stop.bat`，避免双实例写同一共享盘（若仍挂载同一数据） |

鉴权 Header：`X-LMW-Token` 或 `Authorization: Bearer ...`；`<video>`/`<img>` 用查询参数 `?token=`。

---

## 8. 迁移检查清单

- [ ] 旧机已 `stop.bat`，WAL 已 checkpoint 或 wal/shm 已一并拷贝  
- [ ] `Medias/` 体量与旧机大致一致；抽查几个文件能打开  
- [ ] `data/media.db` 在新机 `data_dir` 下，**不是**空库  
- [ ] `data/thumbs/` 已拷（否则封面需重生成/空白）  
- [ ] `config/settings.yaml`：`host=0.0.0.0`、路径、代理、并发、`jasna_enabled=false`  
- [ ] `uv sync` 成功；`ffmpeg` 在 PATH  
- [ ] `open-firewall.bat` 已管理员执行  
- [ ] `/api/health` 本机 + 手机均 OK  
- [ ] Feed 旧条目可播；新入库一条成功  
- [ ] 插件 / Bridge URL 已改；旧机服务已关  

---

## 9. 回滚

1. 新机 `stop.bat`。  
2. 旧机恢复原 `settings.yaml` 路径（若数据曾只读拷走，旧机数据仍在则可直接 `start.bat`）。  
3. 若迁移后仅在新机写入过新数据，回滚前先把新机 `Medias` + `media.db` 再拷回旧机，避免丢增量。

---

## 10. 安全注意

- **不要**把 8790 端口映射到公网。  
- 仅局域网访问；远程建议 **Tailscale / 其它 VPN** + 非空 `access_token`。  
- `settings.yaml` 含 Token/代理时勿提交到公开仓库。

---

## 11. 目录与职责速查

| 路径 | 职责 |
|------|------|
| `Medias/` | 媒体本体（可单独备份、可挂 HDD） |
| `data/media.db` | 索引、任务、点赞与交互等 |
| `data/thumbs/` | 缩略图缓存 |
| `data/tmp/` | 任务临时文件（可不迁移） |
| `config/settings.yaml` | 监听、路径、代理、并发、鉴权 |
| `frontend/public/` | 浏览端静态资源 |
| `start.bat` / `stop.bat` | 启停 |
| `open-firewall.bat` | 放行 8790 |
| `install-autostart.bat` | 登录自启 |

---

## 12. 一页纸命令摘要（新机）

```bat
:: 1) 已拷贝项目 + Medias + data（含 media.db）
cd /d C:\LMW\LocalMediaWeb

:: 2) 依赖
uv sync

:: 3) 编辑 config\settings.yaml（路径 / 0.0.0.0 / token / 并发 / 代理）

:: 4) 管理员：open-firewall.bat

:: 5) 启动
start.bat

:: 6) 浏览器
:: http://127.0.0.1:8790/api/health
:: http://<局域网IP>:8790/
```

完成以上后，本仓库服务端即在新主机提供局域网 Feed / 入库；开发与去码中间件可继续留在原 PC。
