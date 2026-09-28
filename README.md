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
| 4 | Xuất/nhập TSV, cột tham chiếu, file dự án + trạng thái dịch, gộp bản dịch nhiều người | Chưa |
| 5 | Thuật ngữ, so sánh file, đóng gói .exe/.app | Chưa |

## Chạy

```
bun install
bun run dev              # build giao diện + mở data/Item.bmd, tự mở trình duyệt
bun run start            # như trên nhưng chưa mở file nào
bun run build            # file chạy độc lập vào dist/ (Windows x64, macOS arm64/x64)
```

File chạy độc lập: `MuBMD-editor [đường/dẫn/Item.bmd] [--port 4817] [--no-open]`.
Nếu cổng 4817 bận, công cụ tự thử cổng kế tiếp.

**Lưu ý:** thư mục này nằm trên Google Drive - `dist/` (~230 MB) và
`node_modules/` sẽ bị đồng bộ lên Drive nếu để ở đây. Nên build ra rồi chuyển
file chạy đi chỗ khác, hoặc cho Drive bỏ qua 2 thư mục đó.

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
src/core/     lõi đọc/ghi Item.bmd (không phụ thuộc server/UI)
src/shared/   kiểu dữ liệu API dùng chung server <-> giao diện
src/server/   Bun.serve: app.ts (API), session.ts (sửa/undo/nháp/lưu), storage.ts (ghi đĩa), filePicker.ts, main.ts
web/          giao diện TypeScript thuần: main.ts, search.ts, virtualList.ts, ui.ts (hộp thoại, thông báo)
scripts/      build-web.ts (sinh build/web/assets.ts), build-bin.ts
tests/        bun test
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
bun run test         # build giao diện rồi chạy bun test
bun run typecheck
```

Test dùng `data/Item.bmd`, và nếu có `../tools/item_ts` + `../items.tsv` thì
đối chiếu kết quả nhập TSV với tool cũ (phải giống hệt từng byte, kể cả checksum).
