# SINA Clinic: nền tảng khám bệnh từ xa tự động (SOA)

Đồ án cuối kì môn Kiến trúc hướng dịch vụ.

## Kiến trúc

```
Trình duyệt ──► API Gateway :8080 (JWT, rate limit, phục vụ giao diện)
                  ├─► identity   :3001  tài khoản, hồ sơ bác sĩ, FSM bác sĩ        (identity_db)
                  ├─► scheduling :3002  ca, slot, đặt/hủy/đổi lịch, FSM lịch hẹn   (scheduling_db)
                  ├─► billing    :3003  hóa đơn, VNPay, hoàn tiền, idempotency    (billing_db)
                  ├─► records    :3004  bệnh án FHIR, đơn thuốc điện tử, nhật ký truy cập (records_db)
                  ├─► tele       :3005  phòng Jitsi, phát hiện vắng mặt           (tele_db)
                  └─► notify     :3006  thông báo, email, nhắc lịch               (notify_db)
          RabbitMQ (topic exchange clinic.events + dead-letter queue clinic.dlx)
          MongoDB: mỗi service một database riêng (<service>_db)
          mock-externals :4000  Doctor Verification, VNPay sandbox
```

Mỗi service có **database MongoDB riêng** (`identity_db`, `scheduling_db`, `billing_db`, `records_db`, `tele_db`, `notify_db`), chỉ lưu id tham chiếu, không đọc DB của nhau. Mặc định các database nằm trên cùng một máy chủ `mongo`; muốn tách hẳn thì đặt `MONGO_URL_<SERVICE>` trỏ tới máy chủ khác. Không dùng Redis: chống đặt trùng slot bằng cập nhật nguyên tử có điều kiện `version` (optimistic locking) của MongoDB. Giao tiếp REST khi cần kết quả ngay, sự kiện RabbitMQ khi nhiều bên cùng phản ứng.

## Chạy bằng Docker

```bash
docker compose up --build
# mở http://localhost:8080      (RabbitMQ UI: http://localhost:15672, guest/guest; MongoDB: localhost:27017)
```

## Chạy không cần Docker

Cần Node.js 22.13+, một RabbitMQ ở `amqp://localhost` và một MongoDB ở `mongodb://127.0.0.1:27017` (đổi bằng `RABBITMQ_URL`, `MONGO_URL`).

```bash
npm install
npm run dev          # chạy 8 tiến trình, mở http://localhost:8080
npm test             # 54 kiểm thử end-to-end qua gateway (chạy khi hệ thống đang chạy)
```

## Thử nhanh (demo)

`DEMO_MODE=true` (mặc định) cho phép đặt lịch sát giờ và vào phòng khám bất kỳ lúc nào để demo trọn luồng trong vài phút. Đặt `DEMO_MODE=false` để áp dụng luật thật (đặt trước giờ khám ít nhất 2 giờ, phòng mở trước 10 phút). Các luật duyệt ca luôn áp dụng đầy đủ ở cả hai chế độ, kể cả luật đăng ký trước 24 giờ.

1. Đăng ký **bác sĩ** với số giấy phép `BS12345` (hợp lệ). Hệ thống tự xác thực, hồ sơ chuyển `active`.
2. Bác sĩ vào **Ca làm việc**, đăng ký một ca, hệ thống tự duyệt rồi sinh slot cho 30 ngày.
3. Đăng ký **bệnh nhân** (cửa sổ ẩn danh), vào **Đặt lịch khám**, chọn bác sĩ và giờ, **Đặt lịch và thanh toán**.
4. Trên trang VNPay giả lập bấm "Thanh toán thành công" (cổng gọi webhook 2 lần, Billing xử lý idempotent). Thử "thất bại" rồi **Thử lại**.
5. Hai bên bấm **Vào phòng khám** (mở Jitsi) thì lịch chuyển `in_progress`. Bác sĩ **Kết thúc và ghi bệnh án**, kê đơn: bệnh nhân nhận đơn điện tử có mã (`ISSUED`), tự mang đến cơ sở bán thuốc gần nhất (có nút mở bản đồ) rồi bấm **Tôi đã nhận thuốc** (`COLLECTED`).
6. Thử hủy lịch (hoàn 100% hoặc 50%), đổi lịch, bác sĩ xin nghỉ (hủy hàng loạt và hoàn tiền), và xem **Hồ sơ và trạng thái** của bác sĩ.

Đơn thuốc không có khâu nhà thuốc đối tác hay dược sĩ: hệ thống chỉ phát hành đơn điện tử, bệnh nhân tự đi nhận thuốc.

Số giấy phép giả lập: `BS#####` hợp lệ, `HH#####` hết hạn (bị tạm khóa), `TH#####` bị thu hồi, còn lại không hợp lệ. Thu hồi thủ công để demo khóa tự động: `curl -X POST localhost:8080/ext/verify/revoke/BS12345`.

## Các luật tự động chính

| Việc | Luật |
|---|---|
| Duyệt ca (tự động, không admin) | Scheduling kiểm tra lần lượt 5 luật: `DOCTOR_NOT_VERIFIED` (bác sĩ chưa xác thực hoặc giấy phép hết hiệu lực), `OUT_OF_HOURS` (ngoài 07:00 đến 20:00), `SHIFT_OVERLAP` (trùng ca khác của chính bác sĩ), `OVER_LIMIT` (quá 8 giờ/ngày), `TOO_LATE` (đăng ký chưa trước 24 giờ). Đạt cả 5 thì duyệt ngay và sinh slot 30 ngày, vi phạm thì `REJECTED` kèm mã lý do. |
| Giữ chỗ | Slot `HELD` 15 phút. Hết hạn hoặc thanh toán lỗi 3 lần thì trả slot. |
| Chống đặt trùng | Optimistic locking bằng cột `version` của slot. |
| Hoàn tiền | Hủy trước ≥24 giờ hoàn 100%, từ 2 đến 24 giờ hoàn 50%, trong 2 giờ cuối không hoàn, lỗi từ bác sĩ 100%. Saga: `cancelled → refunding → refunded`. |
| Bác sĩ vắng mặt | Quá 15 phút không vào phòng: hoàn 100%. Vắng 3 lần trong 30 ngày thì tự động tạm khóa 7 ngày. |
| Giấy phép | Kiểm tra định kỳ, hết hạn thì `suspended`, bị thu hồi thì `deactivated`. |

## Cấu trúc thư mục

```
common/      thư viện dùng chung (MongoDB, event bus, JWT, HTTP)
services/    gateway, identity, scheduling, billing, records, tele, notify, mock-externals (Doctor Verification, VNPay)
frontend/    giao diện (HTML, CSS, JS thuần), bảng màu teal 900..50
tests/e2e.js kiểm thử end-to-end
```

Biến môi trường chính: `JWT_SECRET`, `INTERNAL_KEY`, `WEBHOOK_SECRET`, `DEMO_MODE`, `RABBITMQ_URL`, `EMAIL_FAIL_RATE` (giả lập gửi email lỗi để thấy retry), `VERIFY_FAIL_RATE` (giả lập Doctor Verification lỗi để thấy retry).
