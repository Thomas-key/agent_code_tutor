const vscode = require('vscode');
const { openDocument, ensureDocument, tryOpenDocument, uriOf, relative } = require('./document');
const { markSelfAction, expectSelfChange } = require('./sense');
const { markChanged } = require('./present');

/**
 * 执行:改编辑器里的内容。
 *
 * 三条铁律:
 *   ① 只走 Tutor API(WorkspaceEdit),绝不 fs.writeFile ——
 *      否则不进 undo 栈、文档版本号不涨、dirty 也不亮
 *   ② 每次写之前 markSelfAction() —— 我们自己的动静不能被记成"人干的"
 *   ③ 不抢焦点:写不等于"让人看",要看请显式调 open
 */

/**
 * 把"1-based 的行列"换成 VS Code 的 Position。
 *
 * @param {import('vscode').TextDocument} doc
 * @param {'end'|'cursor'|{line:number, character:number}} at
 */
function positionOf(doc, at) {
  if (at == null || at === 'end') {
    return doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;
  }

  if (at === 'cursor') {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.toString() === doc.uri.toString()) {
      return editor.selection.active;
    }
    // 光标不在这个文档里 —— 退到末尾,不去猜别处的光标
    return doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;
  }

  const line = Math.max(1, Number(at?.line) || 1);
  const character = Math.max(1, Number(at?.character) || 1);
  const zeroLine = Math.min(line - 1, doc.lineCount - 1);
  const maxChar = doc.lineAt(zeroLine).text.length;
  return new vscode.Position(zeroLine, Math.min(character - 1, maxChar));
}

/**
 * 取"正在被看着的那个编辑器"。
 *
 * 写操作必须在**前台**:后台静默改文件,等于让人看不见发生了什么。
 * 教学场景不能有这种事,所以宁可报错,让调用方先 open。
 */
function frontEditorOf(doc) {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === doc.uri.toString()) return editor;
  throw new Error(
    `文件不在前台:${relative(doc.uri.fsPath)} —— 先调 open 打开并聚焦,再写(写必须看得见)`,
  );
}

// ── 新文件:两段式确认 ────────────────────────────────────────

/** 暂存的"待新建"写入保留多久。 */
const CREATE_TTL_MS = 60000;

/** token → { op, request, expiresAt }。一次性,确认后就删。 */
const pendingCreates = new Map();

/**
 * 暂存一次"要新建文件"的写入,返回待确认信息。
 *
 * 为什么暂存而不是让调用方重发:内容是最贵的部分,重发就是白烧 token。
 */
function stageCreate(op, request) {
  // 顺手清掉过期的,别让 Map 一直涨
  const now = Date.now();
  for (const [key, entry] of pendingCreates) {
    if (entry.expiresAt < now) pendingCreates.delete(key);
  }

  const token = Math.random().toString(36).slice(2, 8);
  pendingCreates.set(token, { op, request, expiresAt: Date.now() + CREATE_TTL_MS });
  return {
    path: String(request.file),
    created: false,
    needConfirm: {
      token,
      file: request.file,
      chars: String(request.text ?? '').length,
      expiresIn: Math.round(CREATE_TTL_MS / 1000),
      hint: '文件不存在。确认新建就带 confirm 重发一次(不用再传 text,内容已暂存)',
    },
  };
}

/** 清掉所有"待新建"的暂存;返回清掉几个。clear 会调它。 */
function clearStaged() {
  const count = pendingCreates.size;
  pendingCreates.clear();
  return count;
}

/** 取出并作废 token;不存在、用过、过期都报错。 */
function takeCreate(token) {
  const entry = pendingCreates.get(token);
  pendingCreates.delete(token);
  if (!entry) throw new Error('确认无效或已用过 —— 请重新发起写入');
  if (entry.expiresAt < Date.now()) throw new Error('确认已过期(60 秒)—— 请重新发起写入');
  return entry;
}

/**
 * 拿到要写的文档。文件不存在时**先暂存并要确认**,绝不擅自创建。
 *
 * @returns {{ doc: object, source: object } | { needConfirm: object }}
 */
async function documentForWrite(op, request) {
  const confirm = request?.confirm;
  const source = confirm ? takeCreate(confirm).request : request;
  const file = source?.file;
  if (!file) throw new Error('缺少 file');

  let doc = await tryOpenDocument(file);
  if (doc) return { doc, source, created: false };
  if (!confirm) return { needConfirm: stageCreate(op, source) };

  // 确认了才创建;建完必须打开 —— 写要求前台,而新文件必然不在前台
  // 登记要在**创建之前** —— ensureDocument 一建文件就会触发 change 事件
  markSelfAction();
  expectSelfChange(uriOf(file).toString());
  doc = await ensureDocument(file);
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
  return { doc, source, created: true };
}

/**
 * 教学模式:一次写太多,人看不过来。超了**不拦**,只在返回里提示。
 *
 * 为什么不拦:拦下来意味着内容要重新生成一遍,而内容是模型输出里最贵的部分。
 * 写完 + 提示,模型下一拍自己收敛,零浪费。
 */
const MAX_LINES_PER_WRITE = 20;

/** 行数:末尾那个换行不算新的一行,否则每段都会多算一行。 */
function lineCountOf(text) {
  const s = String(text ?? '').replace(/\n$/, '');
  return s === '' ? 0 : s.split('\n').length;
}

