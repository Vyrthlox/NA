# Sidecar 生命周期管理（SidecarManager）

> 模块：Main `electron/main/sidecar/`（SidecarManager）、preload `window.api.sidecar.*`、Renderer 状态订阅。
> 本文档描述 AI sidecar（Python Flask）进程的启动、探测、看门狗与状态广播，以及进程生命周期相关的已知坑。
> 状态：✅ 已实现。

## 1. 职责与位置

SidecarManager 是 Main 进程里的单例，负责：

1. **启动**：缺失/未就绪时 spawn `python sidecar/app.py`（生产用打包内嵌 Python；开发用当前环境解释器）。
2. **发现**：轮询 `data/sidecar.status.json`（由 sidecar 启动时写入 `{host, port, token, pid}`），拿到 endpoint 与鉴权 token。
3. **看门狗**：定期 `GET /healthz`（免鉴权）探测存活；sidecar 异常退出时记录、必要时自动拉起，**防止孤儿进程**。
4. **状态广播**：把 `starting / ready / stopping / stopped / error` 等状态推给 renderer（`sidecar:status` 事件 + `sidecar:status-change`），聊天页据此禁用/启用发送。

## 2. 状态机

| 状态 | 含义 | 触发 |
|------|------|------|
| `starting` | 已 spawn，尚未从 status.json 读到就绪信息 | 应用启动 / 重启 sidecar |
| `ready` | `/healthz` 通过，endpoint+token 可用 | 首次健康探测成功 |
| `stopping` / `stopped` | 主动停止中 / 已停止 | 用户"停止 AI 服务" / 退出应用 |
| `error` | 崩溃或超时未就绪 | 看门狗多次失败 |

Renderer 侧：`sidecarStatus !== 'ready'` 时聊天发送、知识库操作被禁用，UI 顶部显示引擎状态条。

## 3. 进程生命周期

- **随应用退出**：主进程 `will-quit` 时向 sidecar 发 `POST /shutdown` 优雅停止；超时未退则强杀。
- **崩溃恢复**：看门狗探测连续失败 → 标记 error →（若配置了自动拉起）重新 spawn 一轮。
- **防孤儿**：sidecar 自己记录 pid；SidecarManager 每次启动前检查端口/pid 是否已被占用，避免重复拉起成孤儿。

## 4. 身份与鉴权

- sidecar 仅绑定 `127.0.0.1` 本地回环。
- 每次启动生成随机 `token`，写入 `sidecar.status.json`；SidecarManager 读回后用于后续所有请求的 `Authorization: Bearer <token>`。
- `/healthz` 免鉴权，仅用于存活轮询，不暴露业务数据。

## 5. 已知坑

**Flask 流式 generator 与请求上下文**（§8.4 核心坑，详见 [chat-pipeline.md](chat-pipeline.md) §4）：

- 视图返回的流式 generator 在**请求上下文弹出后才被消费**；generator 内访问 `current_app`（如 `except` 分支的 `logger.exception`）抛 `RuntimeError: Working outside of application context`，掩盖真异常并使连接中途断开。
- 修法：`Response(stream_with_context(generate()), mimetype="text/event-stream")`。
- **调试线索**：gateway 侧 undici 报 `terminated` 而非 HTTP 状态码，通常是 sidecar 视图抛了异常但被上下文错误掩盖。

## 6. IPC 通道

| 通道 | 方向 | 说明 |
|------|------|------|
| `sidecar:getStatus` | handle | 查询当前状态（返回 `{status, ...}`） |
| `sidecar:status` | main→renderer 事件 | 状态推送（`onStatusChange` 订阅） |
| `sidecar:restart` | handle | 重启 AI 服务 |

## 7. 关联文档

- 对话转发与 SSE：见 [chat-pipeline.md](chat-pipeline.md)。
- 上下文引擎：见 [context-engine.md](context-engine.md)。
