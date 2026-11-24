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

Mỗi service có **database MongoDB riêng** (`identity_db`, `scheduling_db`, `billing_db`, `records_db`, `tele_db`, `notify_db`), chỉ lưu id tham chiếu, không đọc DB của nhau. Mặc định các database nằm trên cùng một máy chủ `mongo`; muốn tách hẳn thì đặt `MONGO_URL_<SERVICE>` trỏ tới máy chủ khác. Không dùng Redis: chống đặt trùng slot bằng cập nhật nguyên tử có điều kiện `version` (optimistic locking) của MongoDB. Giao tiếp REST khi cần kết quả ngay, sự kiện RabbitMQ khi nhiều bên cùng phản ứng. Mất kết nối RabbitMQ thì service tự thoát để Docker khởi động lại và nối lại.

## Chạy bằng Docker

```bash
cp .env.example .env     # rồi điền JWT_SECRET, INTERNAL_KEY, WEBHOOK_SECRET (mỗi khóa tạo bằng lệnh bên dưới)
docker run --rm node:22-slim node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
docker compose up -d --build     # đợi ~30 giây; mọi service có healthcheck, "docker compose ps" phải hiện healthy
node scripts/seed.js             # (tùy chọn) nạp 6 bác sĩ + 3 bệnh nhân mẫu, mật khẩu chung secret123
```

| Cổng trên máy | Dùng để |
|---|---|
| http://localhost:8080 | Giao diện và API Gateway. Kiểm tra sức khỏe: `/api/health` (7 mục phải là `up`). Tài liệu API: `/docs` |
| http://localhost:15673 | Giao diện quản trị RabbitMQ (guest / guest) |
| mongodb://127.0.0.1:27030 | MongoDB (mỗi service một database `<service>_db`) |

Chỉ cổng 8080 là bắt buộc phải mở. Các service nội bộ (3001 đến 3006, 4000) không mở ra ngoài mạng Docker.

**Dữ liệu mẫu** (`scripts/seed.js`): chạy lại nhiều lần vẫn an toàn, tài khoản đã có sẽ được bỏ qua. Bác sĩ `bs.an@sina.vn` ... `bs.phuong@sina.vn` (giấy phép `BS10001` đến `BS10006`), bệnh nhân `bn.lan@sina.vn`, `bn.minh@sina.vn`, `bn.nga@sina.vn`. Script cần `JWT_SECRET` (tự đọc từ `.env`) và truy cập được MongoDB ở cổng 27030.

## Chạy không cần Docker

Cần Node.js 22.13+, một RabbitMQ ở `amqp://localhost` và một MongoDB ở `mongodb://127.0.0.1:27017` (đổi bằng `RABBITMQ_URL`, `MONGO_URL`).

```bash
npm install
npm run dev          # chạy 8 tiến trình, mở http://localhost:8080
```

## Kiểm thử

| Lệnh | Cần hệ thống chạy? | Nội dung |
|---|---|---|
| `npm run test:unit` | Không | 37 kiểm thử đơn vị (`node:test`): 5 luật duyệt ca, tỷ lệ hoàn tiền, bảng chuyển trạng thái FSM, optimistic locking với 20 yêu cầu đồng thời |
| `npm test` | Có | 68 kiểm tra end-to-end qua gateway: đặt lịch, thanh toán OTP, Saga hoàn tiền, FHIR, xác minh email, giới hạn dữ liệu nhập, giới hạn tần suất |
| `npm run test:concurrency` | Có | 20 bệnh nhân cùng đặt một slot: đúng 1 thành công, 19 nhận `SLOT_TAKEN` (mất khoảng 2 phút vì gateway giới hạn 20 lần đăng ký/phút) |
| `npm run dlq:replay` | Có | Phát lại sự kiện trong dead-letter queue (`--dry-run` để chỉ xem, `--service=billing` để chọn service) |

`npm test` và `npm run test:concurrency` cần hệ thống chạy với **ba biến kiểm thử** (mặc định đều tắt, không bật khi chạy thật):

```bash
# Docker:
EXPOSE_DEV_OTP=true VNPAY_REQUIRE_OTP=false ALLOW_MOCK_ADMIN=true docker compose up -d --build
# Không Docker (npm run dev, NODE_ENV khác production): chỉ cần EXPOSE_DEV_OTP=true npm run dev
```

`EXPOSE_DEV_OTP` làm API đăng ký trả kèm mã OTP (để test tự xác minh email), `VNPAY_REQUIRE_OTP=false` bỏ bước OTP của cổng thanh toán giả lập, `ALLOW_MOCK_ADMIN` cho phép thu hồi giấy phép giả lập. Sau `npm test` đợi 1 phút trước khi chạy lại vì bài kiểm tra giới hạn tần suất làm gateway chặn đăng nhập từ máy bạn trong 1 phút.

## Gửi email thật

Mặc định email chỉ được **ghi log** (giả lập) để chạy được ngay không cần cấu hình. Muốn email về hộp thư thật:

1. Sao chép `.env.example` thành `.env` (cùng thư mục với `docker-compose.yml`) rồi điền `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`. Với Gmail, bật xác minh 2 bước rồi tạo **Mật khẩu ứng dụng** tại https://myaccount.google.com/apppasswords (không dùng mật khẩu Gmail thường). Có thể dùng Mailtrap để thử mà không gửi cho người thật.
2. Chạy `docker compose up -d notify`, xem `docker compose logs notify` phải có dòng `SMTP san sang`.
3. Email gửi tới **địa chỉ người dùng nhập khi đăng ký**. Các email có: chào mừng, xác nhận lịch, biên lai thanh toán VNPay, hủy lịch, hoàn tiền, đơn thuốc, nhắc lịch trước 24 giờ và 1 giờ. Gửi lỗi thì thử lại 3 lần rồi đánh dấu lỗi (hiện trong mục Thông báo).
4. Không đưa file `.env` lên Git.

