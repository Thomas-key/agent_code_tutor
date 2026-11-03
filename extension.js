const vscode = require('vscode');
const crypto = require('crypto');
const { createBridge } = require('./src/bridge');
const { createRegistry } = require('./src/registry');
const { createDispatch, VERSION } = require('./src/api');
const { registerAll } = require('./src/ops');
const { startWatching, viewFor, pushEvent } = require('./src/sense');
const { revertLastWrite, clearAll } = require('./src/present');
const handoff = require('./src/handoff');
const statusbar = require('./src/statusbar');

/** 和已装的 agent-tutor(41888)错开:两个扩展能同时跑着比。 */
const DEFAULT_PORT = 41890;

let bridge = null;
let output = null;

/** 扩展入口:VS Code 激活时调用一次。 */
function activate(context) {
  output = vscode.window.createOutputChannel('Tutor API');
  context.subscriptions.push(output);

  // 感知的另一半:人做了什么。挂上就能被 scene/events 读到。
  context.subscriptions.push(...startWatching());

  // 会话身份:一个工作区生成一次。用户可以在工作区设置里改 —— 但客户端也得改。
  ensureConversationToken();

  const registry = createRegistry();
  registerAll(registry);

  context.subscriptions.push(
    vscode.commands.registerCommand('tutorApi.confirm', confirmTurn),
    vscode.commands.registerCommand('tutorApi.abort', abortTurn),
    vscode.commands.registerCommand('tutorApi.ask', askAgentFromEditor),
    vscode.commands.registerCommand('tutorApi.askFile', askFile),
    vscode.commands.registerCommand('tutorApi.primary', primaryAction),
    vscode.commands.registerCommand('tutorApi.secondary', secondaryAction),
  );

  const port = getPort();
  bridge = createBridge({
    port,
    dispatch: createDispatch({
      registry,
      version: VERSION,
      viewFor,
      // 每次请求现读:用户在设置里改了 token,立刻生效
      getToken: () => vscode.workspace.getConfiguration('tutorApi').get('conversationToken'),
    }),
  });

  statusbar.create();

  bridge
    .listen()
    .then((actual) => log(`监听 127.0.0.1:${actual} · 已登记 op:${registry.names().join(', ')}`))
    .catch((error) => {
      log(`起不来:${error.message}`);
      // 只写日志等于没告诉用户 —— 端口冲突必须弹出可见提示,并且能一键去改
      if (String(error.message).includes('EADDRINUSE')) {
        vscode.window
          .showErrorMessage(
            `端口 ${port} 被占用,Tutor API 起不来。改一下设置 tutorApi.port(DSH 侧插件也要改成同一个值)。`,
            '打开设置',
          )
          .then((choice) => {
            if (choice === '打开设置') {
              vscode.commands.executeCommand('workbench.action.openSettings', 'tutorApi.port');
            }
          });
      }
    });
}

/**
 * 确保工作区有会话 token;没有就生成一个写回**工作区设置**。
 *
 * 为什么是 token 而不是固定端口:多开时靠它把"人说的话"送到对的会话。
 */
function ensureConversationToken() {
  const config = vscode.workspace.getConfiguration('tutorApi');
  const current = config.get('conversationToken');
  if (typeof current === 'string' && current.trim()) {
    log(`会话 token:${current}`);
    return current;
  }
  const token = crypto.randomBytes(4).toString('hex'); // 8 位十六进制,好念也好抄
  config.update('conversationToken', token, vscode.ConfigurationTarget.Workspace).then(
    () => log(`已生成会话 token:${token}(写进工作区设置,客户端要带同一个)`),
    (error) => log(`生成 token 失败:${error.message}`),
  );
  return token;
}

/**
 * 人主动问 agent 一句:把问题推给"最后用过这个 token"的客户端。
 *
 * 这是唯一一条**反方向**的消息 —— 没有 id,不等回复。
 * 带着选中的代码,所以对方不用再 read 一遍。
 */
async function askAgentFromEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    log('没有前台文件 —— 先打开一个文件再问');
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  const quote = sel.isEmpty ? doc.lineAt(sel.active.line).text : doc.getText(sel);

  const text = await vscode.window.showInputBox({
    prompt: '问 agent 一句(会立刻推给它)',
    placeHolder: '这里为什么这么写?',
    ignoreFocusOut: true,
  });
  if (!text || !text.trim()) return;

  const token = vscode.workspace.getConfiguration('tutorApi').get('conversationToken');
  statusbar.enqueue({
    event: 'ask',
    text: text.trim(),
    file: vscode.workspace.asRelativePath(doc.uri),
    line: sel.start.line + 1,
    quote: quote.slice(0, 400),
  });
  log(`已排队:问第 ${sel.start.line + 1} 行(点继续/唤醒才发)`);
}

