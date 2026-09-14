import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// locale 感知的导航原语。页面里一律用这里的 Link / redirect / useRouter，
// 不要直接用 next/link——后者不会带上当前语言前缀，中文站点一点就掉回英文。
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
