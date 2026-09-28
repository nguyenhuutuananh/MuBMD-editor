# MuBMD-editor

Công cụ có giao diện (chạy trên `localhost`, Windows + macOS) để nhiều người
cùng dịch tên vật phẩm trong `Item.bmd` của client MuMain (Mu Online season 6).

Mô hình làm việc nhóm: **mỗi người chạy công cụ trên máy mình** (server chỉ
nghe `127.0.0.1`), trao đổi bản dịch qua file (Google Drive...). Phần gộp bản
dịch của nhiều người thuộc giai đoạn 4.

## Trạng thái

| Giai đoạn | Nội dung | Trạng thái |
|---|---|---|
| 1 | Lõi đọc/ghi Item.bmd + test khớp từng byte | Xong |
| 2 | Server API + bảng chỉ đọc (cây nhóm, bộ lọc) | Xong |
| 3 | Sửa trên bảng, bộ đếm byte, kiểm tra, undo, lưu kèm backup | Xong |
| 3b | Chuyển giao diện sang Vue 3 + shadcn-vue + đa ngôn ngữ (English mặc định, Tiếng Việt) | Xong |
| 4 | Xuất/nhập TSV, cột tham chiếu, file dự án + trạng thái dịch, gộp bản dịch nhiều người | Chưa |
| 5 | Thuật ngữ, so sánh file, đóng gói .exe/.app | Chưa |

## Chạy

Cần Bun (server, test, build file chạy) và Node 20.19+ (Vite).

```
bun install
bun run dev              # dev: server API (4817) + Vite (5173, HMR), mở data/Item.bmd, tự mở trình duyệt
bun run dev -- đường/dẫn/Item.bmd
bun run start            # build giao diện rồi chạy như bản phát hành (1 port, http://localhost:4817)
bun run build            # file chạy độc lập vào dist/ (Windows x64, macOS arm64/x64), nhúng sẵn giao diện
```

**Vì sao dev có 2 port:** Vite (5173) chỉ phục vụ giao diện, tự cập nhật khi sửa code, và
chuyển `/api` sang server Bun (4817). Nhờ vậy API khi dev chạy đúng runtime Bun như bản
phát hành. Bản phát hành (`bun run start`, file chạy) chỉ dùng **1 port**.

File chạy độc lập: `MuBMD-editor [đường/dẫn/Item.bmd] [--port 4817] [--no-open]`.
Nếu cổng 4817 bận, công cụ tự thử cổng kế tiếp.

**Lưu ý:** thư mục này nằm trên Google Drive - `dist/` (~230 MB) và
`node_modules/` sẽ bị đồng bộ lên Drive nếu để ở đây. Nên build ra rồi chuyển
file chạy đi chỗ khác, hoặc cho Drive bỏ qua 2 thư mục đó.

## Ngôn ngữ giao diện

- Tiếng Anh là mặc định và **luôn hiện ở lần mở đầu tiên**; chọn Tiếng Việt ở nút ngôn
  ngữ góc trên bên phải, lựa chọn được nhớ trong trình duyệt.
- File ngôn ngữ: `web/src/i18n/locales/en.json`, `vi.json`. `bun test` kiểm tra 2 file
  có cùng bộ key, cùng tham số `{…}`, và có bản dịch cho mọi mã lỗi.
- Server/lõi không trả câu chữ mà trả **mã lỗi + tham số** (`{ code: "bmd-size", params: { size, expected } }`),
  giao diện tự dịch. Thêm mã lỗi mới: `src/core/errors.ts` + 2 file ngôn ngữ.
- Dữ liệu game (tên vật phẩm, `changes.tsv`) không bao giờ bị dịch.
- Hộp thoại chọn/lưu file của hệ điều hành cũng theo ngôn ngữ đang chọn.

## Giao diện

**Duyệt**
- Mở file bằng hộp thoại của hệ điều hành, dán đường dẫn, hoặc chọn từ "Mở gần đây".
- Cây bên trái: 16 nhóm ItemType, số slot có tên / 512, chấm cam = số thay đổi chưa lưu.
- Tìm kiếm không cần dấu (`rong do` → "Mũ Rồng Đỏ"), hoặc theo toạ độ `7:1`, `#3585`.
- Lọc: slot có tên / tất cả / trống; đã sửa (chưa lưu), có cảnh báo, gần giới hạn byte (≥ 40), không phải UTF-8.

**Sửa**
- Enter, F2 hoặc nhấp đúp để sửa tên ngay trên bảng. Bộ đếm byte chạy theo từng
  ký tự gõ; quá 49 byte thì ô chuyển đỏ và không cho lưu.
- Enter / Tab: lưu và sang dòng dưới (dịch liên tục). Shift+Enter: lên dòng trên. Esc: huỷ.
- Lần sửa đầu tiên hỏi tên người dịch (nhớ trong trình duyệt), ghi kèm mỗi thay đổi.
- Undo/redo: Ctrl+Z, Ctrl+Y (hoặc Ctrl+Shift+Z), nút ↶ ↷. Undo được cả sau khi đã lưu.
- "Khôi phục tên gốc" trong khung chi tiết.

**Lưu** (Ctrl+S, "Lưu thành…" = Ctrl+Shift+S)
- Trước khi ghi: backup file cũ, kiểm tra lại checksum + từng tên, ghi vào file tạm rồi mới đổi tên.
- Nếu file trên đĩa bị thay đổi sau khi mở (Google Drive đồng bộ, người khác ghi...)
  thì báo xung đột và cho chọn: lưu thành file khác / ghi đè / huỷ.
