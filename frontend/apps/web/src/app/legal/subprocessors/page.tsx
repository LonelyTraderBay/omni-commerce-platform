import type { Metadata } from 'next';

import { LegalDocument, LegalSection } from '../../../components/legal-document';

const subprocessors = [
  {
    name: 'Supabase',
    purpose: 'Postgres, Auth, Storage',
    data: 'Dữ liệu ứng dụng đa thuê bao',
    region: 'Theo project (ghi rõ khi provision)',
  },
  {
    name: 'Render hoặc Fly.io',
    purpose: 'Host web / api / ai',
    data: 'Traffic HTTP, logs',
    region: 'Theo region deploy',
  },
  {
    name: 'Inngest',
    purpose: 'Jobs / webhooks async',
    data: 'Payload sự kiện (org-scoped)',
    region: 'Theo Inngest account',
  },
  {
    name: 'Google (Gemini)',
    purpose: 'LLM + embeddings',
    data: 'Prompt/context có thể chứa PII tin nhắn',
    region: 'Google Cloud AI',
  },
  {
    name: 'Meta Platforms',
    purpose: 'Messenger / Instagram messaging',
    data: 'Webhook nội dung tin, page tokens (mã hóa at rest trên Core)',
    region: 'Meta',
  },
  {
    name: 'Sentry (nếu bật)',
    purpose: 'Error tracking',
    data: 'Stack traces, request metadata',
    region: 'Theo Sentry org',
  },
  {
    name: 'Uptime monitor (UptimeRobot / Better Stack)',
    purpose: 'Health checks',
    data: 'URL public, status',
    region: 'Theo vendor',
  },
];

export const metadata: Metadata = {
  title: 'Subprocessors | Omni Commerce',
  description: 'Danh sách nhà xử lý phụ của Omni Commerce.',
};

export default function SubprocessorsPage() {
  return (
    <LegalDocument title="Danh sách subprocessors" updatedAt="25/07/2026">
      <p style={{ margin: 0 }}>
        Trang này công khai các nhà cung cấp có thể xử lý dữ liệu để vận hành Omni
        Commerce trong phạm vi pilot/enterprise readiness. Danh sách sẽ được cập
        nhật khi có thay đổi material.
      </p>

      <LegalSection title="Danh sách hiện tại">
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              borderCollapse: 'collapse',
              marginTop: 12,
              minWidth: 680,
              width: '100%',
            }}
          >
            <thead>
              <tr>
                {['Nhà cung cấp', 'Mục đích', 'Dữ liệu liên quan', 'Vùng'].map(
                  (heading) => (
                    <th
                      key={heading}
                      style={{
                        borderBottom: '1px solid #cbd5e1',
                        color: '#0f172a',
                        padding: '10px 8px',
                        textAlign: 'left',
                      }}
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {subprocessors.map((subprocessor) => (
                <tr key={subprocessor.name}>
                  <td style={cellStyle}>{subprocessor.name}</td>
                  <td style={cellStyle}>{subprocessor.purpose}</td>
                  <td style={cellStyle}>{subprocessor.data}</td>
                  <td style={cellStyle}>{subprocessor.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LegalSection>

      <LegalSection title="Ghi chú">
        <ul style={{ margin: '8px 0 0', paddingLeft: 22 }}>
          <li>Token Meta: AES-256-GCM trên Core; không gửi browser.</li>
          <li>
            LLM: Core ghi `ai_runs`; kill switches `kill_ai_all` / `kill_ai_outbound`.
          </li>
          <li>
            Thêm/bớt subprocessor material sẽ cập nhật trang này và thông báo khách
            pilot/enterprise theo thỏa thuận.
          </li>
        </ul>
      </LegalSection>
    </LegalDocument>
  );
}

const cellStyle = {
  borderBottom: '1px solid #e2e8f0',
  padding: '10px 8px',
  verticalAlign: 'top',
} as const;
