import assert from "node:assert/strict";
import { apply, alignCtimeOnlyVersion } from "../lib/index.js";

let passed = 0;
const run = async (title, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${title}`);
};

/** 版本串样例：dev:ino:size:mtimeNs:ctimeNs */
const version = (mtime = "1000", ctime = "2000", ino = "42", size = "6", dev = "16777232") =>
  `${dev}:${ino}:${size}:${mtime}:${ctime}`;

/**
 * 最小 cordis 替身：只实现本插件用到的 on/waterfall 语义。
 * - listeners 默认 push，`{ prepend: true }` 时 unshift；
 * - waterfall 外层先执行，listener 调用 next() 才继续，不调用即短路。
 */
class FakeContext {
  hooks = new Map();
  statCalls = 0;
  statResult;
  statError;

  constructor(statResult) {
    this.statResult = statResult;
    this.fs = {
      stat: async () => {
        this.statCalls += 1;
        if (this.statError) throw this.statError;
        return this.statResult;
      },
    };
  }

  on(name, listener, options) {
    const list = this.hooks.get(name) ?? [];
    this.hooks.set(name, list);
    const prepend = typeof options === "boolean" ? options : options?.prepend === true;
    if (prepend) list.unshift(listener);
    else list.push(listener);
  }

  waterfall(name, ...args) {
    const listeners = [...(this.hooks.get(name) ?? [])];
    const inner = args.pop();
    const next = () => (listeners.shift() ?? inner)(...args, next);
    args.push(next);
    return next();
  }

  /** 模拟 fs-observation-policy：短路并返回固定 intent。 */
  policy(name, getIntent) {
    this.on(name, async () => getIntent(), { prepend: false });
  }
}

const makeCtx = (statResult) => {
  const ctx = new FakeContext(statResult);
  apply(ctx);
  return ctx;
};

const editIntent = (ctx, target = { targetKey: "/tmp/a", displayPath: "/tmp/a" }) =>
  ctx.waterfall("fs/edit-intent", target, { agent: { session: {} } }, () => undefined);

await run("只差 ctime 时对齐到当前版本", () => {
  const observed = version("1000", "2000");
  const current = version("1000", "9999");
  assert.equal(alignCtimeOnlyVersion(observed, current), current);
});

await run("版本完全一致时不改写", () => {
  const same = version();
  assert.equal(alignCtimeOnlyVersion(same, same), undefined);
});

await run("mtime 不同不算 ctime 噪声", () => {
  assert.equal(alignCtimeOnlyVersion(version("1000"), version("1001")), undefined);
});

await run("size 不同不算 ctime 噪声", () => {
  assert.equal(alignCtimeOnlyVersion(version("1000", "2000", "42", "6"), version("1000", "2000", "42", "7")), undefined);
});

await run("inode 不同视为文件被替换", () => {
  assert.equal(alignCtimeOnlyVersion(version("1000", "2000", "42"), version("1000", "2000", "43")), undefined);
});

await run("missing / 畸形版本原样放过", () => {
  assert.equal(alignCtimeOnlyVersion(`missing:/tmp/a`, version()), undefined);
  assert.equal(alignCtimeOnlyVersion("garbage", version()), undefined);
  assert.equal(alignCtimeOnlyVersion(undefined, version()), undefined);
});

await run("只认严格的五段十进制协议", () => {
  // 五段但不是十进制：非 fs-local 协议，必须保守退回
  assert.equal(alignCtimeOnlyVersion("a:b:c:d:e", "a:b:c:d:f"), undefined);
  // 空段
  assert.equal(alignCtimeOnlyVersion("::::", "::::noise"), undefined);
  // 段数不对
  assert.equal(alignCtimeOnlyVersion("1:2:3:4", "1:2:3:5"), undefined);
  assert.equal(alignCtimeOnlyVersion("1:2:3:4:5:6", "1:2:3:4:5:7"), undefined);
  // 负号/空格/浮点
  assert.equal(alignCtimeOnlyVersion("-1:2:3:4:5", "-1:2:3:4:6"), undefined);
  assert.equal(alignCtimeOnlyVersion(" 1:2:3:4:5", " 1:2:3:4:6"), undefined);
  // 合法十进制仍放行
  assert.equal(alignCtimeOnlyVersion("1:2:3:4:5", "1:2:3:4:6"), "1:2:3:4:6");
});

await run("已知弱化：同尺寸、精确恢复 mtime 的修改会被放行（与上游 #3111 取舍一致）", () => {
  // 文档化当前取舍：ctime 是唯一能看出“原地同尺寸改写 + 恢复 mtime”的字段，
  // 忽略它意味着这种并发修改无法被本插件识别；这是显式接受的风险，不是 bug。
  const observed = version("1000", "2000", "42", "12");
  const current = version("1000", "9999", "42", "12");
  assert.equal(alignCtimeOnlyVersion(observed, current), current);
});

await run("edit intent：ctime 噪声被放行", async () => {
  const observed = version("1000", "2000");
  const current = version("1000", "9999");
  const ctx = makeCtx({ version: current, type: "file", size: 6 });
  ctx.policy("fs/edit-intent", () => ({ version: observed }));
  assert.deepEqual(await editIntent(ctx), { version: current });
  assert.equal(ctx.statCalls, 1);
});

await run("edit intent：真实修改仍然拒绝", async () => {
  const observed = version("1000", "2000");
  const intent = { version: observed };
  const ctx = makeCtx({ version: version("1001", "2000"), type: "file", size: 6 });
  ctx.policy("fs/edit-intent", () => intent);
  assert.equal(await editIntent(ctx), intent);
});

await run("edit intent：policy 不判定时不 stat", async () => {
  const ctx = makeCtx({ version: version() });
  assert.equal(await editIntent(ctx), undefined);
  assert.equal(ctx.statCalls, 0);
});

await run("edit intent：stat 失败时回退原判定", async () => {
  const intent = { version: version("1000", "2000") };
  const ctx = makeCtx(undefined);
  ctx.statError = new Error("boom");
  ctx.policy("fs/edit-intent", () => intent);
  assert.equal(await editIntent(ctx), intent);
});

await run("write intent：createIfAbsent 原样返回且不 stat", async () => {
  const intent = { kind: "createIfAbsent" };
  const ctx = makeCtx({ version: version() });
  ctx.policy("fs/write-intent", () => intent);
  assert.equal(await ctx.waterfall("fs/write-intent", { targetKey: "/tmp/a" }, {}, () => undefined), intent);
  assert.equal(ctx.statCalls, 0);
});

await run("write intent：replaceIfVersion 的 ctime 噪声被对齐", async () => {
  const observed = version("1000", "2000");
  const current = version("1000", "9999");
  const ctx = makeCtx({ version: current, type: "file", size: 6 });
  ctx.policy("fs/write-intent", () => ({ kind: "replaceIfVersion", version: observed }));
  assert.deepEqual(await ctx.waterfall("fs/write-intent", { targetKey: "/tmp/a" }, {}, () => undefined), {
    kind: "replaceIfVersion",
    version: current,
  });
});

await run("write intent：真实修改保留原版本", async () => {
  const intent = { kind: "replaceIfVersion", version: version("1000", "2000") };
  const ctx = makeCtx({ version: version("1002", "2000"), type: "file", size: 6 });
  ctx.policy("fs/write-intent", () => intent);
  assert.equal(await ctx.waterfall("fs/write-intent", { targetKey: "/tmp/a" }, {}, () => undefined), intent);
});

await run("policy 先注册时插件仍排到前面（prepend 生效）", async () => {
  const observed = version("1000", "2000");
  const current = version("1000", "9999");
  const ctx = new FakeContext({ version: current, type: "file", size: 6 });
  // 模拟真实加载顺序：base preset 的 fs-observation-policy 先注册（且短路，不调用 next）
  ctx.policy("fs/edit-intent", () => ({ version: observed }));
  apply(ctx);
  assert.deepEqual(await editIntent(ctx), { version: current });
});

console.log(`\n${passed} tests passed`);
