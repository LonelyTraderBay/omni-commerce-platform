import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Trạng thái hệ thống | Omni Commerce',
  description: 'Trang trạng thái công khai của Omni Commerce.',
};

const systems = [
  'Ứng dụng web',
  'API Core',
  'Đồng bộ kênh',
  'Tác vụ nền',
  'AI advisor',
];

export default function StatusPage() {
  return (
    <main
      style={{
        margin: '0 auto',
        maxWidth: 840,
        minHeight: '100vh',
        padding: '48px 24px 64px',
      }}
    >
      <p
        style={{
          color: '#16a34a',
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: '0.08em',
          margin: '0 0 12px',
          textTransform: 'uppercase',
        }}
      >
        Omni Commerce Status
      </p>
      <h1 style={{ fontSize: 40, lineHeight: 1.12, margin: '0 0 12px' }}>
        Tất cả hệ thống đang hoạt động bình thường
      </h1>
      <p style={{ color: '#64748b', fontSize: 17, lineHeight: 1.6, margin: '0 0 28px' }}>
        Đây là trang trạng thái công khai ban đầu. Chỉ số uptime và lịch sử sự cố
        tự động sẽ được kết nối ở giai đoạn vận hành enterprise tiếp theo.
      </p>

      <section
        style={{
          background: '#ffffff',
          border: '1px solid #dcfce7',
          borderRadius: 18,
          boxShadow: '0 12px 32px rgba(15, 23, 42, 0.06)',
          padding: 24,
        }}
      >
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            gap: 12,
            marginBottom: 18,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              background: '#22c55e',
              borderRadius: 999,
              display: 'inline-block',
              height: 14,
              width: 14,
            }}
          />
          <strong style={{ color: '#166534', fontSize: 18 }}>Operational</strong>
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {systems.map((system) => (
            <li
              key={system}
              style={{
                alignItems: 'center',
                borderTop: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'space-between',
                padding: '14px 0',
              }}
            >
              <span style={{ color: '#0f172a', fontWeight: 700 }}>{system}</span>
              <span style={{ color: '#16a34a', fontWeight: 800 }}>Bình thường</span>
            </li>
          ))}
        </ul>
      </section>

      <section id="incidents" style={{ marginTop: 32 }}>
        <h2 style={{ color: '#0f172a', fontSize: 24, margin: '0 0 10px' }}>
          Sự cố gần đây
        </h2>
        <p style={{ color: '#64748b', fontSize: 16, lineHeight: 1.6, margin: 0 }}>
          Chưa có sự cố công khai nào được ghi nhận trên trang này. Khi có incident,
          lịch sử và cập nhật sẽ được đăng tại mục này.
        </p>
      </section>

      <footer style={{ display: 'flex', gap: 16, marginTop: 32 }}>
        <Link href="#incidents" style={{ color: '#2563eb', fontWeight: 800 }}>
          Xem lịch sử sự cố
        </Link>
        <Link href="/" style={{ color: '#2563eb', fontWeight: 800 }}>
          Trang chủ
        </Link>
      </footer>
    </main>
  );
}
