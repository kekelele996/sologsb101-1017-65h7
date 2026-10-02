/**
 * 数据访问门面
 *
 * 持久化实现已按角色拆分到 src/db/roleDb.ts（吹制库 gbglassblow-craft / 排产库 gbglassblow-schedule），
 * 本文件仅做统一再导出，保持 `@/utils/db` 引用路径稳定。两侧各持自己的库、按归属写入，
 * 保存失败按本侧重试，旧版单库 gbglassblow 仅用于一次性迁移（详见 db/roleDb.ts 头注释）。
 */
export * from '../db/roleDb'
