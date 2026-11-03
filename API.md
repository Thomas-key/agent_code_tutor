# API

编辑器能力的完整说明。**这里不认识任何 agent** —— 下面这些东西对 DSH、Codex、
Claude Code、或者你自己写的脚本一视同仁。

- 传输:`127.0.0.1:41890`,TCP,一行一个 JSON(JSONL)
- 编码:UTF-8
- 行号/列号:**从 1 开始**(不是 0)

---

## 1. 会话 token

每个工作区只有一个 token,存在**工作区设置**里:

```
tutorApi.conversationToken
```

第一次激活扩展时,如果它为空,扩展会生成一个 8 位十六进制值并写进
`.vscode/settings.json`。用户随时可以改 —— 改完客户端也要跟着改。

**每个请求都必须带上它**:

```json
{"id": 1, "token": "test", "op": "ping"}
```

不一致的请求会被直接拒绝,连 `scene` 都不会返回:

```json
{"id":1,"ok":false,"error":{"code":"op-failed","message":"token 不匹配 —— 这个工作区不属于你。要么把客户端的 token 改成工作区设置里的值,要么用匹配的会话"}}
```

> **为什么用 token 而不是端口**:多个编辑器窗口、多个 agent 可以同时存在。
> token 说明"这条连接属于哪次对话",推送才不会送错人。

---

## 2. 请求与响应

### 请求

```json
{"id": 7, "token": "test", "op": "read", "file": "src/ops.js", "from": 1}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 客户端自己编号,响应会原样带回 |
| `token` | 是 | 会话 token |
| `op` | 是 | 要调的能力 |
| 其余 | 看 op | 直接平铺在同一层,没有 `params` 嵌套 |

### 成功

```json
{"id": 7, "ok": true, "result": { ... }}
```

### 失败

```json
{"id": 7, "ok": false, "error": {"code": "op-failed", "message": "文件不存在:nope.js"}}
```

| `code` | 谁的问题 |
|---|---|
| `unknown-op` | 客户端写错了 op 名 |
| `op-failed` | 这次调用不行(文件不存在、token 不对……) |
| `internal` | **我们的 bug** |
| `bad-json` | 发来的不是合法 JSON |

### 响应里可能多出来的两个字段

```json
{"id":7,"ok":true,"result":{...},"scene":{...},"events":{...}}
```

- **`scene`** —— 只在"有未读事件"或 `ok:false` 时附带。平时不重复给你。
- **`events`** —— 只在真的有事件时出现:

```json
"events": {
  "recent": [ {"seq":3,"t":"change","file":"src/a.js","at":1793627326946} ],
  "older": {"change": 4, "save": 2}
}
```

`recent` 是最近 5 条原文,`older` 是更早的按类型计数。**事件被取走就没了** ——
下一次请求不会再给一遍。

---

## 3. 感知

### `ping`

连通性检查,顺带告诉你有哪些 op。

```json
→ {"id":1,"token":"test","op":"ping"}
← {"id":1,"ok":true,"result":{"version":"1.0.0","ops":["ping","scene","read",...]}}
```

### `scene`

当前场景:前台文件、光标、选区、未落盘的文件。

```json
← {
  "workspace": "/home/me/project",
  "active": {
    "path": "src/ops.js",
    "dirty": true,
    "version": 12,
    "cursor": {"line": 30, "character": 5},
    "selection": {"start": {"line":30,"character":0}, "end": {"line":34,"character":0}, "text": "…"}
  },
  "files": [{"path":"src/ops.js","dirty":true,"version":12,"lines":50}],
  "dirty": ["src/ops.js"]
}
```

### `read`

读文件内容。**读的是内存 buffer**,不是磁盘 —— 没保存的改动也看得到。

| 参数 | 默认 | 说明 |
|---|---|---|
| `file` | 必填 | 相对工作区根的路径;不允许 `..` 和绝对路径 |
| `from` | 1 | 起始行(含) |
| `to` | `from+199` | 结束行(含);越界自动夹到末行 |

```json
→ {"id":2,"token":"test","op":"read","file":"src/ops.js","from":1}
← {"id":2,"ok":true,"result":{
     "path":"src/ops.js","from":1,"to":50,"totalLines":50,
     "text":"…","dirty":false,"version":1}}
