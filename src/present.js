const vscode = require('vscode');

const { openDocument, relative } = require('./document');
const { markSelfAction, expectSelfChange } = require('./sense');

/**
 * 展示层:高亮与注解。
 *
 * 它们不改文档、不进事件流 —— 只要求目标文件**可见**
 * (装饰只能画在可见的编辑器上;但没有要求它在前台)。
 *
 * 状态按文件存:高亮范围会累加,注解各自一个 decoration type(每行文字不同)。
 */

/** path → { ranges: Range[], highlight: type|null, notes: [{line,text,type}] } */
const state = new Map();

function stateOf(path) {
  let entry = state.get(path);
  if (!entry) {
    entry = { ranges: [], highlight: null, notes: [], changed: null };
    state.set(path, entry);
  }
  return entry;
}

/** 这个文档现在有没有可见的编辑器;没有就没地方画装饰。 */
function visibleEditorOf(doc) {
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === doc.uri.toString(),
  );
  if (editor) return editor;
  throw new Error(`文件不在任何可见编辑器里:${relative(doc.uri.fsPath)} —— 先调 open 再指`);
}

/**
 * 高亮若干段。**累加**:多次调用会往上加,清的时机归 clear。
 *
 * ranges 用 1-based 的 {fromLine, toLine},两端都含;整行高亮。
 */
async function highlight(request) {
  const doc = await openDocument(request?.file);
  const editor = visibleEditorOf(doc);
  const entry = stateOf(relative(doc.uri.fsPath));

  const ranges = (request?.ranges ?? []).map((item) => {
    const from = Math.max(0, Math.min((Number(item.fromLine) || 1) - 1, doc.lineCount - 1));
    const to = Math.max(from, Math.min((Number(item.toLine) || item.fromLine || 1) - 1, doc.lineCount - 1));
    return new vscode.Range(doc.lineAt(from).range.start, doc.lineAt(to).range.end);
  });

  if (!entry.highlight) {
    entry.highlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      // 代码一长,正文里的底色找不到 —— 让它在右侧滚动条上也有道
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
  }
  entry.ranges.push(...ranges);
  editor.setDecorations(entry.highlight, entry.ranges);

  // 每段的首行源码。模型指完得能看见"我指的是哪一段" ——
  // 只回一个总数,它下一轮引用这段代码只能凭记忆,一错就错一片。
  const segments = ranges.map((range) => ({
    from: range.start.line + 1,
    to: range.end.line + 1,
    code: doc.lineAt(range.start.line).text,
  }));

  return { path: relative(doc.uri.fsPath), ranges: entry.ranges.length, segments };
}

/**
 * 标出"这一拍改过的行"。
 *
 * 和 highlight 不是一回事:highlight 是"我在指给你看",这里表示"我刚动了这块"。
 * 只留最后一次 —— 下一次写入会覆盖它(否则人会以为整个文件都是我改的)。
 */
function markChanged(editor, ranges, snapshot) {
  const path = relative(editor.document.uri.fsPath);
  const entry = stateOf(path);

  if (entry.changed) entry.changed.type.dispose();
  const type = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  editor.setDecorations(type, ranges);
  // 快照留着给两件事用:diff 的左边、以及"暂停时撤回"
  entry.changed = {
    type,
    uri: editor.document.uri.toString(),
    before: snapshot?.before ?? null,
    after: snapshot?.after ?? null,
    created: snapshot?.created === true,
  };
}

/**
 * 撤回最后一次写入 —— 把内容恢复成写之前。
 *
 * 只在"当前内容正好等于写入后的样子"时动手;人改过一个字符就不碰,
 * 那是他的东西,不是我们的。
 *
 * @returns {Promise<boolean>} 是否真的撤回了
 */
async function revertLastWrite() {
  for (const entry of state.values()) {
    const changed = entry.changed;
    // 注意是 typeof,不是真值判断:新建文件的 before 就是空字符串,而 '' 是 falsy
    if (!changed || typeof changed.before !== 'string' || typeof changed.after !== 'string') continue;

    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === changed.uri);
    if (!doc) continue;

    const current = doc.getText();
    if (current !== changed.after) return false; // 人动过,不撤

    // 这一拍"新建"的文件:撤回 = 删掉它,而不是把内容清空
    // (磁盘上很可能已经被自动保存写过了,清空会留下一份空文件)
    if (changed.created) {
      try {
        await vscode.workspace.fs.delete(doc.uri, { useTrash: false });
        entry.changed = null;
        return true;
      } catch {
        return false;
      }
    }

    markSelfAction(); // 撤回也是我们干的,别记成"人改的"
    expectSelfChange(doc.uri.toString());
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(current.length)), changed.before);
    return vscode.workspace.applyEdit(edit);
  }
  return false;
}

/**
 * 在某一行挂一句话。
 *
 * 渲染两处:行尾灰字(短注解一眼读完)+ hover(长注解 tooltip 会换行)。
 * 每行一个独立的 decoration type —— after.contentText 是类型级属性,没法按行不同。
 */
async function annotate(request) {
  const doc = await openDocument(request?.file);
  const editor = visibleEditorOf(doc);
  const entry = stateOf(relative(doc.uri.fsPath));
  const text = String(request?.text ?? '');
  if (!text) throw new Error('缺少 text');
  const line = Math.max(1, Math.min(Number(request?.line) || 1, doc.lineCount));

  const type = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: `  ←${text}`,
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    hoverMessage: new vscode.MarkdownString(` ↓${text}`),
  });
  const range = doc.lineAt(line - 1).range;
  editor.setDecorations(type, [{ range }]);
  entry.notes.push({ line, text, type });

  return {
    path: relative(doc.uri.fsPath),
    line,
    notes: entry.notes.length,
    // 注解是"挂在某一行上的一句话",只回行号等于没回 ——
    // 模型要靠这行源码确认自己挂对了地方。
    code: doc.lineAt(line - 1).text,
  };
}

/**
 * 清掉我们留下的一切浮层:高亮 + 注解。
 *
 * **不清文档内容** —— 那是用户的代码,clear 不是撤销。
 */
function clearAll() {
  let highlights = 0;
  let notes = 0;
  for (const entry of state.values()) {
    highlights += entry.ranges.length;
    if (entry.highlight) {
      entry.highlight.dispose();
      entry.highlight = null;
    }
    entry.ranges = [];
    notes += entry.notes.length;
    for (const note of entry.notes) note.type.dispose();
    entry.notes = [];
    if (entry.changed) {
      entry.changed.type.dispose();
      entry.changed = null;
    }
  }
  state.clear();
  return { highlights, notes };
}

module.exports = { highlight, annotate, markChanged, revertLastWrite, clearAll };
