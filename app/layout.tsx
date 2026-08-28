import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '抖音对标监控',
  description: '本机运行的抖音对标账号视频与数据快照工作台',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
