import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Merkl | Private Perpetuals",
  description: "Private perpetuals trading with proof-backed settlement.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={instrumentSans.variable}>
      <body>{children}</body>
    </html>
  );
}
