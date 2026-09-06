import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppBootstrap } from '@/components/AppBootstrap';
import { BottomNav } from '@/components/BottomNav';

export const metadata: Metadata = {
  title: 'Medicamentos',
  description: 'Lembretes e registro de medicamentos',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Medicamentos' },
  icons: { apple: '/icons/apple-touch-icon.png' }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#020617' }
  ]
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head><link rel="apple-touch-startup-image" href="/splash.png" /></head>
      <body>
        <AppBootstrap />
        <main className="app-shell">{children}</main>
        <BottomNav />
      </body>
    </html>
  );
}
