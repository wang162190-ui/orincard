import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/source-serif-4/wght.css";
import "@fontsource/noto-sans-sc/400.css";
import type { ReactNode } from "react";
import { publicMetadata } from "../server/metadata";
import "../styles/tokens.css";
import "../components/ui.css";

export const metadata = {
  ...publicMetadata({ title: "Orincard — Create Social Carousels with AI", description: "Turn a topic, text, URL, video, PDF, or slides into editable LinkedIn, Instagram, and TikTok carousels. Design, brand, caption, and export in one workspace." }),
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23141310' d='M2 9 6 5l5 6L22 3l-5 10 6 3-8 1-8 4 2-7z'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
