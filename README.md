# 🎬 Google Drive Auto Subtitles Uploader

Công cụ tự động hóa gắn phụ đề (`.srt` / `.vtt`) vào video (`.mp4`) trên **Google Drive** sử dụng **Playwright** và **TypeScript**. 

Hỗ trợ cả giao diện **Dòng lệnh (CLI)** và **Giao diện Web (Dashboard)** trực quan kèm màn hình theo dõi tiến trình thời gian thực.

---

## ✨ Tính năng nổi bật

- 🤖 **Tự động hóa 100%:** Tự động mở Google Drive, chọn video, mở hộp thoại quản lý phụ đề, tìm file phụ đề và lưu.
- 🎯 **Quy tắc bộ 3 phụ đề thông minh:**
  - `[tên_video]_en.srt` ➔ Ngôn ngữ: **Tiếng Anh** | Tiêu đề: *(Để trống)*
  - `[tên_video]_vi.srt` ➔ Ngôn ngữ: **Tiếng Việt** | Tiêu đề: *(Để trống)*
  - `[tên_video].srt` ➔ Ngôn ngữ: **Tiếng Việt** | Tiêu đề: **Song Ngữ**
- 🛡️ **Khớp chính xác 100% (Exact Match):** Không bao giờ bị nhầm lẫn giữa các file có tên tương tự (ví dụ: `video.srt` và `Bản sao của video.srt`).
- ⏭️ **Tự động bỏ qua file:** Bỏ qua các video `.mp4` có tiền tố gạch dưới `_` ở đầu tên (ví dụ: `_intro.mp4`).
- 📁 **Tự động duyệt thư mục con (Recursive):** Bạn chỉ cần cung cấp ID của thư mục cha, công cụ sẽ tự động đi vào từng thư mục con (`tutorial1`, `tutorial2`...) để xử lý toàn bộ video.
- ⚡ **Chạy song song đa luồng (Multi-threading):** Hỗ trợ xử lý nhiều thư mục cùng một lúc để tăng tốc độ tối đa.
- 🌐 **Sử dụng Google Chrome thật (`channel: 'chrome'`):** Sử dụng trình duyệt Chrome cài trên máy của người dùng, không bao giờ bị Google chặn bot hay nghi ngờ đăng nhập.
- 🔒 **Lưu phiên đăng nhập an toàn:** Profile đăng nhập được lưu cục bộ trên máy (`drive-profile/`), chỉ cần đăng nhập 1 lần duy nhất. Tự động đóng Chrome sau khi hoàn thành.

---

## 📋 Yêu cầu hệ thống

1. **Node.js** (Phiên bản 18, 20 hoặc 22+).
2. **Google Chrome** đã được cài đặt sẵn trên máy tính.

---

## 🚀 Cài đặt ban đầu

Mở Terminal / PowerShell tại thư mục dự án và chạy:

```bash
# 1. Cài đặt các thư viện phụ thuộc
npm install

# 2. Cài đặt trình duyệt cho Playwright (nếu chưa có)
npx playwright install chromium
```

---

## 🖥️ Hướng dẫn sử dụng

Công cụ hỗ trợ 2 chế độ: **Giao diện Web (Khuyên dùng)** và **Dòng lệnh (CLI)**.

---

### CÁCH 1: Sử dụng Giao diện Web (Khuyên dùng) 🌟

Thích hợp cho mọi người dùng, giao diện trực quan, không cần chỉnh sửa code hay file cấu hình.

#### 1. Khởi động Web Server
Chạy lệnh:
```bash
npm run web
```
*(Hoặc `npx tsx server.ts`)*

Terminal sẽ thông báo:
```text
🚀 WEBSITE ĐANG CHẠY TẠI: http://localhost:3000
```

