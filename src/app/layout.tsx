import type { Metadata } from "next";
import { Barlow, JetBrains_Mono, Chakra_Petch } from "next/font/google";
import { brandConfig } from "@/lib/brand-config";
import "./globals.css";

const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const chakraPetch = Chakra_Petch({
  variable: "--font-chakra-petch",
  subsets: ["latin"],
  weight: ["700"],
  style: ["normal", "italic"],
});

export function generateMetadata(): Metadata {
  const { name } = brandConfig();
  return {
    title: name,
    description: `${name} — WhatsApp for GoHighLevel.`,
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
      className={`${barlow.variable} ${jetbrainsMono.variable} ${chakraPetch.variable} h-full`}
    >
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
