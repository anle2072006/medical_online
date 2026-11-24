# Trạng thái công việc so với tài liệu bàn giao (22/11/2026)

Ký hiệu: XONG = đã làm và đã kiểm tra bằng `node --check` hoặc unit test; CHUA CHAY = đã viết nhưng chưa chạy được (môi trường soạn không có Docker, MongoDB, RabbitMQ, Internet); CHUA LAM.

## 2.1 Code và bảo mật
| # | Trạng thái | Ghi chú |
|---|---|---|
| A1 | XONG (code), CHUA CHAY (e2e) | Giới hạn độ dài ở identity và records, `C.email`, body 100KB, 413 và 400 `BAD_JSON`. Test ở e2e mục 11 |
| A2 | CHUA CHAY | Không có `fixes.patch` trong zip nên không dùng được bản 64 test. `tests/e2e.js` được cập nhật tay: thanh toán có OTP, OTP email, 7 kiểm tra bảo mật mới, phân trang: **68 kiểm tra** |
| A3 | CHUA LAM | Cần mạng để cập nhật `package-lock.json`. Chạy `npm install nodemailer@latest` (cần 10.0.9 trở lên) rồi `npm audit --omit=dev`. Không sửa tay package.json vì Dockerfile dùng `npm ci` |
| A4 | XONG (code) | 20 lần/phút/IP cho login, register, verify-email, resend-otp; dọn bộ nhớ mỗi phút |
| A5 | XONG (code) | `common/index.js`: mất kết nối hoặc lỗi kênh RabbitMQ thì `process.exit(1)` |
| A6 | XONG | `npm ci`, `USER node` |
| A7 | XONG | `.env.example` không còn email thật. **Vẫn cần đổi mật khẩu ứng dụng Gmail cũ và cân nhắc repo private vì lịch sử Git còn giá trị cũ** |
| A8 | XONG (code), CHUA CHAY | `scripts/seed.js` (dùng API thật + verify-email), README có hướng dẫn |
| A9 | XONG | `.github/workflows/ci.yml` |
| A10 | XONG | README cập nhật |

## 2.2 Tính năng và chất lượng
| # | Trạng thái | Ghi chú |
|---|---|---|
| B1 | XONG (code), CHUA CHAY | OTP email 6 số, 10 phút, giao diện nhập OTP |
| B2 | XONG | `docs/api-catalog.js` sinh `docs/openapi/*.json`; Swagger UI tại `/docs` (cần Internet cho cdnjs) |
| B3 | XONG | Chọn sửa tài liệu: README ghi rõ chỉ có access token 12 giờ |
| B4 | XONG, 37 test đạt | `npm run test:unit`; logic tách sang `common/rules.js` |
| B5 | CHUA CHAY | `npm run test:concurrency`; phần mô phỏng đã nằm trong unit test |
| B6 | CHUA LAM | Transactional outbox: nêu như hạn chế và hướng phát triển |
| B7 | CHUA LAM | Xác thực MongoDB: nêu như hạn chế |
| B8 | XONG (code) | Healthcheck và `depends_on` điều kiện healthy (đã kiểm tra cú pháp YAML) |
| B9 | XONG (code) | Gateway sinh `x-request-id`, service ghi log các yêu cầu không phải GET |
| B10 | XONG (code) | `scripts/replay-dlq.js`, có `--dry-run` và `--service=` |
| B11 | XONG (code) | `?page=&limit=` kèm header `X-Total-Count`; giao diện vẫn xem tối đa 100 mục |
| B12 | CHUA LAM | Chưa rà soát giao diện trên điện thoại |

## 2.3 đến 2.4 Tài liệu
Báo cáo (C1 đến C10, D1 phần nội dung), slide 14 trang (D2), kịch bản demo và 20 câu hỏi bảo vệ (D3, D4) nằm ngoài thư mục repo cùng gói này; sơ đồ nguồn nằm ở `docs/diagrams/`. D5 (kiểm tra máy sạch) chưa làm, xem Phụ lục C của báo cáo.

**Lưu ý:** tài liệu bàn giao thiếu mục 4 đến 9 (bảng use case, đặc tả, sơ đồ tham khảo, ADR, câu hỏi). Danh sách 26 use case được dựng lại từ code; chỉ giữ cố định UC16 = webhook VNPay như mục 3 yêu cầu. Cần đối chiếu với bản gốc của chủ dự án nếu có.
