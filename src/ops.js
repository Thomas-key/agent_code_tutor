/**
 * 所有 op 的目录。
 *
 * 打开这一个文件,就能看到 agent 能用哪些能力 —— 名字、一句话说明、指向哪个函数。
 * 实现放在各自模块里(感知在 sense.js,写操作将来在 actions.js),这里不写实现。
 */
const sense = require('./sense');
const actions = require('./actions');
const present = require('./present');
const handoff = require('./handoff');

/**
 * 把全部能力登记进注册表。
 *
 * @param {object} registry createRegistry() 的返回值
 */
function registerAll(registry) {
  registry.add('ping', {
    summary: '连通性检查;顺带返回支持哪些 op',
    run: (request, ctx) => ({ version: ctx.version, ops: registry.names() }),
  });

  // ── 感知 ──
  registry.add('scene', {
    summary: '场景快照:前台文件 / 光标 / 选区 / 未落盘',
    run: sense.scene,
  });
  registry.add('read', {
    summary: '读文件内容(内存 buffer);默认前 200 行,带总行数与区间',
    run: sense.read,
  });

  // ── 执行 ──
  registry.add('insert', {
    summary: '在文件里插入文本;at = end / cursor / {line, character}。教学节奏:一次最多 20 行,超了会提示',
    run: actions.insert,
  });
  registry.add('replace', {
    summary: '替换一段或整份;range 用 1-based 的 {from,to},省略即整份。同样建议一次 ≤20 行',
    run: actions.replace,
  });
  registry.add('open', {
    summary: '打开文件并聚焦 —— 写操作要求目标在前台,所以写之前通常先调它',
    run: actions.open,
  });
  registry.add('save', {
    summary: '落盘;文件不脏时是空操作',
    run: actions.save,
  });

  // ── 展示 ──
  registry.add('highlight', {
    summary: '高亮若干整行(累加);ranges 用 1-based 的 {fromLine, toLine}',
    run: present.highlight,
  });
  registry.add('annotate', {
    summary: '在某一行挂一句话:行尾灰字 + hover,不改文档',
    run: present.annotate,
  });
  registry.add('clear', {
    summary: '清掉 agent 留下的一切浮层(高亮/注解)与待新建暂存;不动文档内容',
    run: () => ({ ...present.clearAll(), stagedCreates: actions.clearStaged() }),
  });

  // ── 交棒 ──
  registry.add('wait', {
    summary: '等人明确说“继续”(confirm 信号);timeoutMs=0 表示一直等',
    run: handoff.wait,
  });
}

module.exports = { registerAll };
