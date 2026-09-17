import type { ReactNode } from "react";
import { NavProgress } from "@/components/nav-progress";
import { WorkspaceRail } from "@/components/workspace-rail";

/**
 * 工作区的公共外壳。
 *
 * `(workspace)` 是路由组，括号目录不进 URL——所有路径、middleware、e2e 里的地址全都不变，
 * 它只是让这 15 个段共用一个 layout。
 *
 * 这里是在修一个实测出来的问题：外壳原来写在每个页面内部，于是每次切页侧边栏连同 11 个
 * 导航项、1099 字符的内联 SVG 一起重新序列化并重建 DOM（探针测到 `railPreserved: false`），
 * 侧边栏自己的滚动位置也跟着归零。提到 layout 之后同组内切页它不再重渲染。
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <WorkspaceRail />
      <div className="main">
        <NavProgress />
        {children}
      </div>
    </div>
  );
}
