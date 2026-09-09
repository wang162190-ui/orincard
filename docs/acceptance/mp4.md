# T055 MP4 与授权音轨验收

状态：`LOCAL_REAL_ARTIFACT_PASS — 云端持久导出待共享 migration 放开 mp4`

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

## 云端门槛

Trigger 配置已安装 Debian `ffmpeg`，工作任务只从私有 Storage 下载同 owner、`ready`、`kind=audio` 且 `rights.exportAuthorized=true` 或有 `licenseConfirmedAt` 的音频素材。任何其他素材、mime 或 Storage 下载失败会报 `AUDIO_NOT_EXPORTABLE`。

当前开发数据库的 `server_create_exports` 仍只接受 `png_zip`、`jpg_zip`、`pdf`。共享 migration 在将 RPC 的受控格式扩展到 `mp4` 之前，真实 Trigger 持久 MP4 任务无法创建；这不是本地渲染通过的替代品。迁移部署后需以开发项目提交一份无音轨和一份授权音轨 MP4，并用同一 `ffprobe` 检查重新记录云端结果。
