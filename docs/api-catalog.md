# Danh muc API va su kien

(Sinh tu docs/api-catalog.js bang scripts/build-openapi.js)

## Identity Service (cong 3001, qua gateway: /api/identity/...)

| Method | Duong dan | Quyen | Mo ta |
|---|---|---|---|
| GET | /specialties | public | Danh sach chuyen khoa |
| POST | /register | public | Dang ky tai khoan (benh nhan hoac bac si), gui OTP xac minh email |
| POST | /verify-email | public | Nhap OTP 6 so de kich hoat tai khoan (het han 10 phut, toi da 5 lan sai) |
| POST | /resend-otp | public | Gui lai OTP (cach nhau 60 giay) |
| POST | /login | public | Dang nhap, tra JWT song 12 gio |
| GET | /me | any | Thong tin tai khoan hien tai (kem ho so neu la bac si) |
| GET | /doctors | any | Danh sach bac si dang hoat dong |
| GET | /doctors/me/status | doctor | Trang thai ho so bac si va nhat ky chuyen trang thai (FSM) |
| POST | /doctors/me/resubmit | doctor | Nop lai ho so bi tu choi (toi da 3 lan) |
| POST | /doctors/me/deactivate | doctor | Bac si tu dong tai khoan (khi khong con lich sap toi) |
| GET | /internal/users/:id | internal | Tra thong tin co ban cua nguoi dung cho service khac |

## Scheduling Service (cong 3002, qua gateway: /api/scheduling/...)

| Method | Duong dan | Quyen | Mo ta |
|---|---|---|---|
| GET | /doctors | any | Bac si con lich trong, loc theo ?specialty=, kem slot gan nhat va gia |
| GET | /doctors/me/work-state | doctor | Trang thai lam viec hien tai: AVAILABLE, IN_CONSULTATION, OFF_DUTY |
| GET | /doctors/:id/slots | any | Slot AVAILABLE sap toi cua mot bac si |
| POST | /shifts | doctor | Dang ky ca; he thong tu duyet theo 5 luat |
| GET | /shifts/mine | doctor | Ca da dang ky cua toi |
| DELETE | /shifts/:id | doctor | Huy ca (chi khi chua co lich dat) |
| POST | /leaves | doctor | Xin nghi phep (tu duyet); huy hang loat va hoan tien lich bi anh huong |
| GET | /leaves/mine | doctor | Ky nghi cua toi |
| POST | /appointments | patient | Dat lich: giu slot 15 phut bang optimistic locking, khoi tao thanh toan |
| GET | /appointments/mine | any | Lich hen cua toi (phan trang ?page=&limit=, header X-Total-Count) |
| GET | /appointments/:id | any | Chi tiet lich hen kem nhat ky FSM va ty le hoan tien neu huy luc nay |
| POST | /appointments/:id/cancel | patient | Huy lich: hoan 100% (>=24h), 50% (2-24h), 0% (<2h); Saga hoan tien |
| POST | /appointments/:id/retry-payment | patient | Thu thanh toan lai (toi da 3 lan trong thoi gian giu cho) |
| POST | /appointments/:id/reschedule | patient | Doi sang slot khac cua cung bac si (giu slot moi truoc, nha slot cu sau) |
| GET | /stats/me | any | Thong ke cho dashboard |
| GET | /internal/doctors/:id/future-count | internal | So lich sap toi cua bac si (Identity dung khi bac si dong tai khoan) |

## Billing Service (cong 3003, qua gateway: /api/billing/...)

| Method | Duong dan | Quyen | Mo ta |
|---|---|---|---|
| GET | /invoices | patient | Hoa don cua toi, loc ?appointmentId=; kem payUrl cua lan thanh toan hien tai |
| POST | /webhooks/vnpay-ipn | internal | Webhook cong thanh toan: xac thuc chu ky HMAC + idempotency theo txnRef:status (chan o gateway) |
| POST | /internal/otp | internal | Cong thanh toan yeu cau gui OTP: Billing phat su kien payment.otp_issued |

## Records Service (cong 3004, qua gateway: /api/records/...)

| Method | Duong dan | Quyen | Mo ta |
|---|---|---|---|
| GET | /drugs | any | Danh muc thuoc |
| POST | /consultations/:appointmentId/complete | doctor | Ket thuc buoi kham: ghi benh an (FHIR Encounter) va ke don (MedicationRequest) |
| GET | /records/mine | patient | Benh an cua toi (kem FHIR va don thuoc) |
| GET | /records/patient/:patientId | doctor | Bac si xem benh an benh nhan co lich hen voi minh; moi lan xem ghi nhat ky |
| GET | /access-logs/mine | patient | Ai da xem hoac ghi benh an cua toi (50 gan nhat) |
| GET | /prescriptions/mine | patient | Don thuoc dien tu cua toi |
| POST | /prescriptions/:id/collect | patient | Danh dau da nhan thuoc o co so ban thuoc (ISSUED -> COLLECTED) |

