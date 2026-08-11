import type { Metadata } from 'next';

import { LegalDocument, LegalSection } from '../../../components/legal-document';

export const metadata: Metadata = {
  title: 'Chính sách bảo mật | Omni Commerce',
  description: 'Chính sách bảo mật và xử lý dữ liệu cá nhân của Omni Commerce.',
};

export default function PrivacyPage() {
  return (
    <LegalDocument title="Chính sách bảo mật" updatedAt="25/07/2026">
      <p style={{ margin: 0 }}>
        Chính sách này mô tả cách Omni Commerce thu thập, sử dụng, lưu trữ và bảo vệ
        dữ liệu cá nhân trong giai đoạn pilot. Chúng tôi tuân thủ các nguyên tắc bảo
        vệ dữ liệu theo quy định pháp luật Việt Nam hiện hành, bao gồm Nghị định
        13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân, trong phạm vi áp dụng.
      </p>

      <LegalSection title="1. Dữ liệu chúng tôi xử lý">
        <ul style={{ margin: '8px 0 0', paddingLeft: 22 }}>
          <li>Thông tin tài khoản người dùng nội bộ: email, vai trò, tổ chức.</li>
          <li>Dữ liệu vận hành: sản phẩm, đơn hàng, cấu hình kênh và nhật ký hệ thống.</li>
          <li>
            Dữ liệu hội thoại khách hàng đồng bộ từ kênh được kết nối (ví dụ tin nhắn
            Facebook Page) khi bạn bật tích hợp.
          </li>
          <li>Metadata kỹ thuật: địa chỉ IP, trình duyệt, thời gian truy cập (nếu có).</li>
        </ul>
      </LegalSection>

      <LegalSection title="2. Mục đích xử lý">
        <ul style={{ margin: '8px 0 0', paddingLeft: 22 }}>
          <li>Cung cấp và vận hành Dịch vụ cho tổ chức tham gia pilot.</li>
          <li>Xác thực phiên, phân quyền và bảo mật hệ thống.</li>
          <li>Hỗ trợ CSKH, quản lý đơn hàng và đồng bộ đa kênh theo cấu hình của bạn.</li>
          <li>Phân tích lỗi, cải thiện chất lượng và tuân thủ yêu cầu pháp lý.</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Cơ sở pháp lý">
        <p style={{ margin: 0 }}>
          Chúng tôi xử lý dữ liệu dựa trên sự đồng ý của chủ thể dữ liệu (khi cần),
          thực hiện hợp đồng cung cấp Dịch vụ, nghĩa vụ pháp lý hoặc lợi ích hợp pháp
          được cân nhắc (ví dụ phòng chống gian lận, bảo mật). Tổ chức sử dụng Dịch vụ
          chịu trách nhiệm đảm bảo có cơ sở pháp lý đối với dữ liệu khách hàng cuối
          mà họ đưa vào hệ thống.
        </p>
      </LegalSection>

      <LegalSection title="4. Chia sẻ với bên thứ ba">
        <p style={{ margin: 0 }}>
          Dữ liệu có thể được xử lý bởi nhà cung cấp hạ tầng và tích hợp cần thiết cho
          pilot, ví dụ Supabase (xác thực, cơ sở dữ liệu), Meta/Facebook (đồng bộ tin
          nhắn khi được kết nối), và dịch vụ giám sát lỗi (ví dụ Sentry). Chúng tôi
          không bán dữ liệu cá nhân. Việc chia sẻ chỉ diễn ra trong phạm vi cần thiết
          và có biện pháp bảo vệ phù hợp.
        </p>
      </LegalSection>

      <LegalSection title="5. Thời gian lưu trữ">
        <p style={{ margin: 0 }}>
          Dữ liệu được lưu trong thời gian tổ chức sử dụng Dịch vụ và theo chính sách
          lưu trữ nội bộ của pilot. Khi chấm dứt tham gia hoặc theo yêu cầu hợp lệ,
          dữ liệu sẽ được xóa hoặc ẩn danh hóa trong thời hạn hợp lý, trừ khi pháp
          luật yêu cầu lưu giữ lâu hơn.
        </p>
      </LegalSection>

      <LegalSection title="6. Quyền của chủ thể dữ liệu">
        <p style={{ margin: 0 }}>
          Tùy phạm vi áp dụng, bạn có thể yêu cầu truy cập, chỉnh sửa, xóa, hạn chế
          xử lý, rút lại sự đồng ý hoặc khiếu nại về việc xử lý dữ liệu cá nhân. Yêu
          cầu có thể gửi qua kênh hỗ trợ nội bộ; chúng tôi sẽ phản hồi trong thời hạn
          hợp lý theo quy định hiện hành.
        </p>
      </LegalSection>

      <LegalSection title="7. Bảo mật">
        <p style={{ margin: 0 }}>
          Chúng tôi áp dụng các biện pháp kỹ thuật và tổ chức phù hợp giai đoạn pilot:
          mã hóa truyền tải (HTTPS), phân quyền theo tổ chức, ghi log truy cập và giới
          hạn quyền vận hành. Không có hệ thống nào an toàn tuyệt đối; nếu xảy ra sự
          cố dữ liệu, chúng tôi sẽ thông báo theo quy định áp dụng.
        </p>
      </LegalSection>

      <LegalSection title="8. Cookie và lưu trữ cục bộ">
        <p style={{ margin: 0 }}>
          Ứng dụng web pilot có thể lưu phiên đăng nhập và tùy chọn tổ chức trong
          localStorage trình duyệt để duy trì trải nghiệm. Bạn có thể xóa dữ liệu
          cục bộ bằng cách đăng xuất hoặc xóa dữ liệu trang web trong trình duyệt.
        </p>
      </LegalSection>

      <LegalSection title="9. Thay đổi chính sách">
        <p style={{ margin: 0 }}>
          Chính sách có thể được cập nhật khi mở rộng phạm vi Dịch vụ hoặc thay đổi
          quy định pháp lý. Phiên bản mới sẽ được đăng tại đường dẫn này kèm ngày cập
          nhật.
        </p>
      </LegalSection>

      <LegalSection title="10. Liên hệ">
        <p style={{ margin: 0 }}>
          Để thực hiện quyền liên quan đến dữ liệu cá nhân hoặc đặt câu hỏi về chính
          sách này, vui lòng liên hệ đội vận hành Omni Commerce qua kênh hỗ trợ được
          cung cấp cho tổ chức tham gia pilot.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
