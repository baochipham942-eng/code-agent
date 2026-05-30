import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Neo Admin Console",
  description: "Fleet observability and feedback console for Agent Neo.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
