import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import RegisterSW from '@/components/RegisterSW';

// PWA identity is declared once here so BOTH the landing page (/) and the app (/app …) are installable.
export const metadata: Metadata = {
  title: 'ScanPay',
  description: 'Scan. Verify. Pay. Know it arrived.',
  applicationName: 'ScanPay',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'ScanPay', statusBarStyle: 'default', startupImage: '/apple-touch-icon.png' },
  icons: { apple: '/apple-touch-icon.png' },
  other: { 'mobile-web-app-capable': 'yes' },
};

export const viewport: Viewport = {
  themeColor: '#f1efe2',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The Webflow runtime adds classes to <html> (w-mod-js, wf-active, lenis...), so hydration warnings are expected.
    // Webflow's data-wf-domain is left out on purpose: off that hostname it makes webflow.js append a badge.
    <html
      data-wf-page="6a901794a3ca5e0a74527ddb"
      data-wf-site="6a901794a3ca5e0a74527dde"
      lang="en"
      suppressHydrationWarning
    >
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
