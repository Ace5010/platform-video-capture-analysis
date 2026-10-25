import type { Metadata } from 'next';
import './globals.css';
import { COLOR_THEME_INIT_SCRIPT } from '../lib/color-theme';

export const metadata: Metadata = {
  title: 'Observe · 内容情报台与微信读取',
  description: '本机运行的多平台监控账号视频采集与总数据分析工具',
  icons: {
    icon: [
      { url: '/app-icons/observe-coral.ico', type: 'image/x-icon' },
      { url: '/app-icons/observe-coral-96.png', type: 'image/png', sizes: '96x96' },
    ],
    apple: [{ url: '/app-icons/observe-coral-180.png', sizes: '180x180' }],
  },
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head><script id="color-theme-init" dangerouslySetInnerHTML={{ __html: COLOR_THEME_INIT_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}
