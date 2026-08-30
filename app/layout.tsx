import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '内容情报台',
  description: '本机运行的多平台监控账号视频采集与总数据分析工具',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
