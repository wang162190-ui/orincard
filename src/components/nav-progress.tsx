"use client";

import { useEffect, useState } from "react";
import { usePathname } from "@/i18n/navigation";

/**
 * 切页时顶部那条 2px 的进度条。
 *
 * 为什么需要：RSC 导航是阻塞的——点下去之后旧页面留在原地，等服务端把新段回来才整体替换。
 * 本地实测这段空档约 200ms，期间屏幕上没有任何东西动，点击像是没生效。这条进度条补的就是
 * 这段反馈，代价是不动现有版面、也不像骨架屏那样先把旧内容清掉再闪一下。
 *
 * 为什么用全局 click 监听而不是 `useLinkStatus()`：后者只在单个 `<Link>` 的子树里可用，
 * 做不到「站内任何链接都触发同一条进度条」。这里要覆盖的不只是侧边栏，还有模板卡片这类
 * 页面内部的跳转。
 *
 * 收尾靠 `usePathname()` 变化，所以浏览器前进后退（popstate）也能正常收掉，不用另接事件。
 */
export function NavProgress() {
  const pathname = usePathname();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");

  useEffect(() => {
    function onClick(event: MouseEvent) {
      // 有修饰键 / 中键 = 用户要开新标签页，当前文档不会导航。
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      if (anchor.origin !== window.location.origin) return;
      // 锚点跳转和「点当前页」都不会换页面，亮一条永远收不掉的进度条比不亮更糟。
      if (anchor.pathname === window.location.pathname) return;

      setState("loading");
    }

    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  useEffect(() => {
    // 路径变了 = 新页面已经挂上来了。冲到 100% 再淡出，别在半路上突然消失。
    setState((previous) => (previous === "loading" ? "done" : previous));
  }, [pathname]);

  useEffect(() => {
    if (state !== "done") return;
    const timer = window.setTimeout(() => setState("idle"), 320);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === "idle") return null;
  return <div className="nav-progress" data-state={state} aria-hidden="true" />;
}
