/**
 * 两侧本地库的归属约定与保存重试。
 *
 * 历史上吹制组与窑务排产员共用一个 IndexedDB，后保存的一方会用自己内存里的旧整行
 * 覆盖掉对方刚写入的字段。现按归属物理拆成两个库：
 *
 * - 吹制库（blowDb）：窑炉、料液批次、作品、吹制工序、出炉检验
 *   写归属：吹制组——作品的工序道次、温度、时长、操作人等只在这里落库。
 * - 排产库（kilnDb）：退火窑位编排
 *   写归属：窑务排产员——窑位、入窑时间、曲线段只在这里落库。
 *
 * 两侧对对方的库只做只读订阅（IndexedDB 同源跨库只读访问），任何一侧保存失败
 * 都只按本侧重试，另一侧已经确认的数据不受影响。
 */

/** 数据行结构修订号（两侧一致） */
export const ROW_REVISION = 3

/** 保存失败时的最大尝试次数（含首次） */
export const SAVE_MAX_ATTEMPTS = 3

/** 重试前等待（毫秒），指数退避：0 / 200 / 400 */
const RETRY_BASE_DELAY_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // 浏览器与 Node 冒烟环境兼容
    const timer = globalThis.setTimeout(resolve, ms)
    void timer
  })
}

/**
 * 错误是否值得重试：事务被中断、配额暂时不足、底层 I/O 异常等瞬时错误可重试；
 * 约束冲突等确定性错误（DataError / ConstraintError）重试也无意义。
 */
function isRetryableError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return true
  const name = (err as { name?: unknown }).name
  if (typeof name !== 'string') return true
  // DataCloneError / ConstraintError / DataError / SchemaError 属于确定性错误
  const fatal = ['DataCloneError', 'ConstraintError', 'DataError', 'SchemaError', 'VersionError']
  return !fatal.includes(name)
}

/**
 * 按本侧重试一次写库操作：仅重试传入的本侧动作，绝不触碰另一侧的库。
 * 超过 SAVE_MAX_ATTEMPTS 仍失败时抛出最后一次错误，由调用方提示「本侧保存失败，可重试」，
 * 另一侧已经确认保存的那份数据不会被回滚或覆盖。
 */
export async function withSideRetry<T>(action: () => Promise<T>, label = '保存'): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= SAVE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await action()
    } catch (err) {
      lastError = err
      if (attempt >= SAVE_MAX_ATTEMPTS || !isRetryableError(err)) break
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 2))
    }
  }
  if (lastError instanceof Error) {
    lastError.message = `${label}失败（已重试 ${SAVE_MAX_ATTEMPTS} 次，另一侧数据不受影响）：${lastError.message}`
    throw lastError
  }
  throw new Error(`${label}失败（已重试 ${SAVE_MAX_ATTEMPTS} 次，另一侧数据不受影响）`)
}
