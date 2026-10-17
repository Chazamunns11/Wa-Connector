import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { brandConfig } from "@/lib/brand-config";
import "./globals.css";

// Headings: Bricolage Grotesque, the logo's own face, at the two weights the
// wordmark uses (500 and 800). Body: Instrument Sans, a plain, slightly
// humanist sans that stays quiet next to Bricolage's quirks.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  weight: ["500", "800"],
});

const instrumentSans = Instrument_Sans({
  variable: "--font-body-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: name,
    description: `${name} — WhatsApp for GoHighLevel.`,
    // Icons come from the file convention: src/app/favicon.ico, icon.svg and
    // apple-icon.png (copies of the kit's favicon.ico / favicon.svg / favicon-180.png).
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en-GB"
      className={`${instrumentSans.variable} ${jetbrainsMono.variable} ${bricolage.variable} h-full`}
    >
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