/**
 * 超过教学上限就返回一句提示,否则 null。
 *
 * 不拦:拦下来要重新生成,白烧 token。写完 + 提示,模型下一拍自己收敛。
 */
function lineWarning(lines) {
  if (lines <= MAX_LINES_PER_WRITE) return null;
  return `这次写了 ${lines} 行,超过教学上限 ${MAX_LINES_PER_WRITE} 行。教学场景是一行一行长出来的:下次请拆成几次写,别一次铺满,人跟不上。`;
}

/**
 * 在文件里插入文本。
 *
 * 目标和前台编辑器必须是同一个 —— 否则报错,让调用方先 open。
 * 写必须看得见:后台静默改文件,人就不知道自己被改了什么。
 */
async function insert(request) {
  const prepared = await documentForWrite('insert', request);
  if (prepared.needConfirm) return prepared.needConfirm;

  const { doc, source, created } = prepared;
  const text = String(source?.text ?? '');
  if (!text) throw new Error('缺少 text');
  const editor = frontEditorOf(doc); // 必须在前台,否则不写
  const position = positionOf(doc, source?.at);

  const before = doc.getText();
  markSelfAction();
  expectSelfChange(doc.uri.toString()); // 记一次账:马上会有一次 change 是我们干的
  const applied = await editor.edit((builder) => builder.insert(position, text));
  if (!applied) throw new Error('编辑器拒绝了这次修改(可能是只读文档)');

  // 让人看得见:把刚写入的那几行标绿(只留最后一次)
  const end = doc.positionAt(doc.offsetAt(position) + text.length);
  markChanged(editor, [new vscode.Range(position, end)], { before, after: doc.getText(), created });

  const lines = lineCountOf(text);
  const warning = lineWarning(lines);
  return {
    path: relative(doc.uri.fsPath),
    inserted: text.length,
    lines,
    at: { line: position.line + 1, character: position.character + 1 },
    version: doc.version,
    dirty: doc.isDirty,
    ...(created ? { created: true } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * 把客户端给的 1-based 范围换成 Range;不给就是整份。
 *
 * 支持 {from, to},也接受 {start, end} —— 不同客户端的叫法不同,都认。
 */
function rangeOf(doc, range) {
  if (!range) {
    return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  }
  return new vscode.Range(
    positionOf(doc, range.from ?? range.start),
    positionOf(doc, range.to ?? range.end),
  );
}

/**
 * 替换一段(或整份)。
 *
 * 和 insert 共用同一把尺子:超过 20 行照写,但返回里提醒;
 * 并且报 replacedLines,让模型看见自己一次动了多少行。
 */
async function replace(request) {
  const prepared = await documentForWrite('replace', request);
  if (prepared.needConfirm) return prepared.needConfirm;

  const { doc, source, created } = prepared;
  const text = String(source?.text ?? '');
  const editor = frontEditorOf(doc); // 必须在前台,否则不写
  const range = rangeOf(doc, source?.range);

  const before = doc.getText();
  markSelfAction();
  expectSelfChange(doc.uri.toString());
  const applied = await editor.edit((builder) => builder.replace(range, text));
  if (!applied) throw new Error('编辑器拒绝了这次修改(可能是只读文档)');

  const end = doc.positionAt(doc.offsetAt(range.start) + text.length);
  markChanged(editor, [new vscode.Range(range.start, end)], { before, after: doc.getText(), created });

  const lines = lineCountOf(text);
  // "换了第几行到第几行"要按**真正被覆盖的行**算:
  //   · 零长度范围 = 纯插入,一行都没删
  //   · 范围结束在"下一行的第 0 列"时,最后一行其实没被碰到(那是行尾换行)
  const affectedTo = range.isEmpty
    ? range.start.line
    : range.end.character === 0
      ? range.end.line - 1
      : range.end.line;
  const replacedLines = range.isEmpty ? 0 : Math.max(0, affectedTo - range.start.line + 1);
  const warning = lineWarning(lines);
  return {
    path: relative(doc.uri.fsPath),
    lines,
    replacedLines,
    from: { line: range.start.line + 1, character: range.start.character + 1 },
    to: { line: affectedTo + 1, character: range.end.character + 1 },
    version: doc.version,
    dirty: doc.isDirty,
    ...(created ? { created: true } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * 打开文件并聚焦。
 *
 * 这是**唯一**该抢焦点的 op —— 写操作要求目标在前台,所以它是写的前置动作。
 */
async function open(request) {
  if (!request?.file) throw new Error('缺少 file');
  const doc = await openDocument(request.file);

  markSelfAction();
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });

  return {
    path: relative(doc.uri.fsPath),
    focused: vscode.window.activeTextEditor === editor,
    version: doc.version,
    dirty: doc.isDirty,
  };
}

/**
 * 落盘。
 *
 * Auto Save 开着时文件可能早就干净了 —— 那时 save 是空操作,返回 saved:true,
 * 不是错误。
 */
async function save(request) {
  if (!request?.file) throw new Error('缺少 file');
  const doc = await openDocument(request.file);
  if (!doc.isDirty) return { path: relative(doc.uri.fsPath), saved: true, wasDirty: false };
  const ok = await doc.save();
  if (!ok) throw new Error('保存失败(可能是只读文件)');
  return { path: relative(doc.uri.fsPath), saved: true, wasDirty: true };
}

module.exports = { positionOf, rangeOf, frontEditorOf, insert, replace, open, save, clearStaged };
