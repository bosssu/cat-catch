# AppCatch

Windows 桌面通用媒体抓取器 → 入库 [LocalMediaWeb](../LocalMediaWeb)。

## 三步上手

1. 先启动 LocalMediaWeb（`LocalMediaWeb/start.bat`）。
2. 双击 **`start.bat`**（或 `uv run python -m app.main`）。
3. 鼠标移到任意窗口，在**窗口内侧右侧偏下**出现 **抓取/截取** 后点击（不挡关闭按钮；移出后短暂保留）。
   - **1 个候选**：直接入库  
   - **多个候选**：打开网格面板勾选 / 预览 / 批量入库  

## 抓取来源（自动合并 · **任意窗口通用**）

设计原则：**不按 App 白名单工作**。悬停哪个进程就以该进程为会话目标；下面每一层对所有应用生效。

| 源 | 说明 |
|----|------|
| 网络 inbox | 向 `data/network_inbox.jsonl` 追加 URL 行即可（扩展/脚本可喂，可带 pid/process_name） |
| 剪贴板 | **智能抓取时读取**（图片 / 媒体链接 / 文件）；会过滤明显属于**别的产品**的残留链接 |
| 缓存扫描 | 按进程名匹配 `%LOCALAPPDATA%\{App}` / `%APPDATA%\{App}` + 自动发现同名目录 + 共享 Temp（排除其它 App 的 profile 树） |
| 文件夹监视 | `watch_dirs` + 用户 Downloads |
| 链接下载 | 直链 httpx 或 **yt-dlp** 落到 `data/tmp/downloads` 再入库 |
| 截图兜底 | 无原片时窗口截图（**任何窗口都能用**） |
| 扩展 | 可选增强：`extensions/*/manifest.yaml`（L-A）+ `plugin.py`（L-B）。没有扩展也能抓 |

个别产品（Discord / Steam 等）的奇怪缓存路径只是**可选 hint**，不是准入条件。新 App 一般只需进程在 AppData 下有目录，或你复制链接 / 另存下载 / 截图。

### 候选分级（网格）

| 颜色 | 含义 |
|------|------|
| 绿 · 原片 | 本地已有文件，可直接预览/入库 |
| 蓝 · 链接 | 仅 URL；可「下载选中链接」或入库时自动下载 |
| 黄 · 截图 | 窗口截图兜底 |

### 快捷键（应用内）

- `Ctrl+Shift+G` 智能抓取鼠标下/当前目标窗口  
- `Ctrl+Shift+S` 截图入库  
- `Ctrl+Shift+E` 打开候选网格  

悬停按钮 **右键**（菜单应为浅灰底黑字，可点）：

- 智能抓取 / 截图入库 / 打开候选网格  
- **从剪贴板抓链接/文件**（Discord 视频推荐）  
- 对该窗口加强 30 秒  

### Discord 视频怎么抓

当前无系统级 HTTPS 解密时，**点播视频不会自动变成原片**，请任选：

1. 在 Discord **右键视频 → 复制链接** → **直接点抓取**（智能抓取会自动读剪贴板并下载/入库）  
2. **另存为**到「下载」文件夹 → 悬停 Discord 再点抓取（扩展会扫近 2 小时内的**完整**视频/大图）  
3. **不要**依赖 `Cache_Data/f_xxxxx`：那是浏览器截断缓存，只能播约 1 秒，已默认过滤  
4. 只能截图时：网格里可先入库截图；Toast 会提示上述步骤  

 

### 网络 inbox 示例

```json
{"url":"https://cdn.discordapp.com/attachments/1/2/a.png","pid":1234,"process_name":"Discord.exe"}
```

写入 `AppCatch/data/network_inbox.jsonl`（一行一条）。

## 扩展（补齐新 App）

1. 复制 `extensions/_template` → `extensions/myapp`
2. 编辑 `manifest.yaml`：进程名 + CDN URL 正则
3. 主面板 → 扩展 → **重新加载**

详见 `extensions/_template/README.md`。

## 配置

首次运行会从 `config.example.yaml` 复制为 `config.yaml`。  
媒体库地址默认 `http://127.0.0.1:8790`。

## 开发 / 测试

```bat
cd AppCatch
uv sync --group dev --python 3.12.13
uv run --python 3.12.13 python -m app.main
uv run --python 3.12.13 pytest tests -q
```

### PySide6 `DLL load failed ... QtCore`

原因：本机默认 `python` 常是 **Anaconda**，其 `Library\bin` 里的 Qt DLL 会劫持 PySide6。

处理：

1. 用项目自带的 **`start.bat`**（会走 `scripts/start.ps1`，清理 conda PATH + 固定 CPython 3.12.13）。
2. 或手动：

```bat
cd AppCatch
uv python pin 3.12.13
rmdir /s /q .venv
uv sync --python 3.12.13
uv run --python 3.12.13 python -m app.main
```

不要在已 `conda activate` 的终端里启动。
