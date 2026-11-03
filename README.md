# tutor-api

把编辑器暴露成 **agent 可调用的 API**。任何 agent(DSH、Codex、Claude Code、自己写的脚本)
都能接入 —— 这个项目本身**不认识任何 agent**。

```
agent 客户端 ──(JSONL over TCP)──▶ tutor-api ──▶ 编辑器
                      ▲                    │
                      └──── 推送(无 id)────┘
```

完整协议见 **[API.md](API.md)**。

## 安装

编辑器这一侧**只装你这个扩展就够了**,它不认识 DSH,也不认识任何 agent。

去 [Releases](https://github.com/Thomas-key/agent_code_tutor/releases) 下最新的
`agent-code-tutor-x.y.z.vsix`,然后:

```bash
code --install-extension agent-code-tutor-x.y.z.vsix
# code-server 用户用 code-server --install-extension ...
```

或者图形界面:扩展面板右上角 `···` → **从 VSIX 安装**。

> **扩展 ID 是 `illusion.agent-code-tutor`(带连字符)**。
> Archive 里如果同时看到 `agent_code_tutor`(下划线)那个,是旧版,卸载掉 ——
> 两个同时装会抢同一个端口,后装的那个静默失败。

装完**重启窗口**。之后默认监听 `127.0.0.1:41890`。

## 和 DSH 一起用

需要另外装客户端插件([dsh-agent-code-tutor](https://github.com/Thomas-key/dsh-agent-code-tutor)):

```bash
dsh plugin add https://github.com/Thomas-key/dsh-agent-code-tutor
```

`dsh plugin add` 底层是 pnpm —— 参数会原样转发,所以也能直接给 pnpm 认得的形式。

它通过 JSONL 连过来,把 `editor_*` 工具交给模型。**装完通常不用配置**:
插件启动时会扫 cwd 及其直接子目录的 `.vscode/settings.json`,自己找到这个工作区
的 token。找到多个不同的值就不猜,报错让你填。

**这个扩展不依赖它** —— 换成 Codex、Claude Code 或者你自己写的脚本,
读 [API.md](API.md) 一样能接。

## 它能做什么

| 类别 | op |
|---|---|
| 感知 | `ping` `scene` `read` |
| 执行 | `open` `insert` `replace` `save` |
| 展示 | `highlight` `annotate` `clear` |
| 交棒 | `wait` |

设计上的三条硬约束:

1. **写必须看得见** —— 目标文件不在前台就拒绝,让调用方先 `open`
2. **新文件要确认** —— 文件不存在时不创建,先把内容暂存并返回 token
3. **继续是人说了算** —— `wait` 只被「继续 / 暂停」唤醒,打字、切文件都不算

## 文件

| 文件 | 职责 |
|---|---|
| `extension.js` | VS Code 入口:只接线 |
| `src/ops.js` | **op 目录** —— 打开这一个文件就知道 agent 有哪些能力 |
| `src/bridge.js` | 传输层:TCP + 一行一个 JSON + 按 token 推送。不认识任何 op |
| `src/registry.js` | 注册表机制:名字 → op 定义 |
| `src/api.js` | 分发 + 响应装配(token 校验、找 op、按需附带场景) |
| `src/sense.js` | 感知:场景快照 + 读文件 + 事件流 + 订阅 |
| `src/document.js` | 路径换算 + 拿文档(只找 / 创建 分开) |
| `src/actions.js` | 执行:position/range 换算 + 写入 + 新文件确认 |
| `src/present.js` | 展示:高亮 / 注解 / 改动底色 + 撤回 |
| `src/handoff.js` | 交棒:等人 + 等待状态广播 |
| `src/statusbar.js` | 状态栏三个按钮 + 待发队列 |
| `examples/client.js` | 参考客户端:连接、token、请求配对、推送 |

约定:**`src/` 里只有可被 require 的模块**;入口和工具脚本不放进去。

## 数据流

```
请求  socket ─▶ bridge(切行) ─▶ api(校验 token + 找 op) ─▶ 实现
                                    │
回应                        scene 只在需要时附上,events 取走即清
                                    ▼
                                  socket

推送  状态栏按钮 ─▶ bridge.broadcastTo(token) ─▶ 同 token 的连接
```

## 跑

装成扩展即可。它会默认监听 `127.0.0.1:41890`。

```bash
# 不带 token 会被拒
printf '{"id":1,"op":"ping"}\n' | nc 127.0.0.1 41890

# 带上 token
printf '{"id":1,"token":"test","op":"ping"}\n' | nc 127.0.0.1 41890
```

token 在**工作区设置** `tutorApi.conversationToken` 里(首次激活自动生成)。

## 约定

- **零依赖、零构建**:CommonJS + Node 内置模块
- **协议是契约**:已经有客户端在用了,只做增量
- **错误分层**:`internal` = 我们自己的 bug;`op-failed` / `unknown-op` = 调用失败
- **1-based**:对外一切行列都从 1 开始,`+1` 只发生在 `sense.js` / `actions.js` 各一处
- **派生数据不存第二份**:`dirty`、`files[]`、`older{}` 都是算出来的
