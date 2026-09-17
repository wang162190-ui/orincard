"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { LanguageSwitcher } from "./language-switcher";

// Every route that renders inside the rail belongs to a section, so a detail page
// (editor, templates/[slug], tools/[tool]) still lights up its parent.
export type WorkspaceSection =
  | "workspace"
  | "create"
  | "projects"
  | "exports"
  | "brand-kits"
  | "templates"
  | "assets"
  | "tools"
  | "agent"
  | "billing"
  | "settings"
  | "affiliate"
  | "help";

/**
 * 路径 → 高亮哪一项。
 *
 * 这份归属关系原来是每个页面自己用 `current` prop 传的；rail 提到共享 layout 之后
 * layout 在同组内不再重渲染，服务端也就没机会重算，所以改成客户端按路径算——
 * 附带的好处是点下去当帧就高亮，不用等那 200ms。
 *
 * 映射逐条照抄搬迁前各页面传的值（包括 `/support` 归 help 这条看着别扭但确实如此的），
 * 由 tests/ui/shell.test.tsx 的映射表用例锁住。传进来的 pathname 是
 * `@/i18n/navigation` 的，已经剥掉 locale 前缀。
 */
export function sectionFromPathname(pathname: string): WorkspaceSection {
  // 尾斜杠归一，`/templates/` 和 `/templates` 是同一个地方。
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const segment = path.split("/")[1] ?? "";

  switch (segment) {
    case "":
      return "workspace";
    case "editor":
      // 编辑器没有独立的导航项，它从项目里进去，所以高亮留在「项目」。
      return "projects";
    case "help":
    case "guides":
    case "support":
      return "help";
    case "create":
    case "projects":
    case "exports":
    case "templates":
    case "assets":
    case "tools":
    case "agent":
    case "brand-kits":
    case "billing":
    case "settings":
    case "affiliate":
      return segment;
    default:
      // 组里不该出现别的段；真出现了就谁都不高亮，而不是乱点一个。
      return "workspace";
  }
}

function CraneMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polygon
        points="8.8,13.4 6.4,20.4 14.6,16.2"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <polygon
        points="11,11 16.6,12.8 14.6,16.2 8.8,13.4"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <polygon
        points="16.6,12.8 22.8,15.6 14.6,16.2"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <polygon
        points="11,11 21.2,3 16.6,12.8"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <polygon
        points="5.4,4.8 11,11 8.8,13.4 3.7,7.3"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <polygon
        points="1.8,8.6 5.4,4.8 3.7,7.3"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="10" rx="1.5" />
    </svg>
  );
}

function CreateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const PATHS = {
  projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  exports: "M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  brandKits: "M4 6h16M4 12h10M4 18h7m6-3 4 4-4 4",
  templates: "M4 5h7v6H4zm9 0h7v3h-7zM4 14h7v5H4zm9-3h7v8h-7z",
  tools: "M14.7 6.3a4 4 0 0 1 5.3 5.3l-8.4 8.4-5.3-5.3zM6 3l1.5 3L11 7.5 7.5 9 6 12l-1.5-3L1 7.5 4.5 6z",
  agent: "M12 3v3m-4.5 0h9A2.5 2.5 0 0 1 19 8.5v6A2.5 2.5 0 0 1 16.5 17h-9A2.5 2.5 0 0 1 5 14.5v-6A2.5 2.5 0 0 1 7.5 6zM9.5 10.5h.01m4.99 0h.01M9 13.5h6M8 21l1.5-4m6.5 4-1.5-4",
  billing: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0V21a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 5.6V5a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.6 1.3z",
} as const;

