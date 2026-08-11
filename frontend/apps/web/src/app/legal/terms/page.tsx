import type { Metadata } from 'next';

import { LegalDocument, LegalSection } from '../../../components/legal-document';

export const metadata: Metadata = {
  title: 'Điều khoản sử dụng | Omni Commerce',
  description: 'Điều khoản sử dụng nền tảng Omni Commerce cho chương trình pilot.',
};

export default function TermsPage() {
  return (
    <LegalDocument title="Điều khoản sử dụng" updatedAt="25/07/2026">
      <p style={{ margin: 0 }}>
        Điều khoản này điều chỉnh việc truy cập và sử dụng nền tảng Omni Commerce
        (&quot;Dịch vụ&quot;) trong giai đoạn pilot nội bộ và thử nghiệm có kiểm soát.
        Bằng việc đăng nhập hoặc sử dụng Dịch vụ, bạn xác nhận đã đọc và chấp nhận
        các điều khoản dưới đây.
      </p>

      <LegalSection title="1. Phạm vi Dịch vụ">
        <p style={{ margin: 0 }}>
          Omni Commerce cung cấp công cụ vận hành thương mại đa kênh: quản lý hộp
          thư, sản phẩm, đơn hàng và kết nối kênh bán (ví dụ Facebook/Meta). Trong
          pilot, một số tính năng có thể thay đổi, giới hạn hoặc tạm ngưng mà không
          báo trước để phục vụ thử nghiệm kỹ thuật.
        </p>
      </LegalSection>

      <LegalSection title="2. Tài khoản và tổ chức">
        <p style={{ margin: 0 }}>
          Bạn chịu trách nhiệm bảo mật thông tin đăng nhập, access token và quyền
          truy cập tổ chức được cấp. Mọi thao tác thực hiện dưới tài khoản của bạn
          được coi là do bạn hoặc tổ chức bạn đại diện thực hiện. Không chia sẻ token
          cho bên thứ ba không được ủy quyền.
        </p>
      </LegalSection>

      <LegalSection title="3. Sử dụng chấp nhận được">
        <ul style={{ margin: '8px 0 0', paddingLeft: 22 }}>
          <li>Tuân thủ pháp luật Việt Nam và chính sách nền tảng bên thứ ba.</li>
          <li>Không gửi spam, nội dung lừa đảo hoặc vi phạm quyền riêng tư khách hàng.</li>
          <li>Không cố gắng truy cập trái phép, reverse engineer hoặc làm suy giảm hệ thống.</li>
          <li>Chỉ xử lý dữ liệu khách hàng khi có cơ sở pháp lý và mục đích hợp lệ.</li>
        </ul>
      </LegalSection>

      <LegalSection title="4. Dữ liệu và tích hợp bên thứ ba">
        <p style={{ margin: 0 }}>
          Dịch vụ có thể đồng bộ dữ liệu với nhà cung cấp hạ tầng (ví dụ Supabase) và
          nền tảng Meta/Facebook theo cấu hình do bạn kích hoạt. Bạn chịu trách nhiệm
          đảm bảo đã có sự đồng ý cần thiết từ khách hàng cuối và tuân thủ điều khoản
          của các bên thứ ba liên quan.
        </p>
      </LegalSection>

      <LegalSection title="5. Miễn trừ và giới hạn trách nhiệm">
        <p style={{ margin: 0 }}>
          Dịch vụ được cung cấp &quot;nguyên trạng&quot; trong giai đoạn pilot. Chúng
          tôi nỗ lực duy trì tính khả dụng nhưng không cam kết không gián đoạn. Trong
          phạm vi pháp luật cho phép, trách nhiệm tổng thể liên quan đến Dịch vụ pilot
          được giới hạn ở mức tối đa bằng phí bạn đã trả (nếu có) trong ba tháng gần
          nhất trước sự kiện phát sinh.
        </p>
      </LegalSection>

      <LegalSection title="6. Chấm dứt">
        <p style={{ margin: 0 }}>
          Chúng tôi có thể tạm ngưng hoặc chấm dứt quyền truy cập pilot khi phát hiện
          vi phạm điều khoản, rủi ro bảo mật hoặc kết thúc chương trình thử nghiệm.
          Bạn có thể ngừng sử dụng bất cứ lúc nào bằng cách xóa phiên đăng nhập và
          ngắt kết nối kênh.
        </p>
      </LegalSection>

      <LegalSection title="7. Thay đổi điều khoản">
        <p style={{ margin: 0 }}>
          Chúng tôi có thể cập nhật điều khoản khi mở rộng phạm vi pilot hoặc thay
          đổi quy định pháp lý. Phiên bản mới sẽ được đăng tại đường dẫn này kèm
          ngày cập nhật. Việc tiếp tục sử dụng sau khi cập nhật đồng nghĩa với chấp
          nhận điều khoản mới.
        </p>
      </LegalSection>

      <LegalSection title="8. Liên hệ">
        <p style={{ margin: 0 }}>
          Mọi câu hỏi về điều khoản pilot, vui lòng liên hệ đội vận hành Omni Commerce
          qua kênh hỗ trợ nội bộ được cung cấp cho tổ chức tham gia chương trình.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
