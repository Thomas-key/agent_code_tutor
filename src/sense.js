const vscode = require('vscode');
const path = require('path');
const { workspaceRoot, relative, openDocument } = require('./document');

/**
 * 感知:把编辑器此刻的样子翻译成对方能读的数据。
 *
 * 三条铁律:
 *   ① 只读 —— 一次调用前后,世界应该完全一样
 *   ② 只给相对路径 —— 绝对路径换个机器就废,还会泄漏目录结构
 *   ③ 对外行号列号从 1 数 —— VS Code API 是 0-based,转换只放在这个文件里,
 *      免得每个客户端各自 +1、各自错
 */


/** 前台文件。只认真文件 —— OutputChannel、设置页不算,它们会冒充"当前文件"。 */
function activeFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return null;
  const doc = editor.document;
  const selection = editor.selection;
  return {
    path: relative(doc.uri.fsPath),
    dirty: doc.isDirty,
    version: doc.version,
    cursor: { line: selection.active.line + 1, character: selection.active.character + 1 },
    selection: selection.isEmpty
      ? null
      : {
          start: { line: selection.start.line + 1, character: selection.start.character + 1 },
          end: { line: selection.end.line + 1, character: selection.end.character + 1 },
          text: doc.getText(selection).slice(0, 400),
        },
  };
}

/** 所有打开的文件 —— 用来回答"哪些没落盘"。 */
function openedFiles() {
  const files = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== 'file') continue;
    files.push({
      path: relative(doc.uri.fsPath),
      dirty: doc.isDirty,
      version: doc.version,
      lines: doc.lineCount,
    });
  }
  return files;
}

/**
 * 一次场景快照。
 *
 * `dirty` 是**派生**的:直接从 files 过滤出来,不另存一份。
 */
function scene() {
  const files = openedFiles();
  const root = workspaceRoot();
  return {
    workspace: root ? path.basename(root) : null,
    active: activeFile(),
    files,
    dirty: files.filter((file) => file.dirty).map((file) => file.path),
  };
}

/** 默认每次读 200 行;要更多就显式传 from/to —— 大文件靠翻页,不靠一次全给。 */
const DEFAULT_READ_LINES = 200;

/**
 * 读文件内容。
 *
 * 约定:
 *   ① 读**内存 buffer**,不是磁盘 —— 磁盘上可能是旧版本
 *   ② **不创建**文件(创建要显式确认),不存在就报错
 *   ③ 默认只给前 200 行,但一定告诉你总行数和这次给的是哪几行 ——
 *      让你自己决定要不要翻页,而不是让你以为看到了全部
 *   ④ 行号 1-based,两端都含
 */
async function read(request) {
  const doc = await openDocument(request?.file);
  const totalLines = doc.lineCount;
  const from = Math.min(Math.max(1, Number(request?.from) || 1), totalLines);
  const requestedTo = Number(request?.to);
  const to = Math.min(
    totalLines,
    Number.isFinite(requestedTo) && requestedTo >= from ? Math.floor(requestedTo) : from + DEFAULT_READ_LINES - 1,
  );
  // 1-based → 0-based 只在这里转
  const start = new vscode.Position(from - 1, 0);
  const end = doc.lineAt(to - 1).range.end;
  return {
    path: relative(doc.uri.fsPath),
    from,
    to,
    totalLines,
    text: doc.getText(new vscode.Range(start, end)),
    dirty: doc.isDirty,
    version: doc.version,
  };
}

// ── 事件流(感知的另一半:人做了什么)────────────────────────

const MAX_EVENTS = 500;
let eventSeq = 0;
const events = [];
/** 谁在等同一条事件(交棒的 wait 靠它被唤醒)。 */
const eventListeners = new Set();

/** 自己造成动静的时间窗(见 markSelfAction)。 */
let selfActionUntil = 0;

