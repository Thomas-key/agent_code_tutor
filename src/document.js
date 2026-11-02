const vscode = require('vscode');
const path = require('path');

/**
 * "工作区里的文件"这一层:路径换算 + 拿文档。
 *
 * 它既不属于"看"(sense)也不属于"改"(actions)—— 两者都要用它,所以单独一层。
 * 除了 ensureDocument 会创建文件,其它全是只读的。
 */

/** 工作区根目录;没打开文件夹时是 null。 */
function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : null;
}

/**
 * 绝对路径 → 相对工作区的路径,统一用 /。
 *
 * 客户端拿到这个路径会原样回传给我们,所以它不能依赖"你机器上的目录长什么样"。
 */
function relative(fsPath) {
  const root = workspaceRoot();
  if (!root) return fsPath;
  return path.relative(root, fsPath).split(path.sep).join('/');
}

/** 相对路径 → Uri。绝对路径、.. 一律拒绝 —— 客户端只能碰工作区里的文件。 */
function uriOf(file) {
  const root = workspaceRoot();
  if (!root) throw new Error('没有打开文件夹');
  const target = String(file || '');
  if (!target) throw new Error('缺少 file');
  if (path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) {
    throw new Error(`路径不允许:${target}`);
  }
  return vscode.Uri.joinPath(vscode.Uri.file(root), target);
}

/** 找已打开的文档。按 Uri 找,不是按文件名 —— 同名不同目录不能混。 */
function findDocument(uri) {
  return vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString()) ?? null;
}

/** 拿文档:已打开就复用,没打开就打开。**不创建** —— 创建是写操作的职责。 */
async function openDocument(file) {
  const uri = uriOf(file);
  const opened = findDocument(uri);
  if (opened) return opened;
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    throw new Error(`文件不存在:${relative(uri.fsPath)}`);
  }
}

/** 只找/打开,**不创建**;文件不存在返回 null(不抛)—— 用来判断"要不要走确认流程"。 */
async function tryOpenDocument(file) {
  const uri = uriOf(file);
  const opened = findDocument(uri);
  if (opened) return opened;
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return null;
  }
}

/** 拿文档给写操作用:找不到就建一个空文件,这样"写进新文件"也能成立。 */
async function ensureDocument(file) {
  const uri = uriOf(file);
  const opened = findDocument(uri);
  if (opened) return opened;
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.alloc(0));
    return await vscode.workspace.openTextDocument(uri);
  }
}

module.exports = {
  workspaceRoot,
  relative,
  uriOf,
  findDocument,
  openDocument,
  tryOpenDocument,
  ensureDocument,
};
