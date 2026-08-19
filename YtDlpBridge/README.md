# YtDlpBridge

本机常驻 HTTP 桥：猫抓「更多功能」把**当前页 URL** 交给本机 `yt-dlp` + `ffmpeg`，优先选出 iOS Safari 能播的 H.264+AAC mp4（能 copy 就不转码），完成后上传 LocalMediaWeb。

- 只绑 `127.0.0.1:8792`，不进 N5095。
- 队列并发 1。
- 本机做好 iOS 格式 + faststart；上传 LMW 默认 **不** 再让服务端 remux。
- 入库失败会重试瞬时错误（超时 / 断连 / 502–504 等），默认 3 次。
- 需要本机已装 **ffmpeg**、**deno**（YouTube 解签名）。默认从本机 **Edge** 读已登录 cookies（`cookies_from_browser: edge`）。Edge 正开着有时读库失败，可先完全退出再下，或改 `chrome` / 手写 `cookies_file`。
- yt-dlp 走 `proxy`（默认 Clash `http://127.0.0.1:7890`）。Windows 系统代理不会自动带上。入库上传不走这个代理。

## 启动

日常不要盯着黑框：

- 双击 `start.bat`：闪一下就关，进程在后台（无黑框）。
- 双击 `start-hidden.vbs`：连闪都没有。
- 要看日志时用 `start-console.bat`。
- 或：`Start-ScheduledTask -TaskName YtDlpBridge`（已装开机任务时）。

日志：`data/logs/startup.log`。首次会从 `config.example.yaml` 复制 `config.yaml`。需 [uv](https://docs.astral.sh/uv/)。

## 开机启动

双击 `install-autostart.bat`（任务计划程序，登录后隐藏启动）。

卸载：`uninstall-autostart.bat`。停止当前进程：`stop.bat`。

## API

- `GET /api/health`
- `POST /api/jobs`  body: `{"url":"https://...","title":"","referer":""}`
- `GET /api/jobs`
- `GET /api/jobs/{id}`
- `DELETE /api/jobs/{id}` 取消排队或杀掉正在跑的 yt-dlp

进度字段：`status`（queued / running / uploading / done / error / cancelled）、`percent`、`message`、`lmw_id`。
yt-dlp 自己报错会立刻失败并处理下一条；无输出超过 `stall_timeout`（默认 180s）或总时长超过 `download_timeout` 会杀进程，不占死队列。
