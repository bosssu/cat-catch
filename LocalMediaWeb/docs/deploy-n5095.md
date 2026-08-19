# 部署到 N5095（7×24 弱主机）

目标机：Intel N5095 + 128G SSD + 1T HDD。本机开发可先照常跑；迁机时**整包拷贝**，**保留 `media.db`**。

> 通用局域网迁机清单（拷什么、配置什么、检查表）：见 **[deploy-lan-migrate.md](./deploy-lan-migrate.md)**。本文侧重 N5095 磁盘分工与 QSV。

## 架构分工

| 组件 | 跑在哪 | 职责 |
|------|--------|------|
| LocalMediaWeb | N5095（或本机暂用） | 入库、Feed、m3u8 下载、**HW remux 转码** |
| JasnaBridge | **有 GPU 的本机** | jasna 去码队列 → 再上传 LMW |
| FFmpegBridge | 本机 | 剪辑；去码勾选 → JasnaBridge；否则直推 LMW |
| 浏览器插件 | 本机 | 抓流入库（可限制级）；**不走服务端 jasna** |

## 磁盘布局（推荐）

| 路径 | 介质 | 说明 |
|------|------|------|
| `data/`（`media.db`、thumbs、tmp、jobs） | **SSD** | 随机 IO |
| `Medias/` | **HDD** | 大文件 |

`settings.yaml` 示例：

```yaml
medias_dir: "E:/LMW/Medias"
data_dir: "C:/LMW/data"
jasna_enabled: false
ffmpeg_hw_encode: "auto"   # N5095 QSV
download_concurrency: 2
hls_concurrency: 3
direct_connections: 2
gopeed_connections: 8
profile: "n5095"
access_token: "your-token"
```

库内 `rel_path` / `thumb_rel` 为**相对路径**，改 `medias_dir`/`data_dir` 后旧数据仍可用。

## 从本机迁移（不丢库）

1. 本机 **停止** LocalMediaWeb（`stop.bat`），确认无写入。
2. 若有 `media.db-wal` / `media.db-shm`，停稳后再拷（或 `PRAGMA wal_checkpoint(FULL)`）。
3. 拷贝：
   - `Medias/` → 目标 HDD
   - `data/` 整目录（**含 `media.db`、`thumbs/`**）→ 目标 SSD
   - 项目代码 + `uv.lock`
4. 新机只改 `config/settings.yaml` 路径/代理/并发；**不要**新建空库覆盖 `media.db`。
5. `uv sync` → `start.bat` → 打开 Feed 抽查旧条目。
6. 本机插件 / FFmpegBridge / JasnaBridge 的 **LMW URL** 改为 N5095 地址；JasnaBridge 仍留本机。

## 验证 QSV

```bat
ffmpeg -hide_banner -encoders | findstr qsv
```

应看到 `h264_qsv`。`ffmpeg_hw_encode: auto` 会优先用它，失败回退 libx264。

## 安全

- 不要把 8790 裸暴露公网；可用 Tailscale + `access_token`。
- 防火墙仅局域网放行。

## 相关

- 本机中间件：`D:\PROGRAMER_HAPPY\C#ORIGIN_PROJECTS\JasnaBridge`
- 旧路由笔记：`deploy-tr3000.md`（思路类似，硬件不同）