```

**永远返回 `totalLines`** —— 读到的不是全文时,你至少知道还有多少。

---

## 4. 执行(改代码)

### 规则:写必须看得见

写操作要求目标文件**正在前台**。否则:

```json
{"code":"op-failed","message":"文件不在前台:src/a.js —— 先调 open 打开并聚焦,再写(写必须看得见)"}
```

这不是限制,是承诺:**agent 不能在你看不见的地方改代码**。

### 规则:一次别写太多

教学场景里,一次超过 20 行会**照写,但返回里带提示**:

```json
{"warning":"这次写了 87 行,超过教学上限 20 行。教学场景是一行一行长出来的:下次请拆成几次写,别一次铺满,人跟不上。"}
```

不硬拦,是因为拦下来要重新生成一遍 —— 白烧 token。

### `open`

打开文件并聚焦。这是**唯一**会抢焦点的 op,写之前通常要先调它。

```json
→ {"id":4,"token":"test","op":"open","file":"src/a.js"}
← {"id":4,"ok":true,"result":{"path":"src/a.js","focused":true,"version":1,"dirty":false}}
```

### `insert`

| 参数 | 默认 | 说明 |
|---|---|---|
| `file` | 必填 | |
| `text` | 必填 | |
| `at` | `"end"` | `"end"` / `"cursor"` / `{"line":5,"character":3}` |

```json
← {"id":5,"ok":true,"result":{
     "path":"src/a.js","inserted":42,"lines":3,
     "at":{"line":5,"character":3},"version":8,"dirty":true}}
```

**新文件要确认。** 文件不存在时不会创建,而是把内容暂存起来:

```json
→ {"id":6,"token":"test","op":"insert","file":"new.js","text":"…"}
← {"id":6,"ok":true,"result":{
     "path":"new.js","created":false,
     "needConfirm":{"token":"pcmswi","file":"new.js","chars":12,"expiresIn":60,
                    "hint":"文件不存在。确认新建就带 confirm 重发一次(不用再传 text,内容已暂存)"}}}

→ {"id":7,"token":"test","op":"insert","file":"new.js","confirm":"pcmswi"}
← {"id":7,"ok":true,"result":{"path":"new.js","created":true,...}}
```

token 一次性、60 秒过期、路径必须一致。**内容不用重发** —— 暂存着呢。

### `replace`

| 参数 | 默认 | 说明 |
|---|---|---|
| `file` | 必填 | |
| `text` | 必填 | |
| `range` | 整份 | `{"from":{"line":1,"character":1},"to":{"line":3,"character":1}}` |

```json
← {"id":8,"ok":true,"result":{
     "path":"src/a.js","lines":3,"replacedLines":1,
     "from":{"line":5,"character":1},"to":{"line":5,"character":20},
     "version":9,"dirty":true}}
```

`replacedLines` 是**被替换掉的行数** —— 零长度范围(纯插入)时是 `0`。

### `save`

```json
← {"id":9,"ok":true,"result":{"path":"src/a.js","saved":true,"wasDirty":true}}
```

文件不脏时是空操作(`wasDirty:false`),不是错误。

---

## 5. 展示(指给人看)

这三个 op **不改文档、不进事件流**。它们只要求文件**可见**(有打开的编辑器就行,
不要求在前台)。

### `highlight`

高亮若干整行。**累加** —— 多次调用会越加越多,清的时机归 `clear`。

```json
→ {"id":10,"token":"test","op":"highlight","file":"src/a.js",
   "ranges":[{"fromLine":1,"toLine":3},{"fromLine":20,"toLine":22}]}
← {"id":10,"ok":true,"result":{"path":"src/a.js","ranges":2}}
```

可以用 `{fromLine, toLine}`,也可以用 `{from, to}`。

### `annotate`

在某一行挂一句话:行尾灰字 + hover 提示。

```json
→ {"id":11,"token":"test","op":"annotate","file":"src/a.js","line":5,"text":"这里为什么用 Map?"}
← {"id":11,"ok":true,"result":{"path":"src/a.js","line":5,"notes":1}}
```

### `clear`

清掉 agent 留下的一切:**高亮、注解、以及"待新建"的暂存**。

```json
← {"id":12,"ok":true,"result":{"highlights":2,"notes":1,"stagedCreates":0}}
```

**不动文档内容。** `clear` 是擦痕迹,不是撤销 —— 撤销代码请自己 `replace`。

---

## 6. 交棒

### `wait`

等人明确说"继续"。这是唯一一个会**挂很久**的 op。

| 参数 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | 0 | `0` = 一直等 |

```json
→ {"id":13,"token":"test","op":"wait","timeoutMs":0}
   （可能等几分钟 —— 这期间同一连接上还能发别的请求）
