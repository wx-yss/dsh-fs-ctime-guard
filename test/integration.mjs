// 真实栈集成测试：cordis + dsh-fs-local + fs-observation-policy + 本插件。
//
// 依赖本机 DSH 安装目录（默认从 ~/.npm/_npx 自动发现，可用 DSH_NPX_ROOT 覆盖）。
// 找不到就跳过，保证在没装 DSH 的机器上 npm test 仍然可跑。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../lib/index.js";

function findDshRoot() {
  if (process.env.DSH_NPX_ROOT) return process.env.DSH_NPX_ROOT;
  const base = join(homedir(), ".npm", "_npx");
  if (!existsSync(base)) return undefined;
  for (const entry of readdirSync(base)) {
    const candidate = join(base, entry, "node_modules");
    if (existsSync(join(candidate, "@deepseek-ai", "cordis", "lib", "index.js"))) return candidate;
  }
  return undefined;
}

const root = findDshRoot();
if (root === undefined) {
  console.log("skip - 未找到 DSH 安装目录（可设置 DSH_NPX_ROOT 指向 node_modules）");
  process.exit(0);
}

const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const { Context } = await load("@deepseek-ai/cordis/lib/index.js");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local/lib/index.js");
const policy = await load("@deepseek-ai/dsh-fs-observation-policy/lib/index.js");

const guard = { name: "fs-ctime-guard", inject: ["fs"], apply };

async function setup(withGuard) {
  const dir = mkdtempSync(join(homedir(), ".dsh-ctime-guard-test-"));
  const file = join(dir, "a.txt");
  writeFileSync(file, "alpha\n");
  const ctx = new Context();
  await ctx.plugin(LocalFileSystem, { cwd: dir });
  await ctx.plugin(policy);
  if (withGuard) await ctx.plugin(guard);
  const target = await ctx.fs.resolve(file, { cwd: dir });
  const actor = { agent: { session: {} } };
  const observe = async () => {
    const info = await ctx.fs.stat(target);
    ctx.emit("fs/observed", target, { kind: "present", version: info.version }, actor);
  };
  const edit = async (from, to) => {
    const intent = await ctx.waterfall("fs/edit-intent", target, actor, () => undefined);
    return ctx.fs.editText(target, { oldString: from, newString: to, replaceAll: false }, intent, undefined);
  };
  const write = async (content) => {
    const intent = await ctx.waterfall("fs/write-intent", target, actor, () => undefined);
    return ctx.fs.writeText(target, content, intent, undefined);
  };
  const cleanup = async () => {
    await ctx.fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { file, ctx, target, actor, observe, edit, write, cleanup };
}

const chmodOnly = (file) => {
  // 只改权限位：内容、mtime、inode 都不变，只有 ctime 变，模拟 macOS 打 macl 的行为
  execFileSync("chmod", ["640", file]);
  execFileSync("chmod", ["644", file]);
};

let passed = 0;
const run = async (title, fn) => {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${title}`);
};

await run("修复前：chmod 只改 ctime 时 edit 误报 FS_STALE_VERSION", async () => {
  const s = await setup(false);
  try {
    await s.observe();
    chmodOnly(s.file);
    await assert.rejects(s.edit("alpha", "BETA"), (error) => error.code === "FS_STALE_VERSION");
  } finally {
    await s.cleanup();
  }
});

await run("修复后：chmod 只改 ctime 时 edit 正常通过", async () => {
  const s = await setup(true);
  try {
    await s.observe();
    chmodOnly(s.file);
    await s.edit("alpha", "BETA");
    assert.equal(readFileSync(s.file, "utf8").trim(), "BETA");
  } finally {
    await s.cleanup();
  }
});

await run("修复后：内容真的变了仍然报 FS_STALE_VERSION", async () => {
  const s = await setup(true);
  try {
    await s.observe();
    writeFileSync(s.file, "alpha\nmore\n");
    await assert.rejects(s.edit("alpha", "BETA"), (error) => error.code === "FS_STALE_VERSION");
  } finally {
    await s.cleanup();
  }
});

await run("修复后：write 覆盖也忽略 ctime 噪声", async () => {
  const s = await setup(true);
  try {
    await s.observe();
    chmodOnly(s.file);
    await s.write("rewritten\n");
    assert.equal(readFileSync(s.file, "utf8"), "rewritten\n");
  } finally {
    await s.cleanup();
  }
});

await run("修复后：write 遇到真实修改仍然拒绝", async () => {
  const s = await setup(true);
  try {
    await s.observe();
    writeFileSync(s.file, "changed\n");
    await assert.rejects(s.write("rewritten\n"), (error) => error.code === "FS_STALE_VERSION");
  } finally {
    await s.cleanup();
  }
});

await run("已知弱化：同尺寸原地改写 + 精确恢复 mtime 会被放行", async () => {
  // 这是“忽略 ctime”显式接受的风险（与上游 #3111 方案 1 一致），不是回归；
  // 用 cp -p + touch -r 把 mtime 恢复到纳秒级，构造非 ctime 字段完全相同的并发修改。
  const s = await setup(true);
  const backup = `${s.file}.bak`;
  try {
    await s.observe();
    execFileSync("cp", ["-p", s.file, backup]);
    writeFileSync(s.file, "ALPHA\n"); // 与 "alpha\n" 同为 6 字节，inode 不变
    execFileSync("touch", ["-r", backup, s.file]);
    await s.edit("ALPHA", "OMEGA");
    assert.equal(readFileSync(s.file, "utf8").trim(), "OMEGA");
  } finally {
    await s.cleanup();
  }
});

await run("注册顺序：后注册的另一个 prepend 监听不影响对齐", async () => {
  const s = await setup(true);
  try {
    // 模拟 dsh-workspace-changes：它也 prepend 且调用 next()，晚于本插件注册时成为最外层
    s.ctx.on(
      "fs/edit-intent",
      async (_target, _actor, next) => {
        const intent = await next();
        return intent;
      },
      { prepend: true },
    );
    await s.observe();
    chmodOnly(s.file);
    await s.edit("alpha", "BETA");
    assert.equal(readFileSync(s.file, "utf8").trim(), "BETA");
  } finally {
    await s.cleanup();
  }
});

console.log(`\n${passed} integration tests passed (DSH root: ${root})`);
