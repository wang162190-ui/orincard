import Link from "next/link";

const features = [
  ["Six ways in", "Start with a topic, text, URL, video, PDF, or slide deck."],
  ["Edit every card", "Refine the copy, layout, imagery, colors, and type before export."],
  ["Keep your work", "Save versions, reuse a Brand Kit, and restore portable project packages."],
] as const;

export function MarketingHome() {
  return <>
    <header className="container row-between" style={{ minHeight: 72 }}>
      <Link href="/" aria-label="Orincard home" style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 650 }}>Orincard</Link>
      <nav className="row wrap" aria-label="Public navigation"><Link className="btn btn-ghost" href="/tools">Tools</Link><Link className="btn btn-ghost" href="/pricing">Plans</Link><Link className="btn btn-ghost" href="/login">Log in</Link><Link className="btn btn-primary" href="/create">Create a carousel</Link></nav>
    </header>
    <main>
      <section className="container" style={{ paddingBlock: "clamp(64px, 10vw, 128px)" }}><div style={{ maxWidth: 830 }}><p className="eyebrow">From source to social story</p><h1>Turn what you know into a carousel worth saving.</h1><p className="lead" style={{ marginTop: 24 }}>Orincard helps you shape research, recordings, and rough ideas into editable visual stories for LinkedIn, Instagram, and TikTok.</p><div className="row wrap" style={{ marginTop: 28 }}><Link className="btn btn-primary" href="/create">Create your first carousel</Link><Link className="btn btn-secondary" href="/tools">Explore free tools</Link></div><p className="meta" style={{ marginTop: 14 }}>Open the creator without an account. Review every card before export.</p></div></section>
      <section aria-labelledby="workflow-title" style={{ background: "var(--fg)", color: "var(--on-ink)", paddingBlock: "var(--gap-xl)" }}><div className="container"><p className="eyebrow" style={{ color: "var(--on-ink-dim)" }}>A clearer workflow</p><h2 id="workflow-title" style={{ maxWidth: 650 }}>The speed of generation, with room for your judgment.</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 1, marginTop: 36, background: "var(--on-ink-soft)" }}>{features.map(([title, body], index) => <article key={title} style={{ minHeight: 210, padding: 24, background: "var(--fg)" }}><p className="meta" style={{ color: "var(--sig-yellow)" }}>0{index + 1}</p><h3 style={{ marginTop: 36 }}>{title}</h3><p style={{ color: "var(--on-ink-dim)" }}>{body}</p></article>)}</div></div></section>
      <section className="container grid-2" style={{ paddingBlock: "var(--gap-2xl)", alignItems: "center" }}><div><p className="eyebrow">One idea, three formats</p><h2>Compose for the feed you are publishing to.</h2><p className="lead" style={{ marginTop: 18 }}>Choose a LinkedIn, Instagram, or TikTok preset. Orincard keeps the document editable and checks the export before it leaves your workspace.</p></div><div aria-label="Example carousel cards" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, minHeight: 300 }}>{["A useful idea", "Made visual", "Ready to refine"].map((label, index) => <div key={label} style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 18, border: "1px solid var(--fg)", borderRadius: "var(--radius)", background: ["var(--sig-yellow)", "var(--sig-pink)", "var(--sig-blue)"][index], transform: `translateY(${index * 18}px)` }}><span className="meta">0{index + 1}</span><strong style={{ fontFamily: "var(--font-display)", fontSize: 21, lineHeight: 1.1 }}>{label}</strong></div>)}</div></section>
      <section style={{ background: "var(--sig-yellow)", paddingBlock: "var(--gap-xl)" }}><div className="container row-between wrap"><div><p className="eyebrow">Paid plans are being prepared</p><h2>Want to hear when they open?</h2></div><Link className="btn btn-primary" href="/pricing#waitlist">Join the waitlist</Link></div></section>
    </main>
    <footer className="container row-between wrap" style={{ paddingBlock: 32 }}><span className="meta">© Orincard</span><nav className="row" aria-label="Footer navigation"><Link href="/pricing">Plans</Link><Link href="/tools">Tools</Link><Link href="/login">Log in</Link></nav></footer>
  </>;
}
