-- 编辑器助手（AC-012）第一步：只加枚举值，别的什么都不做。
--
-- PostgreSQL 不允许在同一个事务里 `alter type ... add value` 之后再**使用**该值，
-- 而下一份迁移里的 server_begin_copilot_turn 要把 'copilot' 传给
-- private.b04_begin_ai_candidate_job 的 p_kind。所以这两件事必须分成两个文件，
-- 合并回一份会在推送时炸在 "unsafe use of new value of enum type"。
--
-- 20260915000000_agent_orchestrator.sql 能把 'agent' 与建表放在一份里，是因为那份
-- 文件里从头到尾没有出现过 'agent' 字面量（它刻意没加 kind 检查约束）。这里做不到。

alter type public.job_kind add value if not exists 'copilot';