## Teleconsultation Service (cong 3005, qua gateway: /api/tele/...)

| Method | Duong dan | Quyen | Mo ta |
|---|---|---|---|
| GET | /sessions/:appointmentId | any | Trang thai phong kham (ai da vao) |
| POST | /sessions/:appointmentId/join | any | Vao phong, nhan duong dan Jitsi; khi ca hai da vao lich chuyen in_progress |

## Notification Service (cong 3006, qua gateway: /api/notify/...)

| Method | Duong dan | Quyen | Mo ta |
|---|---|---|---|
| GET | /notifications/mine | any | Thong bao cua toi + so chua doc (phan trang ?page=&limit=) |
| POST | /notifications/read-all | any | Danh dau da doc tat ca |

## Su kien (RabbitMQ topic exchange clinic.events)

| Su kien | Phat boi | Nghe boi | Y nghia |
|---|---|---|---|
| user.otp_issued | identity | notify | Gui OTP xac minh email |
| user.registered | identity | notify | Email da xac minh: chao mung, luu email de gui thu |
| doctor.registered | identity | identity, notify | Bac si xac minh email xong: bat dau xac thuc giay phep |
| doctor.verified | identity | scheduling, notify | Giay phep hop le: ho so active |
| doctor.rejected | identity | notify | Giay phep khong hop le: ho so rejected |
| doctor.suspended | identity | scheduling, notify | Tam khoa (het han giay phep hoac vang 3 lan): khoa slot, huy lich |
| doctor.reactivated | identity | scheduling, notify | Het khoa: mo lai slot |
| doctor.deactivated | identity | scheduling, notify | Dong tai khoan (thu hoi giay phep hoac bac si tu dong) |
| doctor.on_leave | identity | scheduling | Bac si bat dau nghi phep |
| doctor.returned | identity | scheduling | Bac si het nghi phep: sinh lai slot |
| shift.approved | scheduling | scheduling | Ca duoc duyet: sinh slot 30 ngay |
| leave.approved | scheduling | scheduling, notify | Nghi phep duoc duyet: khoa slot, huy lich bi anh huong |
| doctor.leave_started | scheduling | identity | Ky nghi bat dau: ho so chuyen on_leave |
| doctor.leave_ended | scheduling | identity | Ky nghi ket thuc: ho so ve active |
| appointment.requested | scheduling | billing | Dat lich: tao hoa don va giao dich VNPay |
| payment.retry_requested | scheduling | billing | Thu thanh toan lai |
| payment.otp_issued | billing | notify | OTP thanh toan VNPay gui ve email |
| payment.completed | billing | scheduling, notify | Thanh toan thanh cong: xac nhan lich |
| payment.failed | billing | scheduling, notify | Thanh toan that bai: lich failed, toi da 3 lan |
| appointment.confirmed | scheduling | records, tele, notify | Lich xac nhan: tao phong kham, luu ban sao cho kiem tra quyen, dat nhac lich |
| appointment.failed | scheduling | billing, notify | Het han giu cho hoac het luot thanh toan: huy hoa don |
| appointment.rescheduled | scheduling | records, tele, notify | Doi lich thanh cong |
| appointment.cancelled | scheduling | billing, records, tele, notify | Lich bi huy (benh nhan, bac si hoac he thong) |
| refund.requested | scheduling | billing | Yeu cau hoan tien (Saga buoc 1) |
| refund.completed | billing | scheduling, notify | Da hoan tien (Saga buoc 2): lich refunded |
| consultation.started | tele | scheduling, records | Ca hai ben da vao phong: lich in_progress |
| consultation.completed | records | scheduling, tele, notify | Da ghi benh an: lich completed, dong phong |
| prescription.issued | records | notify | Da phat hanh don thuoc dien tu |
| prescription.collected | records | - | Benh nhan da nhan thuoc |
| patient.no_show | tele | scheduling, records, notify | Benh nhan vang mat: lich no_show, khong hoan phi |
| doctor.absent | tele | scheduling, identity, notify | Bac si vang mat qua 15 phut: huy, hoan 100%, dem vang mat |
