import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "PNLX | Private Perpetuals",
  description: "Private perpetuals trading with proof-backed settlement.",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.theme=localStorage.getItem('pnlx-theme')==='light'?'light':'dark'}catch{document.documentElement.dataset.theme='dark'}" }} />
        {children}
      </body>
    </html>
  );
}