← {"id":13,"ok":true,"result":{
     "ended":"confirm",
     "event":{"seq":11,"t":"confirm","at":1793630844273},
     "events":{"recent":[…],"older":{…}}}}
```

`ended` 的取值:

| 值 | 含义 |
|---|---|
| `confirm` | 人点了「继续」 |
| `abort` | 人点了「暂停」—— **这一拍的写入已经被撤回** |
| `timeout` | 等超时了 |

**只被这两个信号唤醒。** 打字、切文件、保存都不算 —— 那些是噪声,不是"我看完了"。

---

## 7. 推送(服务端 → 客户端)

**没有 `id` 的消息就是推送。** 它不等回复,随时可能来:

```json
{"event":"ask","token":"e0d75dee","file":"src/a.js","text":"这个文件是做什么的"}
{"event":"ask","token":"e0d75dee","file":"src/a.js","line":5,"quote":"const a = 1;","text":"为什么这里要 import"}
{"event":"confirm","token":"e0d75dee"}
```

**每条推送都带 `token`** —— 它说明这条问话来自**哪一块编辑器工作区**。一个客户端可能同时
管着多个工作区,没有这个字段就无法把问话送回对应的会话。

| `event` | 含义 |
|---|---|
| `ask` | 有人问了一句话。带 `file`;`line`/`quote` 表示问的是某一行 |
| `confirm` | 人点了「唤醒」—— agent 当时没在等,所以用推送告诉它 |

**只发给"最后一次请求用了同一个 token"的连接。** 多开时不会串台。

---

## 8. 状态栏(给人用的)

窗口底部中间有三个按钮,行为随状态变化:

| 按钮 | agent 在等(`wait`) | agent 空闲 |
|---|---|---|
| 💬 询问 agent | 弹框问一句 → 排队 | 同左 |
| ▶ 继续 / 🔔 唤醒 | 发排队 + 叫醒 | 发排队(可以没有)+ 推送 `confirm` |
| ⏸ 暂停 / 🚫 取消 | **撤回这一拍** + 擦痕迹 + `abort` | 清空队列;没东西可清时不可按 |

**问话都是先排队,不会立刻发。** 人可以在 agent 干活的时候慢慢写,等它停下来再一次性发出去。

排队的项长这样(同一个队列,跨文件):

```json
[{"file":"test.py","text":"这个文件是做什么的"},
 {"file":"test1.py","line":1,"quote":"import test","text":"为什么这里要 import"}]
```

### 键位(可在「键盘快捷方式」里改)

| 键 | 作用 |
|---|---|
| `Ctrl+Alt+Enter` | 继续 |
| `Ctrl+Alt+Backspace` | 暂停(撤回) |
| `Ctrl+Alt+Q` | 问这一行(也在右键菜单里) |

### 颜色

按钮底色用主题色 `statusBarItem.prominentBackground`,想换的话改
`src/statusbar.js` 里的 `BACKGROUND` 一行即可(只能用 `statusBarItem.*` 系列)。

---

## 9. 客户端怎么写

一份最小但正确的客户端,见 [`examples/client.js`](examples/client.js)。要点:

1. **一条 TCP 连接**,自己维护 `id` 计数
2. **每个请求都带 `token`** —— 忘了就会被拒
3. **没有 `id` 的消息当推送处理**,不要扔进请求配对表
4. `wait` 可能挂很久,期间同一连接上还能发别的请求 —— **别串行阻塞**
5. 收到 `op-failed` 时读 `message`,那是给人看的、具体的说明

```js
const TOKEN = process.env.TUTOR_API_TOKEN ?? 'test';
const socket = net.connect(41890, '127.0.0.1');
socket.write(JSON.stringify({ id: 1, token: TOKEN, op: 'ping' }) + '\n');
```