// `ariaKey` names the <nav> for screen readers; `headingKey` is the visible divider.
// The first group has no visible heading — its aria name stays "Main navigation",
// which tests/e2e/accessibility.spec.ts:75 and browsers.spec.ts:90 both locate by.
type NavGroup = {
  ariaKey: string;
  headingKey?: string;
  items: { id: WorkspaceSection; href: string; labelKey: string; icon: ReactNode }[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    ariaKey: "main",
    items: [
      // 「工作台」原来指向 `/`——那是营销首页，在 `(workspace)` 路由组之外，所以点它会把
      // 整个外壳连根换掉，正是这轮要消灭的那种整页重建。改指 `/projects` 之后它留在组内。
      //
      // 顺带删掉了原来第三项「项目」：两项都指 `/projects` 就成了导航里两个入口指一处，
      // 而且只有一个会高亮，看起来像 bug。留下的是这一项，`id` 用 `projects`，所以
      // `/projects` 和 `/editor/*` 照样把它点亮。首页入口没丢——左上角 logo 就是 `/`。
      { id: "projects", href: "/projects", labelKey: "workspace", icon: <WorkspaceIcon /> },
      { id: "create", href: "/create", labelKey: "newCarousel", icon: <CreateIcon /> },
      { id: "exports", href: "/exports", labelKey: "exports", icon: <Icon d={PATHS.exports} /> },
    ],
  },
  {
    ariaKey: "library",
    headingKey: "library",
    items: [
      { id: "templates", href: "/templates", labelKey: "templates", icon: <Icon d={PATHS.templates} /> },
      { id: "assets", href: "/assets", labelKey: "assets", icon: <Icon d="M4 5h16v14H4zM4 15l4-4 3 3 3-4 6 5" /> },
      { id: "tools", href: "/tools", labelKey: "tools", icon: <Icon d={PATHS.tools} /> },
      // 编排器和工具列表并排：它做的事就是「替你挑工具、排顺序」，放在工具旁边才说得通。
      { id: "agent", href: "/agent", labelKey: "agent", icon: <Icon d={PATHS.agent} /> },
      { id: "brand-kits", href: "/brand-kits", labelKey: "brandKits", icon: <Icon d={PATHS.brandKits} /> },
    ],
  },
  {
    ariaKey: "account",
    headingKey: "account",
    items: [
      { id: "billing", href: "/billing", labelKey: "billing", icon: <Icon d={PATHS.billing} /> },
      { id: "settings", href: "/settings", labelKey: "settings", icon: <Icon d={PATHS.settings} /> },
    ],
  },
];

export function WorkspaceRail() {
  const t = useTranslations("Nav");
  const current = sectionFromPathname(usePathname());
  return (
    <aside className="rail">
      <Link className="rail-brand" href="/" aria-label={t("home")}>
        <span className="mark">
          <CraneMark />
        </span>
        <span className="word">Orincard</span>
      </Link>

      <div className="rail-groups">
        {NAV_GROUPS.map((group) => (
          <nav className="rail-nav" aria-label={t(group.ariaKey)} key={group.ariaKey}>
            {group.headingKey ? <p className="rail-group-label">{t(group.headingKey)}</p> : null}
            {group.items.map((item) => (
              <Link
                className="nav-item"
                href={item.href}
                key={item.id}
                aria-label={t(item.labelKey)}
                aria-current={current === item.id ? "page" : undefined}
              >
                {item.icon}
                <span>{t(item.labelKey)}</span>
              </Link>
            ))}
          </nav>
        ))}
      </div>

      <div className="rail-foot">
        <nav className="rail-links" aria-label={t("support")}>
          <Link href="/help/getting-started" aria-current={current === "help" ? "page" : undefined}>{t("help")}</Link>
          <Link href="/support">{t("support")}</Link>
          <Link href="/affiliate" aria-current={current === "affiliate" ? "page" : undefined}>{t("affiliate")}</Link>
          <Link href="/pricing">{t("plans")}</Link>
        </nav>
        <div className="plan-card">
          <p className="label">{t("planLabel")}</p>
          <p className="meta">{t("planMeta")}</p>
        </div>
        <LanguageSwitcher />
      </div>
    </aside>
  );
}