/**
 * 标记"接下来这段时间的动静是我们自己造成的"。
 *
 * 由**写入方**调用(actions 里的 editor.edit 之前)—— 只有它知道这次改动是自己干的。
 * 别的扩展写文件挡不住:VS Code 不告诉我们是谁改的。
 */
function markSelfAction(ms = 200) {
  selfActionUntil = Date.now() + ms;
}

/**
 * 记一条"人干了什么"。
 *
 * 事件是**事实**,不是 diff:只记"哪个文件变了",不记"哪几行变了"。
 * 想知道细节的客户端自己 read —— 这样事件永远很小,不会把缓冲撑爆。
 */
function pushEvent(event) {
  // 自己造成的动静不算"人做了什么"(见 markSelfAction)
  if (Date.now() < selfActionUntil) return null;
  const record = { seq: ++eventSeq, at: Date.now(), ...event };
  events.push(record);
  // 叫醒正在等的人 —— 交棒的 wait 就是靠这个,而不是靠轮询
  for (const listener of eventListeners) {
    try {
      listener(record);
    } catch {}
  }
  // 上限:没人取走时也不能无限长,丢掉最老的。
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return record;
}

/** 交付时保留细节的"最近"条数,更早的只给计数。 */
const RECENT_EVENTS = 5;

/**
 * 取走全部待办事件并清空。
 *
 * 交付时压缩:
 *   ① 最后 5 条保持原样 —— 那是"刚刚发生的事",细节有用
 *   ② 更早的只给计数(按类型)—— 反复折腾时不会甩给对方一百条
 *
 * 返回 null 表示"什么都没有"。
 */
function drainEvents() {
  if (events.length === 0) return null;
  const raw = events.splice(0, events.length);
  // slice 的负下标是"从末尾数":少于 5 条时 raw.length - 5 会变负数,必须夹到 0
  const cut = Math.max(0, raw.length - RECENT_EVENTS);
  const older = {};
  for (const event of raw.slice(0, cut)) {
    older[event.t] = (older[event.t] ?? 0) + 1;
  }
  return { recent: raw.slice(cut), older };
}

/**
 * 订阅"人做了什么"。返回退订函数。
 *
 * 交棒的 wait 靠它被唤醒:不用轮询,也不占事件循环。
 */
function subscribe(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/**
 * 激活时挂监听 —— 返回一组 disposable,由入口塞进 context.subscriptions。
 *
 * 记的是"人做的事":改文档、存盘、开/关文件、切前台。
 * 光标移动**不记**:太频繁,会把事件流淹掉;要光标就读 scene(永远最新)。
 *
 * 注意:我们自己的写入也会触发 change —— 第 3 步在 actions 里加标记过滤。
 */
function startWatching() {
  const fileOf = (doc) => (doc.uri.scheme === 'file' ? relative(doc.uri.fsPath) : null);
  const record = (t, doc) => {
    const file = fileOf(doc);
    if (file) pushEvent({ t, file });
  };

  return [
    vscode.workspace.onDidChangeTextDocument((event) => record('change', event.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => record('save', doc)),
    vscode.workspace.onDidOpenTextDocument((doc) => record('open', doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => record('close', doc)),
    vscode.window.onDidChangeActiveTextEditor((editor) => editor && record('focus', editor.document)),
  ];
}

/**
 * 响应要不要附带场景。
 *
 * 只有两种时候带:有**待办事件**(人做了什么),或者出错(帮它自己纠错)。
 * 不再有"第一次必须带全量" —— 客户端启动时自己调一次 scene 拿初始世界。
 */
function viewFor({ force = false } = {}) {
  const pending = drainEvents();
  if (!force && !pending) return null;
  return { scene: scene(), events: pending ?? { recent: [], older: {} } };
}

module.exports = {
  workspaceRoot,
  relative,
  activeFile,
  openedFiles,
  scene,
  pushEvent,
  drainEvents,
  subscribe,
  markSelfAction,
  viewFor,
  startWatching,
  read,
};