- Game client đang giữ file → báo rõ để đóng game rồi lưu lại.

**Bản nháp**: mỗi lần sửa tự ghi `draft.json`. Tắt ngang cửa sổ dòng lệnh / trình
duyệt / mất điện → lần sau mở lại file sẽ được hỏi khôi phục. Nếu bỏ qua câu hỏi
mà sửa tiếp, nháp cũ được cất thành `draft-<thời gian>.json` chứ không bị ghi đè.

### Dữ liệu phụ cạnh file

```
Item.bmd
Item.bmd.mubmd/
  backups/Item-20260928-111300.bmd   bản trước mỗi lần lưu (giữ 20 bản mới nhất)
  changes.tsv                        nhật ký: Time, Translator, ItemType, ItemIndex, OldName, NewName
  draft.json                         thay đổi chưa lưu
```

Nếu `Item.bmd` nằm trong thư mục Google Drive dùng chung, thư mục `.mubmd` (có
thể tới ~14 MB backup) cũng sẽ được đồng bộ.

## Cấu trúc

```
src/core/     lõi đọc/ghi Item.bmd + errors.ts (mã lỗi) - không phụ thuộc server/UI
src/shared/   kiểu dữ liệu API dùng chung server <-> giao diện
src/server/   app.ts (API), session.ts (sửa/undo/nháp/lưu), storage.ts (ghi đĩa), filePicker.ts,
              main.ts (Bun.serve)
web/          giao diện Vue 3 (Vite, Tailwind 4, shadcn-vue, Pinia, vue-i18n)
  src/components/        AppTopbar, GroupSidebar, ItemToolbar, ItemGrid (cuộn ảo), InlineEditor, DetailPanel, AppDialogs…
  src/components/ui/     component shadcn-vue (chép vào dự án, sửa tự do; thêm bằng `npx shadcn-vue add <tên>` trong web/)
  src/composables/actions.ts   luồng thao tác (mở / sửa / lưu + hộp thoại, thông báo)
  src/stores/doc.ts      trạng thái file đang mở (8192 dòng trong shallowRef)
  src/lib/               api.ts, search.ts (tìm không dấu, lọc), dialogs.ts, storage.ts
  src/i18n/              cấu hình + locales/en.json, vi.json
scripts/      dev.ts (server + Vite), build-web.ts (Vite build -> build/web/assets.ts để nhúng), build-bin.ts
tests/        bun test (lõi, server, session, tìm kiếm, file ngôn ngữ); e2e/run.ts (Chrome thật)
```

API: `GET /api/state`, `GET /api/items`; POST `/api/open {path, discard?}`, `/api/pick`,
`/api/pick-save`, `/api/edit {slot, name, translator}`, `/api/revert`, `/api/undo`, `/api/redo`,
`/api/draft/restore`, `/api/draft/discard`, `/api/save {path?, force?}`.
Server chỉ nhận Host `localhost`/`127.0.0.1` (chống DNS rebinding) và POST phải
là JSON (trang web khác không gửi ngầm được).

## Định dạng Item.bmd (MuMain)

- 8192 bản ghi x 84 byte (16 ItemType x 512 index) + 4 byte checksum = 688.132 byte.
- Thân file mã hoá XOR khoá lặp `FC CF AB`; checksum `GenerateCheckSum2` khoá `0xE2F1`.
- Tên nằm ở 50 byte đầu mỗi bản ghi, UTF-8, kết thúc 0x00 → tối đa **49 byte**
  (tiếng Việt có dấu tốn 2-3 byte/ký tự).

## Lõi (`src/core`)

- `format.ts` — hằng số, XOR, checksum, chuyển đổi slot ↔ (ItemType, ItemIndex).
- `nameCodec.ts` — `checkName()` (chuẩn hoá NFC, đếm byte, báo lỗi/cảnh báo),
  `encodeName()`, `decodeName()`.
- `itemBmd.ts` — lớp `ItemBmd`: `parse()`, `entries()`, `setName()`, `toBytes()`.

Khác với `../tools/item_ts`:
- Tên quá 49 byte **bị từ chối** (`NameValidationError`) thay vì bị cắt ngầm.
- Chỉ ghi lại các slot đã đổi tên; không sửa gì thì file ra giống hệt từng byte.
- Tên không phải UTF-8 (dữ liệu gốc Nhật/Hàn) được đánh dấu `encoding: "unknown"`.
  Bun không có bộ giải mã Shift_JIS/EUC-KR nên nhánh dự phòng của tool cũ không
  thực sự chạy.

## Chạy test

```
bun run test         # unit test (lõi, server, session, tìm kiếm, file ngôn ngữ)
bun run test:e2e     # build giao diện rồi chạy e2e trên Chrome thật với bản sao data/Item.bmd (cả EN và VI)
bun run typecheck    # tsc (server/lõi) + vue-tsc (giao diện)
```

Test dùng `data/Item.bmd`, và nếu có `../tools/item_ts` + `../items.tsv` thì
đối chiếu kết quả nhập TSV với tool cũ (phải giống hệt từng byte, kể cả checksum).

## Quy ước code

Comment và log trong code viết bằng **tiếng Anh**. Chữ hiển thị cho người dùng nằm trong
`web/src/i18n/locales/*.json` (và chữ trên hộp thoại hệ điều hành trong `filePicker.ts`).
