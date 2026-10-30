# DSH FS ctime Guard

让 DSH 的文件版本守卫忽略“只改了 ctime”的元数据噪声，修掉 macOS 上频发的：

```
cannot edit "...": file changed since it was read — re-read the file, then retry
```

## 问题

DSH 的 `fs-local` 用 `dev:ino:size:mtimeNs:ctimeNs` 作为文件版本（CAS token）。在本次实测的 macOS 26.6.2 + `~/Documents` 环境下：文件写入后 0–2 秒内，Spotlight（`mds`）会访问文件，内核/TCC 会写入 `com.apple.macl`、`com.apple.provenance` 等扩展属性；观测到这些操作**只刷新 ctime**，内容、mtime、inode 都不变（`mds` 访问与 ctime 跳变同刻，3/3 次、约 20ms 内）。

于是“写入后立刻记录”的版本 token 很快对不上，下一次 `edit`/`write` 就误报 `FS_STALE_VERSION`，模型被迫 read 一遍再重试。更麻烦的是它看起来像“每次写完都必须重读”，很容易被误判成工具的用法限制。

DSH 上游已有同款讨论：[#3111 版本 token 包含 ctime 导致元数据未变、内容未变时误报 FS_STALE_VERSION](https://github.com/deepseek-ai/deepseek-harness/discussions/3111)。

## 做法

本插件挂在 DSH 的两个文件 intent 瀑布最外层（`prepend`，先于 `fs-observation-policy` 的判定）：

1. 先 `await next()` 拿到 DSH 原有守卫的判定；
2. 自己 `stat` 一次当前文件；
3. **只有 ctime 段不同** → 用当前版本覆盖守卫版本，放行；
4. 其余情况（mtime/size/inode/设备变化、文件不存在、版本格式不符合协议、stat 失败、取消）→ 原样返回，交回 DSH 原有判定（多数情况报 `FS_STALE_VERSION`，未观察/非普通文件/权限/取消另有错误路径）。

覆盖 `fs/edit-intent` 和 `fs/write-intent`，因此 `edit`、`write`、`str_replace_editor` 都生效。

```
      edit/write 工具
             │
   fs/edit-intent 瀑布
     ├─ fs-ctime-guard（prepend）  ← 本插件，只放宽 ctime
     ├─ fs-observation-policy      ← DSH 原有守卫
     └─ fallback
```

## 安装

本地 link 安装（当前开发者用法）：

```sh
cd ~/.dsh/profiles/web
pnpm add link:/Users/yss/Documents/project/remote/dsh-fs-ctime-guard
```

然后把 `dsh-fs-ctime-guard` 加到 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 末尾，重启 DSH：

```sh
ds
```

发布到 npm 后可以简化为：

```sh
dsh plugin --profile web add dsh-fs-ctime-guard
```

（仍需把包名加入 `dsh.profile.bundles`，DSH 由 bundles 顺序组装配置树。）

## 验证

```sh
npm test                   # 16 个单元测试（自带最小 cordis 替身，无外部依赖）
npm run test:integration   # 真实 cordis + dsh-fs-local + fs-observation-policy
```

集成测试覆盖：

- 修复前：`chmod` 只改 ctime 时 `edit` 报 `FS_STALE_VERSION`
- 修复后：同样场景 `edit` 正常通过
- 修复后：内容真的变了仍然报 `FS_STALE_VERSION`
- 修复后：`write` 覆盖忽略 ctime 噪声，真实修改仍被拒绝
- 已知弱化：同尺寸原地改写 + 精确恢复 mtime 会被放行（固定为显式行为）
- 注册顺序：后注册的另一个 `prepend` 监听不影响对齐

集成测试默认从 `~/.npm/_npx` 自动发现 DSH 安装目录，也可用 `DSH_NPX_ROOT` 指定 `node_modules` 路径；找不到时跳过（退出码 0），因此不适合当发布门禁。

## 边界与已知弱化

这不是“无损修复”，而是**有条件的冲突检测弱化**，使用前请明确接受：

- **ctime 相同不等于内容相同。** 放行依据只是“除 ctime 外四个字段相同”。如果另一个进程原地写入**同尺寸**内容、再用 `utimes` 把 mtime 精确恢复（纳秒级），token 只差 ctime，本插件会放行——`edit` 可能改到与模型读到的不一致的内容，`write` 可能整文件覆盖别人的更新。这是与上游 [#3111](https://github.com/deepseek-ai/deepseek-harness/discussions/3111) 方案 1 相同的取舍，测试 `已知弱化` 用例把它固定为显式行为，不是 bug 回归。
- **只保证“内容冲突检测变弱”，不保证文件状态语义。** `chmod`、ACL、属主、有语义的 xattr（如可执行位）变化同样只刷新 ctime，本插件会放行；DSH 原生写入只保留普通 mode 位，这些语义本来也不在保护范围内。
- **DSH 的写入不是跨进程原子 CAS。** `fs-local` 的锁只约束同一 provider 实例；`probe → 读文件 → 写临时文件 → rename` 之间没有发布前复核。外部修改若恰好落在该窗口，原版 DSH 也可能覆盖它，这不是本插件引入的，但本插件也不能消除。
- **intent 判定与 provider 复核之间仍有窗口**：ctime 若恰好在两次 stat 之间再次变化，仍可能报一次 `FS_STALE_VERSION`，重新 read 即可。
- **注册顺序不是硬保证。** `prepend` 的语义是“后注册者更外层”；本插件依赖 `fs-observation-policy` 不调用 `next()` 且普通注册。与同样 `prepend` 的 `dsh-workspace-changes` 在两种顺序下都测过可组合，但 HMR/重载后仍建议回归。
- **归因限于本机观测**：`fs_usage` 显示 ctime 跳变与 Spotlight `mds` 访问同刻（3/3 次，约 20ms 内），这支持“mds 访问触发元数据写入”的推断，但不足以证明所有 ctime 跳变都由同一条链引起；对修误报而言也不需要先证明完整责任链。
- 不修改 DSH 安装目录，升级 DSH 不会丢；上游修复（#3111 方案 1）落地后可以直接卸载本插件。
- 当前选择（2026-10-31 确认）：默认同时放宽 `edit` 与 `write`。触发上面 ⚠️ 场景需要“同尺寸 + 精确恢复 mtime”或纯权限类变化，日常编辑器/`git`/`cp`/其它 agent 会话都会改 size/mtime/inode，仍会被拦；若日后想收严，只需不再注册 `fs/write-intent`，`edit` 放宽保持不变。
- 依赖 DSH 的 `fs/edit-intent`、`fs/write-intent` 瀑布与版本串格式 `dev:ino:size:mtimeNs:ctimeNs`；格式变化或换用其他 fs provider 时本插件会保守退回（只认严格五段十进制协议）。

## 参考

- [The MACL extended attribute — Eclectic Light](https://eclecticlight.co/2026/04/21/the-macl-extended-attribute/)
- [macOS 上 com.apple.macl 导致 Office 保存延迟（Microsoft Q&A）](https://learn.microsoft.com/en-us/answers/questions/5617143/why-is-there-severe-save-latency-in-microsoft-offi)

## License

MIT
