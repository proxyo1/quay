import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SuiProviders } from "@/components/SuiProviders";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export const metadata: Metadata = {
  title: "suiqr — SGQR payments on Sui",
  description: "Scan any SGQR sticker, pay any Sui token, settle on-chain.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "suiqr", statusBarStyle: "black-translucent" },
  icons: {
    icon: "/icon-192.svg",
    apple: "/icon-192.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SuiProviders>{children}</SuiProviders>
      </body>
    </html>
  );
}
