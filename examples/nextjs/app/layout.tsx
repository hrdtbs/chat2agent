export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: "system-ui", padding: "2rem" }}>{children}</body>
    </html>
  );
}
