import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '内容情报台',
  description: '本机运行的多平台对标账号视频监控与总数据分析工具',
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
