import Link from 'next/link';

export default function HomePage() {
  return (
    <main
      style={{
        display: 'grid',
        minHeight: '100vh',
        placeItems: 'center',
        padding: '48px 24px',
      }}
    >
      <section style={{ maxWidth: 760, textAlign: 'center' }}>
        <p
          style={{
            margin: '0 0 16px',
            color: '#2563eb',
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Omni Commerce
        </p>
        <h1 style={{ margin: 0, fontSize: 48, lineHeight: 1.08 }}>
          Nền tảng vận hành thương mại đa kênh cho doanh nghiệp Việt Nam
        </h1>
        <p
          style={{
            margin: '24px auto 0',
            maxWidth: 620,
            color: '#475569',
            fontSize: 20,
            lineHeight: 1.6,
          }}
        >
          Trang giới thiệu đang được dựng nền tảng. Bảng điều khiển nội bộ sẽ
          kết nối API theo ngữ cảnh tổ chức ở các bước tiếp theo.
        </p>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            justifyContent: 'center',
            marginTop: 32,
          }}
        >
          <Link
            href="/login"
            style={{
              background: '#2563eb',
              borderRadius: 10,
              color: '#ffffff',
              fontWeight: 800,
              padding: '12px 18px',
              textDecoration: 'none',
            }}
          >
            Đăng nhập
          </Link>
          <Link
            href="/dashboard"
            style={{
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: 10,
              color: '#0f172a',
              fontWeight: 800,
              padding: '12px 18px',
              textDecoration: 'none',
            }}
          >
            Vào dashboard
          </Link>
        </div>
        <p style={{ color: '#94a3b8', fontSize: 14, margin: '40px 0 0' }}>
          <Link href="/legal/terms" style={{ color: '#64748b' }}>
            Điều khoản
          </Link>
          {' · '}
          <Link href="/legal/privacy" style={{ color: '#64748b' }}>
            Bảo mật
          </Link>
        </p>
      </section>
    </main>
  );
}
