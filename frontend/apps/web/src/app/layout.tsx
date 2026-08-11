import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ServiceWorkerRegistration } from '../components/service-worker-registration';

export const metadata: Metadata = {
  title: 'Omni Commerce',
  description: 'Nền tảng thương mại hợp nhất cho đội vận hành Việt Nam.',
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body
        style={{
          margin: 0,
          background: '#f8fafc',
          color: '#0f172a',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  );
}
