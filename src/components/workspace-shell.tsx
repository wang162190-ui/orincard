import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { LanguageSwitcher } from "./language-switcher";

type WorkspaceShellProps = {
  children: ReactNode;
  current: "workspace" | "create";
  title: string;
};

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

export function WorkspaceShell({ children, current, title }: WorkspaceShellProps) {
  const t = useTranslations("Nav");
  return (
    <div className="app">
      <aside className="rail">
        <Link className="rail-brand" href="/" aria-label={t("home")}>
          <span className="mark">
            <CraneMark />
          </span>
          <span className="word">Orincard</span>
        </Link>

        <nav className="rail-nav" aria-label={t("main")}>
          <Link
            className="nav-item"
            href="/"
            aria-label={t("workspace")}
            aria-current={current === "workspace" ? "page" : undefined}
          >
            <WorkspaceIcon />
            <span>{t("workspace")}</span>
          </Link>
          <Link
            className="nav-item"
            href="/create"
            aria-label={t("newCarousel")}
            aria-current={current === "create" ? "page" : undefined}
          >
            <CreateIcon />
            <span>{t("newCarousel")}</span>
          </Link>
        </nav>

        <div className="rail-foot">
          <div className="plan-card">
            <p className="label">{t("planLabel")}</p>
            <p className="meta">{t("planMeta")}</p>
          </div>
          <LanguageSwitcher />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <strong>{title}</strong>
          </div>
        </header>
        <main className="work">{children}</main>
      </div>
    </div>
  );
}
