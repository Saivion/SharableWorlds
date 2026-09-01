import type { Metadata } from "next";
import { Figtree } from "next/font/google";
import "./globals.css";

const figtree = Figtree({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
  variable: "--font-figtree",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SharableWorlds",
  description:
    "An open dotted canvas built by a human and a WebMCP agent together. The agent reads the map and fills empty lots; the human paints and locks their own.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={figtree.variable}>
      <body className={figtree.className}>{children}</body>
    </html>
  );
}