#### 2. Mở trình duyệt và sử dụng
1. Mở trình duyệt bất kỳ vào địa chỉ: [http://localhost:3000](http://localhost:3000)
2. **Đăng nhập Google (Chỉ cần làm 1 lần đầu tiên):**
   - Bấm nút **`🔑 Đăng nhập Google (Lần đầu)`**.
   - Cửa sổ Chrome thật sẽ mở ra ➔ Đăng nhập tài khoản Google của bạn.
   - Sau khi đăng nhập thành công, đóng cửa sổ Chrome lại.
3. **Chạy tác vụ:**
   - Dán danh sách ID hoặc Link thư mục Google Drive vào ô văn bản (mỗi ID/link trên 1 dòng).
   - Chọn số luồng chạy song song (1 hoặc 2 luồng).
   - Bấm nút **`🚀 Bắt đầu chạy (Run)`**.
4. **Theo dõi:** Màn hình Live Logs trên trang web sẽ hiển thị chi tiết tiến trình đang làm việc. Khi xong, Chrome sẽ tự động đóng lại an toàn!

---

### CÁCH 2: Sử dụng Dòng lệnh (CLI) ⚙️

Thích hợp cho việc tích hợp script tự động, chạy ngầm hoặc người dùng quen thuộc với terminal.

#### 1. Cấu hình file `.env`
Tạo file `.env` tại thư mục gốc của dự án và điền danh sách ID hoặc Link thư mục (cách nhau bởi dấu phẩy):

```env
# Điền danh sách ID (hoặc link đầy đủ) cách nhau bởi dấu phẩy:
DRIVE_FOLDER_IDS=1FjbPwPHrovXUjCnEjXd6O2ykXVvDWeJP,1fmgoKcFV45IV4Yx1SJtbOnufsa8dHAQg
```

> **Mẹo:** Bạn chỉ cần điền ID của **thư mục cha ngoài cùng**, script sẽ tự động tìm và duyệt hết tất cả các thư mục con bên trong!

#### 2. Chạy lệnh
```bash
npm run task
```
*(Hoặc `npx tsx upload-captions.ts`)*

- Nếu là lần đầu chạy chưa đăng nhập, Chrome sẽ tạm dừng chờ bạn đăng nhập Google.
- Sau khi đăng nhập, script sẽ tự động quét và gắn phụ đề cho toàn bộ video trong danh sách.
- Khi hoàn tất, script sẽ tự động đóng trình duyệt.

---

## 📁 Cấu trúc thư mục dự án

```text
drive-caption-uploader/
├── drive-profile/          # Nơi lưu trữ cookie/session đăng nhập Google Chrome
├── public/
│   └── index.html          # Giao diện Web Dashboard
├── .env                    # File cấu hình ID thư mục (dành cho CLI)
├── server.ts               # Web Server Backend & API điều khiển
├── upload-captions.ts      # Script chạy trực tiếp dạng CLI
├── package.json
├── tsconfig.json
└── README.md
```

---

## ❓ Câu hỏi thường gặp & Khắc phục sự cố

### 1. Dữ liệu đăng nhập có bị lộ không?
**Không.** Toàn bộ thông tin đăng nhập và Cookie được lưu trực tiếp trong thư mục `drive-profile/` trên ổ cứng máy tính cá nhân của bạn. Không có bất kỳ dữ liệu nào được gửi ra ngoài máy chủ bên thứ ba.

### 2. Có nên chọn số luồng song song quá cao không?
Mặc định nên chọn **2 luồng song song**. Không nên chọn quá 3-4 luồng cùng lúc để tránh việc Google Drive kích hoạt cơ chế giới hạn tần suất (Rate Limit 429) và tránh ngốn RAM máy tính.

### 3. File phụ đề bị nằm ở hàng dưới bị khuất thì sao?
Script đã được tích hợp cơ chế tự động cuộn khung nhìn (`scrollIntoViewIfNeeded`) và bắt thẻ chính xác (`attached`), dù thư mục có 20-50 file thì script vẫn tự cuộn xuống tìm đúng file để chèn.
