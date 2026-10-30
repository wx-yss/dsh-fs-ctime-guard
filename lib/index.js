// 让 DSH 的文件版本守卫忽略“只改了 ctime”的元数据噪声。
//
// 背景：DSH 的 fs-local 用 `dev:ino:size:mtimeNs:ctimeNs` 作为文件版本（CAS token），
// 但 macOS 会在写入后由 Spotlight（mds）访问、TCC/sandbox 给文件打 `com.apple.macl`
// 等扩展属性，这类操作只刷新 ctime，内容、mtime、inode 都不变。于是“写入后立刻记录”
// 的版本 token 很快就对不上，下一次 edit/write 误报：
//   cannot edit "...": file changed since it was read
//
// 本插件挂在 DSH 的 fs intent 瀑布上（prepend，先于 fs-observation-policy 的判定），
// 拿到守卫原判后自己再 stat 一次当前文件：
//   - 版本只有 ctime 段不同 → 用当前版本覆盖守卫版本，放行；
//   - mtime/size/inode/设备任一不同、文件缺失、版本格式不匹配 → 原样返回，
//     继续由 DSH 报 FS_STALE_VERSION。
//
// 注意这是“有条件的弱化”，不是无损修复：放行依据是“除 ctime 外四个字段相同”，
// 它不能证明内容没变（同尺寸 + 精确恢复 mtime 的原地修改可以绕过），也不能保证
// 权限/ACL/xattr 语义未变。详见 README 的“边界”。

/** fs-local 的版本协议：五段十进制整数 `dev:ino:size:mtimeNs:ctimeNs`。 */
const PRESENT_VERSION_PATTERN = /^\d+:\d+:\d+:\d+:\d+$/;

/**
 * 判断版本串是不是已知的 fs-local 版本协议。
 *
 * 只认严格的五段十进制格式：`::::`、`a:b:c:d:e`、`missing:<key>` 这类
 * 非本协议的 token 一律返回 false，交回 DSH 原判定。
 *
 * @param {unknown} version
 * @returns {version is string}
 */
function isPresentVersion(version) {
  return typeof version === "string" && PRESENT_VERSION_PATTERN.test(version);
}

/** 去掉版本串最后一段（ctimeNs），得到只含身份/内容元数据的稳定前缀。 */
function versionWithoutCtime(version) {
  const index = version.lastIndexOf(":");
  return index < 0 ? version : version.slice(0, index);
}

/**
 * 计算“只差 ctime”时应对齐到的版本。
 *
 * @param {unknown} observed 守卫记录的观察版本
 * @param {unknown} current 当前磁盘版本
 * @returns {string | undefined} 只有 ctime 不同时返回 `current`，否则 `undefined`
 */
export function alignCtimeOnlyVersion(observed, current) {
  if (!isPresentVersion(observed) || !isPresentVersion(current)) return undefined;
  if (observed === current) return undefined;
  if (versionWithoutCtime(observed) !== versionWithoutCtime(current)) return undefined;
  return current;
}

/** Cordis 插件名，用于 loader 诊断。 */
export const name = "fs-ctime-guard";

/** 依赖 fs 服务：intent 处理器里要自己 stat 当前文件。 */
export const inject = ["fs"];

/**
 * 注册两个 intent 监听。
 *
 * 用 `{ prepend: true }` 保证自己排在 fs-observation-policy 之前：先 `await next()`
 * 拿到守卫的原始判定，再决定是否把版本对齐到“只差 ctime”的当前值。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
  const currentVersion = async (target, actor) => {
    try {
      const info = await ctx.fs.stat(target, actor?.signal);
      return info?.version;
    } catch (error) {
      // 取消要如实传播；其余失败（文件不存在时 stat 返回 undefined、权限错误等）
      // 不放宽，交回 DSH 原生判定，不把异常伪装成一次成功的对齐。
      if (error?.name === "AbortError" || error?.code === "FS_ABORTED") throw error;
      return undefined;
    }
  };

  const align = (intent, current) => {
    if (current === undefined) return intent;
    const version = alignCtimeOnlyVersion(intent.version, current);
    return version === undefined ? intent : { ...intent, version };
  };

  // edit：policy 的 intent 形如 { version }
  ctx.on(
    "fs/edit-intent",
    async (target, actor, next) => {
      const intent = await next();
      if (intent === undefined) return intent;
      return align(intent, await currentVersion(target, actor));
    },
    { prepend: true },
  );

  // write：只有“覆盖已存在文件”这一支带版本；createIfAbsent 没有版本可比。
  ctx.on(
    "fs/write-intent",
    async (target, actor, next) => {
      const intent = await next();
      if (intent === undefined || intent.kind !== "replaceIfVersion") return intent;
      return align(intent, await currentVersion(target, actor));
    },
    { prepend: true },
  );
}
