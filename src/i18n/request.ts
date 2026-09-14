import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

// 服务端每次请求解析一次翻译。消息在服务端展开，不把整包语言文件塞进客户端 bundle——
// 本仓库绝大多数页面是 Server Component，这正是选 next-intl 而不是 react-i18next 的原因。
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  // 未知或缺失的 locale 一律回落到 en，而不是抛错：一个坏 URL 不该让页面 500。
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const messages = (await import(`../../messages/${locale}.json`)).default as Record<string, unknown>;
  return { locale, messages };
});
