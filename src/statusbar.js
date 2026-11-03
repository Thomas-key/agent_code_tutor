const vscode = require('vscode');
const handoff = require('./handoff');

/**
 * 状态栏:人这一侧的三个按钮。
 *
 *   ① 询问 agent      —— 把"问问这个文件"排进队列(不立刻发)
 *   ② 继续 / 唤醒     —— 等:发队列 + 叫醒;空闲:发队列(可以没有)+ 叫醒
 *   ③ 暂停 / 取消     —— 等:撤回这一拍;空闲:清空队列
 *
 * 为什么先排队:agent 写代码的时候,人可能已经想好要问什么了。
 * 攒着,等它停下来再一次性发过去 —— 不然每问一句就打断它一次。
 */

/** 待发队列:每一项都是一个要推给 agent 的 message。 */
const queue = [];

let askItem = null;
let primaryItem = null;
let secondaryItem = null;

/**
 * 三个按钮用同一个主题色,视觉上连成一块。
 *
 * 只能是 statusBarItem.* 系列颜色。不用 warningBackground(黄) —— 太像报警;
 * prominentBackground 是半透明黑,很含蓄但能把一组按钮和别的分开。
 */
const BACKGROUND = new vscode.ThemeColor('statusBarItem.prominentBackground');

function make(text, command, tooltip) {
  // priority 给得很低 —— 让它排在左组的最右端,尽量靠近中间
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
  item.text = text;
  item.command = command;
  item.tooltip = tooltip;
  item.backgroundColor = BACKGROUND;
  item.show();
  return item;
}

/** 按"在不在等"和"队列空不空"重画三个按钮。 */
function refresh() {
  const waiting = handoff.isWaiting();
  const pending = queue.length;

  // 条数直接写进按钮文字 —— hover 提示里才有的东西等于没有
  askItem.text = pending > 0 ? `$(comment-discussion) 询问 agent (${pending})` : '$(comment-discussion) 询问 agent';
  askItem.tooltip = pending > 0 ? `已攒 ${pending} 条,点继续/唤醒才发` : '问这个文件';

  if (waiting) {
    primaryItem.text = '$(debug-continue) 继续';
    primaryItem.tooltip = pending > 0 ? `发出去并继续(${pending} 条问话)` : '继续(agent 在等你)';
    secondaryItem.text = '$(debug-pause) 暂停';
    secondaryItem.command = 'tutorApi.secondary';
    secondaryItem.tooltip = '撤回这一拍的写入';
  } else {
    primaryItem.text = '$(bell) 唤醒';
    primaryItem.tooltip = pending > 0 ? `唤醒 agent(${pending} 条问话)` : '唤醒 agent';
    // 没有可取消的东西 —— 状态栏没有 disabled,只能让它按了没反应
    if (pending > 0) {
      secondaryItem.text = '$(close) 取消';
      secondaryItem.command = 'tutorApi.secondary';
      secondaryItem.tooltip = `清掉攒着的 ${pending} 条问话`;
    } else {
      secondaryItem.text = '$(circle-slash) 取消';
      secondaryItem.command = undefined;
      secondaryItem.tooltip = '没有攒着的东西可取消';
    }
  }
}

/** 把一条问话排进队列。 */
function enqueue(message) {
  queue.push(message);
  refresh();
}

/** 取走全部排队项(发送用)。 */
function takeQueue() {
  const items = queue.splice(0, queue.length);
  refresh();
  return items;
}

/** 创建三个按钮。必须在 activate 里调(主题色和状态栏都已经可用)。 */
function create() {
  askItem = make('$(comment-discussion) 询问 agent', 'tutorApi.askFile', '问这个文件');
  primaryItem = make('$(bell) 唤醒', 'tutorApi.primary', '唤醒 agent');
  secondaryItem = make('$(circle-slash) 取消', 'tutorApi.secondary', '没有攒着的东西可取消');

  handoff.onWaitingChange(() => refresh());
  refresh();
}

/** 右边的临时提示项。setStatusBarMessage 只会出现在左边,所以要自己做一个。 */
let toastItem = null;
let toastTimer = null;

/**
 * 在**右边**闪一条提示。
 *
 * @param {string} text 支持 $(icon) 图标语法
 * @param {number} ms 显示多久
 */
function flash(text, ms = 2500) {
  if (!toastItem) {
    toastItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
  }
  toastItem.text = text;
  toastItem.show();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastItem.hide(), ms);
}

module.exports = { create, refresh, enqueue, takeQueue, flash };
