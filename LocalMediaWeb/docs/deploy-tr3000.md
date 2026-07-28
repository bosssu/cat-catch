# 迁到 Cudy TR3000 / OpenWrt

## 结论

| 问题 | 答案 |
|------|------|
| ffmpeg 能否安装 | 可以（OpenWrt 包），**只做 remux copy / 抽帧**，不要转码 |
| 后台能否撑住 | **轻量可以**；多路 1080p m3u8 + 重编码不行 |
| 推荐 | **PC 跑 LocalMediaWeb**，手机连家里 Wi‑Fi 访问 |

## 路径 B（默认推荐）

- 服务继续在 PC / NAS
- `Medias` 放在大硬盘
- 路由只负责转发

## 路径 C（全栈上路由，实验性）

前提：USB 存储、足够 RAM（常见 512MB 档需克制）、能装 Python3 + ffmpeg。

1. `Medias` 与 `data` 全部放在 USB，例如 `/mnt/sda1/lmw/`
2. 配置 `profile: router`（限制并发）
3. 同时仅 1 个 m3u8 任务；`hls_concurrency` ≤ 3
4. **禁止**视频重编码
5. 入库尽量在 PC 完成再同步文件，或接受慢速

## 路径 A（拆分）

- 路由：只读浏览已落盘媒体
- PC：负责 ingest / m3u8 合并，结果拷到 USB

## 备份

备份 `Medias/` + `data/media.db`。

## 安全

不要把 8790 映射到公网；必要时用 Tailscale + `access_token`。