## Đăng ký và xác minh email

Đăng ký xong, hệ thống gửi **OTP 6 số** về email (hết hạn sau 10 phút, tối đa 5 lần nhập sai, gửi lại cách nhau 60 giây). Tài khoản chưa xác minh không đăng nhập được (`EMAIL_NOT_VERIFIED`); với bác sĩ, việc xác thực giấy phép chỉ bắt đầu sau khi email được xác minh. Nếu chưa cấu hình SMTP, mã OTP chỉ hiện trong log: `docker compose logs notify`.

## Thử nhanh (demo)

`DEMO_MODE=true` (mặc định) cho phép đặt lịch sát giờ và vào phòng khám bất kỳ lúc nào để demo trọn luồng trong vài phút. Đặt `DEMO_MODE=false` để áp dụng luật thật (đặt trước giờ khám ít nhất 2 giờ, phòng mở trước 10 phút). Các luật duyệt ca luôn áp dụng đầy đủ ở cả hai chế độ, kể cả luật đăng ký trước 24 giờ.

1. Đăng ký **bác sĩ** với số giấy phép `BS12345` (hợp lệ), nhập OTP nhận được qua email (hoặc xem `docker compose logs notify`). Hệ thống tự xác thực giấy phép, hồ sơ chuyển `active`. (Hoặc dùng `node scripts/seed.js` và đăng nhập bằng tài khoản mẫu.)
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
common/      thư viện dùng chung (MongoDB, event bus, JWT, HTTP) và rules.js (logic lõi thuần, có unit test)
services/    gateway, identity, scheduling, billing, records, tele, notify, mock-externals (Doctor Verification, VNPay)
frontend/    giao diện (HTML, CSS, JS thuần), bảng màu teal 900..50
tests/       unit.test.js, e2e.js, concurrency.js
scripts/     seed.js, replay-dlq.js, build-openapi.js, run-all.js
docs/        api-catalog.js (nguồn của OpenAPI), openapi/*.json, api-catalog.md, báo cáo và sơ đồ
```

Biến môi trường chính: `JWT_SECRET`, `INTERNAL_KEY`, `WEBHOOK_SECRET`, `DEMO_MODE`, `RABBITMQ_URL`, `EMAIL_FAIL_RATE` (giả lập gửi email lỗi để thấy retry), `VERIFY_FAIL_RATE` (giả lập Doctor Verification lỗi để thấy retry).

## Bảo mật

- **Gateway** kiểm tra JWT lần đầu, mỗi service kiểm tra lại; đường dẫn chứa `internal` hoặc `webhooks` bị chặn ở gateway (không phân biệt hoa thường, đã giải mã URL). Giới hạn chung 300 yêu cầu/phút/IP, riêng đăng nhập, đăng ký, xác minh email 20 lần/phút/IP (lần thứ 21 trả 429; bộ nhớ đếm được dọn mỗi phút).
- **Khóa bí mật**: ở chế độ production (Docker) bắt buộc đặt `JWT_SECRET`, `INTERNAL_KEY`, `WEBHOOK_SECRET` dài ít nhất 16 ký tự, không dùng giá trị mặc định; thiếu thì service từ chối chạy.
- **Giới hạn dữ liệu nhập**: body tối đa 100KB (413 `PAYLOAD_TOO_LARGE`), chuỗi có độ dài tối đa (400 `INVALID_FIELD`), email hợp lệ (400 `INVALID_EMAIL`), chặn NoSQL injection bằng kiểm tra kiểu chuỗi.
- **Container** chạy bằng user `node` (không root), cài bằng `npm ci`.
- Mật khẩu băm bcrypt; OTP chỉ lưu dạng HMAC; webhook thanh toán có chữ ký HMAC và idempotency.
- Bác sĩ chỉ xem hồ sơ bệnh nhân có lịch hẹn với mình, mọi lần xem đều ghi nhật ký mà bệnh nhân đọc được.

## Hạn chế đã biết

- Chỉ có **access token** sống 12 giờ, **chưa có refresh token** (đăng nhập lại khi hết hạn).
- Sự kiện được phát lên RabbitMQ sau khi ghi dữ liệu, chưa dùng transactional outbox: nếu RabbitMQ không phản hồi đúng lúc đó, sự kiện có thể mất.
- MongoDB chưa bật xác thực (các service dùng chung một máy chủ, tách bằng database riêng); cổng 27030 chỉ nên mở trên máy chạy đồ án.
- Cổng thanh toán, xác thực giấy phép, Jitsi công cộng (`meet.jit.si`) đều là giả lập hoặc dịch vụ thử nghiệm.
- Giao diện chưa rà soát đầy đủ trên điện thoại; danh sách lịch hẹn trên giao diện hiển thị tối đa 100 mục gần nhất (API có phân trang `?page=&limit=`).
- Swagger UI tại `/docs` tải thư viện từ cdnjs nên cần Internet khi mở trang; các file đặc tả `docs/openapi/*.json` vẫn dùng được offline.
- Có lỗ hổng đã công bố ở nodemailer 6.x: xem mục nâng cấp bên dưới.

## Nâng cấp nodemailer (bắt buộc trước khi nộp)

Cần chạy một lần khi có mạng, vì phải cập nhật cả `package-lock.json` (Dockerfile dùng `npm ci` nên sửa tay `package.json` mà không cập nhật lock sẽ làm build lỗi):

```bash
npm install nodemailer@latest      # cần bản 10.0.9 trở lên
npm audit --omit=dev               # phải báo 0 vulnerabilities
git add package.json package-lock.json
```