/** 当前监听端口:设置里改了立刻生效(下次激活)。 */
function getPort() {
  const configured = vscode.workspace.getConfiguration('tutorApi').get('port');
  const port = Number(configured);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

function currentToken() {
  return vscode.workspace.getConfiguration('tutorApi').get('conversationToken');
}

/**
 * 按钮①:问这个文件(带文本,排在队里)。
 *
 * **不带文件内容** —— 只给路径 + 人打的字。内容由 agent 自己 read:
 * 它能控制读多少(默认 200 行),而且每次读都是最新的;
 * 我们塞过去的整份内容会永久留在会话里,还可能是过期的。
 */
async function askFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    log('没有前台文件 —— 先打开一个文件');
    return;
  }
  const file = vscode.workspace.asRelativePath(editor.document.uri);

  const text = await vscode.window.showInputBox({
    prompt: `问 agent 关于 ${file} 的问题(会先排进队列)`,
    placeHolder: '这个文件是做什么的?',
    ignoreFocusOut: true,
  });
  if (!text || !text.trim()) return;

  statusbar.enqueue({ event: 'ask', file, text: text.trim() });
  statusbar.flash(`$(check) 已排队:问 ${file}`);
  log(`已排队:问 ${file} —— ${text.trim()}(点继续/唤醒才发)`);
}

/**
 * 按钮②:继续 / 唤醒。
 *
 * 两种情况都做同一件事:把队列发出去。
 * 区别只在于"怎么叫醒":
 *   在等 → 发个内部 confirm 事件(那个 wait 立刻返回)
 *   空闲 → 推一条 confirm 给客户端(它下次请求时会看到)
 */
function primaryAction() {
  const pending = statusbar.takeQueue();
  const token = currentToken();

  if (handoff.isWaiting()) {
    // 有工具在等:问话**跟着这次等待一起交回给那个工具**,不推送。
    // 推送会走客户端的"开新回合",结果是聊天里多一条用户消息,
    // 而模型正在等工具返回 —— 它和这次写入对不上号。
    handoff.addAsks(pending);
    // 继续 = 这一步读完了:把这一步的指(高亮/注解)擦掉,但代码不动
    clearAll();
    pushEvent({ t: 'confirm' });
    statusbar.flash(`$(debug-continue) 继续(带回 ${pending.length} 条问话)`);
    log(`继续(带回 ${pending.length} 条问话)`);
  } else {
    // 没人等,只能推给客户端:它会开一个新回合来接住这些问话。
    for (const message of pending) {
      // 带上本工作区的 token:DSH 那边可能同时绑着多个工作区,
      // 只有它能说明"这条问话来自哪一块编辑器"。
      if (bridge) bridge.broadcastTo(token, { ...message, token });
    }
    const sent = bridge ? bridge.broadcastTo(token, { event: 'confirm', token }) : 0;
    statusbar.flash(
      sent > 0 ? `$(bell) 已唤醒(发出 ${pending.length} 条问话)` : '$(warning) 没有客户端连着 —— 唤醒没发出去',
      3000,
    );
    log(`唤醒(发出 ${pending.length} 条问话)`);
  }
}

/**
 * 按钮③:暂停 / 取消。
 *
 * 在等 → 撤回这一拍(和老版本一样)
 * 空闲 → 只清空队列
 */
async function secondaryAction() {
  if (handoff.isWaiting()) {
    await abortTurn();
    return;
  }
  const dropped = statusbar.takeQueue().length;
  statusbar.flash(`$(close) 已取消 ${dropped} 条问话`);
  log(`已取消 ${dropped} 条问话`);
}

/**
 * 人按"继续":只发信号,什么都不改。
 *
 * 这是唯一能叫醒 wait 的信号 —— 打字、切文件都不算。
 */
function confirmTurn() {
  pushEvent({ t: 'confirm' });
  log('继续');
}

/**
 * 人按"暂停":撤回这一拍的写入,擦掉痕迹,再发 abort。
 *
 * 顺序不能反:先撤回(那时 state 还在),再 clearAll(它会清掉快照)。
 */
async function abortTurn() {
  const reverted = await revertLastWrite();
  // 暂停前问过的话也要跟着回去 —— 否则它们卡在队列里,
  // 下次点"继续"才突然冒出来,和当时那一拍对不上。
  const pending = statusbar.takeQueue();
  handoff.addAsks(pending);
  clearAll();
  pushEvent({ t: 'abort' });
  log(reverted ? '暂停:已撤回这一拍' : '暂停:没有可撤回的写入');
}

/** VS Code 在禁用/卸载/关窗口时调用。 */
function deactivate() {
  if (bridge) {
    bridge.close();
    bridge = null;
  }
}

function log(message) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

module.exports = { activate, deactivate };
