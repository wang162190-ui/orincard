-- 画幅扩充：public.platform_preset 补 'square'（1080×1080）与 'presentation'（1920×1080）。
--
-- 为什么需要这份迁移：在它之前发货的三种画幅里，linkedin 与 instagram 的尺寸**完全相同**
-- （都是 1080×1350，见 src/domain/document.ts 的 platformPresets），所以名义上 3 种、
-- 实际只有 2 种几何。最高频的 1:1 方形与 16:9 横屏一个都没有。
--
-- 尺寸的唯一真相在 TS 那一侧（platformPresets），数据库只认「这个平台名合法吗」，
-- 不存宽高——所以这里只动枚举，不加任何尺寸列。
--
-- 为什么单独一份迁移、而且只有这一条语句：PostgreSQL 不允许在同一个事务里
-- `alter type ... add value` 之后再**使用**该值。把它和任何会写入新画幅的语句放在一起
-- 会直接报错。这份迁移只加值，使用者是应用代码。
--
-- `if not exists` 让重复执行安全；枚举值只增不删，已有行不受影响。

alter type public.platform_preset add value if not exists 'square';
alter type public.platform_preset add value if not exists 'presentation';
