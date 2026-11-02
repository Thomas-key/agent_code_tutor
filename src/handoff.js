const { drainEvents, subscribe } = require('./sense');

/**
 * 交棒:等人明确说"我看完了"。
 *
 * **只被 confirm / abort 唤醒** —— 打字、切文件、保存都不算。
 *
 * 为什么:继续是人的决定,不是噪声。用"任何动作"当判据的话,
 * 用户随手打一个字 agent 就被叫醒,它会误以为该往下讲,节奏就丢了。
 *
 * timeoutMs = 0 表示一直等(那时就只能靠 confirm / abort 叫醒)。
 */

/** 现在有几个 agent 在等。可能是多个客户端,所以用计数不用布尔。 */
let waitingCount = 0;

/** 等待状态变化时通知 —— 状态栏靠它切换"继续 / 唤醒"。 */
const waitingListeners = new Set();

/** 有 agent 在等吗? */
function isWaiting() {
  return waitingCount > 0;
}

/** 订阅等待状态变化,返回退订函数。 */
function onWaitingChange(listener) {
  waitingListeners.add(listener);
  return () => waitingListeners.delete(listener);
}

function setWaitingCount(next) {
  if (waitingCount === next) return;
  const wasWaiting = waitingCount > 0;
  waitingCount = next;
  const nowWaiting = waitingCount > 0;
  if (wasWaiting === nowWaiting) return; // 1 → 2 这种不算状态变化
  for (const listener of waitingListeners) {
    try {
      listener(nowWaiting);
    } catch {}
  }
}

async function wait(request) {
  const timeoutMs = Number(request?.timeoutMs) || 0;

  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let unsubscribe = () => {};

    const finish = (ended, event) => {
      if (done) return;
      done = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      // 先减计数再 resolve —— 外面在拿到结果之前就该看到"不在等了"
      setWaitingCount(waitingCount - 1);
      // 等到了,顺手把这段时间攒的事件一起带走
      resolve({ ended, event: event ?? null, events: drainEvents() ?? { recent: [], older: {} } });
    };

    unsubscribe = subscribe((event) => {
      // confirm = 看完了继续;abort = 暂停(这时代码已经被撤回了)
      if (event.t !== 'confirm' && event.t !== 'abort') return;
      finish(event.t, event);
    });

    setWaitingCount(waitingCount + 1);
    if (timeoutMs > 0) timer = setTimeout(() => finish('timeout', null), timeoutMs);
  });
}

module.exports = { wait, isWaiting, onWaitingChange };
