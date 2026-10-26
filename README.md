# editor-api

把编辑器暴露成 **agent 可调用的 API**。任何 agent(DSH、Codex、Claude Code、自己写的脚本)都能接入,
这个项目本身**不认识任何 agent**。

```
agent 客户端 ──(JSONL over TCP)──▶ editor-api ──▶ 编辑器
```

## 现在到哪了

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 传输层 + 注册表 + 分发 + `ping` | ✅ 可跑 |
| 2 | `scene` / `read`(感知) | 未开始 |
| 3 | `open` / `insert` / `replace`(执行) | 未开始 |
| 4 | `save` / `clear` / `highlight` / `say` | 未开始 |
| 5 | `wait`(交棒) | 未开始 |
| 6 | 批注 | 未开始 |
| 7 | diff / 底色 | 未开始 |
| 8 | 按钮 / 推送唤醒 | 未开始 |
| 9 | `API.md` + 示例客户端 | 未开始 |
| 10 | VS Code 扩展入口 | 未开始 |

## 文件

| 文件 | 职责 |
|---|---|
| `src/bridge.js` | 传输层:TCP + 一行一个 JSON。不认识任何 op |
| `src/registry.js` | 注册表:模块自己把 op 登记进来 |
| `src/api.js` | 分发:请求 → 找到 op → 调它 → 回响应体 |
| `src/dev-server.js` | 临时入口:把三样接起来跑起来(第 10 步前用它) |

## 跑

```bash
npm run dev          # 监听 127.0.0.1:41889
```

```bash
printf '{"id":1,"op":"ping"}\n' | nc 127.0.0.1 41889
```

期望:

```json
{"id":1,"ok":true,"result":{"version":"1.0.0","port":41889,"ops":["ping"]}}
```

## 约定

- **零依赖、零构建**:CommonJS + Node 内置模块
- **协议是契约**:已经有客户端在用了,只做增量
- **错误分层**:`internal` = 我们自己的 bug;`op-failed` / `unknown-op` = 调用失败
