import Link from 'next/link';
import type { ReactNode } from 'react';

type LegalDocumentProps = {
  title: string;
  updatedAt: string;
  children: ReactNode;
};

export function LegalDocument({ title, updatedAt, children }: LegalDocumentProps) {
  return (
    <main
      style={{
        margin: '0 auto',
        maxWidth: 760,
        minHeight: '100vh',
        padding: '48px 24px 64px',
      }}
    >
      <p
        style={{
          color: '#2563eb',
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: '0.08em',
          margin: '0 0 12px',
          textTransform: 'uppercase',
        }}
      >
        Omni Commerce
      </p>
      <h1 style={{ fontSize: 36, lineHeight: 1.15, margin: '0 0 8px' }}>{title}</h1>
      <p style={{ color: '#64748b', fontSize: 14, margin: '0 0 32px' }}>
        Cập nhật lần cuối: {updatedAt}
      </p>
      <article
        style={{
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 16,
          boxShadow: '0 12px 32px rgba(15, 23, 42, 0.06)',
          color: '#334155',
          fontSize: 16,
          lineHeight: 1.7,
          padding: '32px 28px',
        }}
      >
        {children}
      </article>
      <footer
        style={{
          color: '#64748b',
          display: 'flex',
          flexWrap: 'wrap',
          fontSize: 14,
          gap: 16,
          marginTop: 28,
        }}
      >
        <Link href="/" style={{ color: '#2563eb', fontWeight: 700 }}>
          Trang chủ
        </Link>
        <Link href="/legal/terms" style={{ color: '#2563eb', fontWeight: 700 }}>
          Điều khoản
        </Link>
        <Link href="/legal/privacy" style={{ color: '#2563eb', fontWeight: 700 }}>
          Bảo mật
        </Link>
        <Link href="/login" style={{ color: '#2563eb', fontWeight: 700 }}>
          Đăng nhập
        </Link>
      </footer>
    </main>
  );
}

export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ color: '#0f172a', fontSize: 20, margin: '0 0 10px' }}>{title}</h2>
      {children}
    </section>
  );
}
