# Orincard 字体清单

状态：B01 固定资源基线，2026-09-04。

Orincard 的预览与导出只装载 `src/render/font-manifest.json` 声明且通过 SHA-256 校验的字体文件。运行时不从 Google Fonts、操作系统字体目录或其他网络地址补取字体。

| 用途 | 字体资源 | npm 包与版本 | 固定文件 | SHA-256 | 许可 |
|---|---|---|---|---|---|
| 无衬线拉丁正文/界面 | Inter variable | `@fontsource-variable/inter@5.3.0` | `files/inter-latin-wght-normal.woff2` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` | SIL OFL 1.1 |
| 拉丁标题 | Source Serif 4 variable | `@fontsource-variable/source-serif-4@5.3.0` | `files/source-serif-4-latin-wght-normal.woff2` | `c1df4596be5029233ed2afbb8b2f6ea20784b3fb1aa5d6b5c6519ccd85eb3dfb` | SIL OFL 1.1 |
| 简体中文 fallback | Noto Sans SC 400 | `@fontsource/noto-sans-sc@5.3.0` | `files/noto-sans-sc-chinese-simplified-400-normal.woff2` | `95e3633b6a98f764ba3adfb54504a0cd4799328c009adf9081d6c1850f9c4c78` | SIL OFL 1.1 |

上游来源：

- [Inter on Fontsource](https://fontsource.org/fonts/inter)
- [Source Serif 4 on Fontsource](https://fontsource.org/fonts/source-serif-4)
- [Noto Sans SC on Fontsource](https://fontsource.org/fonts/noto-sans-sc)

每个 npm 包均携带 `LICENSE` 文件；构建产物若重新分发字体文件，必须同时保留对应许可文本。这里记录的是字体软件许可，不代表 Orincard 获得字体名称、作者或上游项目的商标背书。若未来进行字体裁剪、格式转换或制作衍生字体，必须重新进行 OFL 条件与 Reserved Font Name 审查。
