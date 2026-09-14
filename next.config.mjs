import createNextIntlPlugin from "next-intl/plugin";

/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  // 验证性构建用 NEXT_DIST_DIR 换一个产物目录，免得覆盖正在被 `next start` 服务的 .next。
  // 不设时行为与以前完全一致（.next），CI 与生产都不受影响。
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

// 默认读 ./src/i18n/request.ts。这个插件只负责把请求级的翻译配置接进构建，
// 路由前缀由 src/i18n/routing.ts 与 src/proxy.ts 决定。
export default createNextIntlPlugin()(nextConfig);
