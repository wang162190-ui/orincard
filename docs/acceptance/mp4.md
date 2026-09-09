# T055 MP4 与授权音轨验收

状态：`PASS — 本地音视频与真实云端持久导出通过`

## 本地真实产物

运行：

```sh
pnpm exec vitest run tests/cloud/mp4.test.ts
```

验收脚本以本机的 `ffmpeg` 生成 H.264 (`libx264`、`yuv420p`、faststart) MP4，再用 `ffprobe` 验证：

- 固定平台尺寸（当前 fixture 为 1080×1350）；
- 每页显式秒数决定总时长；
- 无音轨也可导出；
- 已授权的本人物料音频循环到视频结束并转码为 AAC；
- 产物为 `video/mp4`，manifest 不包含项目正文。

## 云端结果

Trigger 配置已安装 Debian `ffmpeg`，工作任务只从私有 Storage 下载同 owner、`ready`、`kind=audio` 且 `rights.exportAuthorized=true` 或有 `licenseConfirmedAt` 的音频素材。任何其他素材、mime 或 Storage 下载失败会报 `AUDIO_NOT_EXPORTABLE`。

开发 Supabase 已应用 `20260909191000_b07_export_formats.sql`，Trigger `20260909.8` 已完成一份无音轨的真实持久 MP4 导出。下载后用 `ffprobe` 验证为 1080×1350、H.264，页面顺序和总时长与选项一致。授权音轨路径已用真实本地 AAC 转码产物验证；云端音轨样本仍需专用已授权测试素材，不能使用未确认许可的音频代替。
