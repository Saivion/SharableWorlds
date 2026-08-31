import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SharableWorlds",
  description:
    "An open dotted canvas built by a human and a WebMCP agent together. The agent reads the map and fills empty lots; the human paints and locks their own.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
