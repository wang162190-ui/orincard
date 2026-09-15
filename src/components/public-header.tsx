import { useTranslations } from "next-intl";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Link } from "@/i18n/navigation";

// The marketing home and the pricing page each used to carry their own copy of this
// markup, and they had already drifted: pricing lost the Plans and Log in links and
// its nav could not wrap, so the language switcher spilled out of the 72px header.
// One component means that cannot happen again.

export function PublicHeader() {
  const nav = useTranslations("Nav");
  return (
    <header className="container row-between wrap" style={{ minHeight: 72, paddingBlock: 12 }}>
      <Link href="/" aria-label={nav("home")} style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 650 }}>Orincard</Link>
      <nav className="row wrap" aria-label={nav("public")}>
        <Link className="btn btn-ghost" href="/tools">{nav("tools")}</Link>
        <Link className="btn btn-ghost" href="/pricing">{nav("plans")}</Link>
        <Link className="btn btn-ghost" href="/login">{nav("login")}</Link>
        <Link className="btn btn-primary" href="/create">{nav("createCarousel")}</Link>
      </nav>
    </header>
  );
}

export function PublicFooter() {
  const nav = useTranslations("Nav");
  return (
    <footer className="container row-between wrap" style={{ paddingBlock: 32 }}>
      <span className="meta">{nav("copyright")}</span>
      <nav className="row wrap" aria-label={nav("footer")}>
        <Link href="/pricing">{nav("plans")}</Link>
        <Link href="/tools">{nav("tools")}</Link>
        <Link href="/blog">{nav("blog")}</Link>
        <Link href="/help/getting-started">{nav("help")}</Link>
        <Link href="/login">{nav("login")}</Link>
        <LanguageSwitcher />
      </nav>
    </footer>
  );
}
