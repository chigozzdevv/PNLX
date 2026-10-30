import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";
import "./trade-workspace.css";
import "./mobile-shell.css";

const inter = localFont({
  src: "./fonts/InterVariable.woff2",
  display: "swap",
  variable: "--font-inter",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "PNLX | Private Perpetuals",
  description: "Private perpetuals trading with proof-backed settlement.",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html className={inter.variable} lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.theme=localStorage.getItem('pnlx-theme')==='light'?'light':'dark'}catch{document.documentElement.dataset.theme='dark'}" }} />
        {children}
      </body>
    </html>
  );
}
