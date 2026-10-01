# Lỗi đã biết trong MuMain (Localization)

Các lỗi dưới đây được tìm thấy khi chạy MuResx-editor (nay là MuMain-translator) trên
[sven-n/MuMain](https://github.com/sven-n/MuMain) ở commit `6dda3643` (2026-09-02). Có thể
chúng đã được sửa ở bản mới hơn: mỗi mục có cách **kiểm tra còn không**, cách sửa, và cách
kiểm tra lại sau khi sửa. Mọi đường dẫn đều tính từ thư mục gốc của checkout MuMain.

Ở commit đó, MuMain chưa có bản dịch tiếng Việt (`*.vi.resx`). Mục 4 nói về lỗi hay gặp khi
bản dịch được làm **ngoài** tool (bằng script, hoặc sửa tay) rồi mới mở bằng MuMain-translator.

| # | Lỗi | Ở đâu | Hậu quả |
|---|---|---|---|
| 1 | Danh sách ngôn ngữ trong Options thiếu `vi` (và mọi locale mới) | `src/source/UI/NewUI/Options/NewUIOptionWindow.cpp` | Có file dịch mà người chơi không chọn được |
| 2 | Key `Connecting to the server` khai báo 2 lần | `src/Localization/Game.en.resx` | Mất `legacy_id=470`; bản dịch có 2 bản thì bản tiếng Anh thắng |
| 3 | 11 câu sai tham số printf ở pl, de, pt, ja | `src/Localization/Game.*.resx` | Có thể hiện rác / crash khi dùng locale đó |
| 4 | Dấu `\` + xuống dòng thật thay cho chữ `\n` | bản dịch làm ngoài tool | Hiển thị sai |
fix| 5 | macOS / Linux: tooltip vật phẩm trống với chữ có dấu khi mở game từ Finder / launcher | `src/source/App/Platform/Windows/Winmain.cpp` (`setlocale`) | Tooltip chỉ còn ô trống |

MuMain-translator tự báo 4 loại đầu: mục 1 bằng badge đỏ "Chưa chọn được trong game" (bản desktop,
khi thư mục mở nằm trong checkout MuMain), mục 2 là `duplicate-key`, mục 3 là `printf-mismatch`,
mục 4 là `stray-backslash` / `newline-mismatch`.

---

## 1. Ngôn ngữ chưa có trong danh sách của cửa sổ Options

**Hiện tượng.** ResxGen build mọi `<Group>.<locale>.resx` nó tìm thấy, và
`tools/ResxGen/CppEmitter.cs` đã có tên hiển thị cho `vi` (`["vi"] = "Tiếng Việt"`). Nhưng
combo chọn ngôn ngữ trong game lấy từ một danh sách viết tay khác: `s_Languages` trong
`src/source/UI/NewUI/Options/NewUIOptionWindow.cpp`. Ở commit trên, danh sách này **không có
`vi`**: người chơi không chọn được Tiếng Việt; nếu config đã lưu `vi` thì
`FindCurrentLanguageIndex()` không tìm thấy và combo hiện English.

**Kiểm tra còn không.**

```sh
grep -n '"vi"' src/source/UI/NewUI/Options/NewUIOptionWindow.cpp   # không có dòng nào = còn lỗi
```

**Cách sửa.** Thêm một dòng giữa `uk` và `zh-TW` (danh sách: `en` trước, còn lại theo thứ tự chữ
cái; ký tự ngoài ASCII viết bằng `\u` như các dòng khác để MSVC đọc đúng):

```cpp
    { "uk",    L"\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430" }, // Українська
    { "vi",    L"Ti\u1ebfng Vi\u1ec7t" }, // Tiếng Việt
    { "zh-TW", L"\u7e41\u9ad4\u4e2d\u6587" }, // 繁體中文
```

`s_NumLanguages` tự tính theo `sizeof`, không phải sửa gì thêm. Với một ngôn ngữ **mới** (chưa
có trong `CppEmitter.cs`), phải thêm cả tên hiển thị vào `tools/ResxGen/CppEmitter.cs`. Bấm vào
badge của MuMain-translator để lấy đúng các dòng cần thêm (có nút copy) và vị trí thêm.

**Kiểm tra sau khi sửa.** Build lại, mở Options → Language: có "Tiếng Việt"; chọn xong, chuỗi đổi
sang tiếng Việt và lần mở game sau vẫn giữ.

---

## 2. Key `Connecting to the server` khai báo 2 lần

**Hiện tượng.** Trong `src/Localization/Game.en.resx` có hai entry cùng tên: bản gốc (chuyển từ
Text.bmd, có `legacy_id=470`), và một bản thêm lại sau này (commit `9263b308` "Add auto-reconnect
on in-game connection loss"), không có `legacy_id`:

```xml
  <data name="Connecting to the server" xml:space="preserve">
    <value>Connecting to the server</value>
    <comment>legacy_id=470</comment>
  </data>
  ...
  <data name="Connecting to the server" xml:space="preserve">
    <value>Connecting to the server</value>
  </data>
  <data name="Logging in" xml:space="preserve">
```

ResxGen (`ResxLoader.ReadResx`: `result[name] = …`) giữ **bản sau cùng**, và không báo lỗi (nó
chỉ kiểm tra trùng identifier giữa các key **khác nhau**, và trùng `legacy_id`), nên:

- `legacy_id=470` bị mất: `I18N::Game::Lookup(470)` trả về chuỗi rỗng (`LookupSlot(470)` trả
  về `nullptr`), ảnh hưởng những chỗ lấy chuỗi theo số (dữ liệu cũ dùng chỉ số GlobalText);
- một bản dịch được tạo bằng cách chép file en (rồi dịch từng câu) cũng có 2 bản: nếu chỉ bản đầu
  được dịch thì bản thứ hai (còn tiếng Anh) thắng, và `I18N::Game::ConnectingToTheServer` (dùng
  trong `ReconnectDialog.cpp`, `ServerSelWin.cpp`) hiện tiếng Anh dù đã dịch.

**Kiểm tra còn không.**

```sh
cd src/Localization
grep -c 'name="Connecting to the server"' Game.*.resx   # 2 = còn lỗi trong file đó
```

**Cách sửa.** Xoá bản **thứ hai** (không có `legacy_id`) trong `Game.en.resx` và trong mọi bản
dịch cũng có 2 bản. Hai bản cùng key nên identifier C++ vẫn là `ConnectingToTheServer`, code
không phải sửa. Nếu bản dịch chỉ dịch bản thứ hai, hãy chép chữ đã dịch sang bản đầu trước.

```sh
cd src/Localization
perl -0pi -e 's/\n  <data name="Connecting to the server" xml:space="preserve">\n    <value>[^<]*<\/value>\n  <\/data>(?=\n  <data name="Logging in")//' Game.en.resx
# và mỗi Game.<locale>.resx mà lệnh grep ở trên báo 2
```

(Lệnh chỉ khớp bản không có comment đứng ngay trước `Logging in`, tức bản thứ hai.)

**Kiểm tra sau khi sửa.**

```sh
grep -c 'name="Connecting to the server"' Game.en.resx   # 1
grep -A2 'name="Connecting to the server"' Game.en.resx  # còn legacy_id=470
```

Nên đề xuất upstream thêm kiểm tra trùng key vào ResxGen (`ReadResx` báo lỗi khi `name` đã có),
để lỗi này dừng build thay vì âm thầm mất chuỗi.

---

## 3. Lỗi printf ở các bản dịch có sẵn

Ở commit trên, **build không có lỗi** (24 key của `Game.en` không có identifier và được ResxGen
bỏ qua; chúng là chữ Hàn bị hỏng mã, game không bao giờ hiện). Nhưng các locale có sẵn có 11 câu
mà tham số printf không khớp bản en. Những câu này được đưa vào `swprintf`, nên sai tham số có
thể làm hiện rác hoặc crash game khi người chơi dùng locale đó:

| Locale | Dòng | en | Bản dịch | Vấn đề |
|---|---|---|---|---|
| pl | 1378 | `(%s) stat %d points have been generated.` | `Wygenerowano %d pkt statystyki (%s).` | đảo thứ tự `%s`/`%d` |
| de | 3321, 3369, 3373 | `… 100%% winning card …` | `… 100%-Gewinnkarte …` | `%-G` bị hiểu là một conversion số thực |
| pt | 11004 | `You need more %%s to purchase this item.` | `Você precisa de mais% %s …` | thêm một `%s` thật |
| ja | 2978, 3134, 10702, 10954, 10050 | có `%d` / `%s +%d` | không có | bản ja lệch dòng (câu dịch không khớp câu en) |
| ja | 9882 | `%d sent you a gift.` | `%s さんからのプレゼントです。` | `%d` thành `%s` |

Ngoài ra có khoảng 70 cảnh báo `percent-style` (en viết `%%`, bản dịch viết `%`, hoặc ngược lại)
ở de, pt, ru, es, uk, zh-TW, ja, id.

**Kiểm tra còn không.** Mở thư mục `src/Localization` bằng MuMain-translator với locale đó, chọn
*Vấn đề → Lỗi*. Số dòng có thể lệch nếu file đã đổi; tìm theo câu en.

---

## 4. Bản dịch làm ngoài tool: `\` + xuống dòng thay cho `\n`

**Hiện tượng.** Trong các file en, xuống dòng trong câu được viết bằng **2 ký tự** `\n` (game tự
đổi khi hiển thị):

```xml
<value>An item that lets you enjoy MU for 30 days.\nCan only be used from the MU Online website.</value>
```

Một bản dịch đi qua script (đổi `\n` thành xuống dòng thật, rồi "sửa" lại bằng cách thêm `\`
trước mỗi xuống dòng) sẽ có dạng:

```xml
<value>Vật phẩm cho phép bạn chơi MU trong 30 ngày.\
Chỉ có thể dùng từ trang web MU Online.</value>
```

ResxGen chép nguyên giá trị sang C++ (`\` → `\\`, xuống dòng → `\n`), nên trong game câu có một
dấu `\` thừa và xuống dòng thật, không phải `\n` như code hiển thị mong đợi. Một bản dịch tiếng
Việt làm theo cách này đã có 16 câu bị lỗi, đúng ở những chỗ en có `\n`: `legacy_id` 6, 7, 8
(`Error2…`, `Error3…`, `Error4…`) và 2973–2985 (mô tả vật phẩm Item Shop).

**Kiểm tra.** MuMain-translator báo `stray-backslash` + `newline-mismatch` cho từng câu. Hoặc:

```sh
cd src/Localization
grep -c '\\$' Game.vi.resx   # số dòng kết thúc bằng \ (phải là 0)
```

**Cách sửa.** Đổi mọi cặp "`\` + xuống dòng" thành chữ `\n`:

```sh
cp Game.vi.resx Game.vi.resx.bak
perl -0pi -e 's/\\\n/\\n/g' Game.vi.resx
```

Sau khi sửa, số chữ `\n` của mỗi câu phải bằng câu en (MuMain-translator không còn báo), và
`grep -c '\\$'` ra 0. Trong MuMain-translator, xuống dòng luôn được gõ là `\n` nên lỗi này không xảy
ra với câu dịch trong tool.

## 5. macOS / Linux: tooltip vật phẩm trống khi chọn tiếng Việt

**Triệu chứng.** Chọn tiếng Việt, rê chuột vào vật phẩm: chỉ hiện một ô nhỏ, không có chữ nào. Mở game từ
Terminal thì lại hiện bình thường.

**Nguyên nhân.** Phần lớn chữ trong game (tooltip vật phẩm, các dòng chỉ số) được ghép bằng `mu_swprintf`, tức
`std::swprintf` của libc. Trên macOS / Linux, hàm này trả về -1 (EILSEQ) và để chuỗi rỗng khi gặp bất kỳ ký tự
ngoài ASCII nào, nếu `LC_CTYPE` không phải một locale UTF-8. `WinMain` gọi `setlocale(LC_ALL, "")`, nhưng app mở từ
Finder / Dock / launcher không có biến `LANG`, nên kết quả là locale `"C"`. Windows không bị (MSVC xử lý chuỗi
rộng không phụ thuộc locale).

**Cách sửa** (trong `src/source/App/Platform/Windows/Winmain.cpp`, ngay sau `setlocale(LC_ALL, "")`): ngoài
Windows, nếu `LC_CTYPE` chưa phải UTF-8 thì đặt riêng `LC_CTYPE` sang `C.UTF-8` / `en_US.UTF-8` / `UTF-8` (chỉ
`LC_CTYPE`, để cách đọc / in số không đổi):

```cpp
#ifndef _WIN32
    {
        const char* ctype = setlocale(LC_CTYPE, nullptr);
        if (ctype == nullptr || (strcasestr(ctype, "UTF-8") == nullptr && strcasestr(ctype, "UTF8") == nullptr))
            for (const char* l : { "C.UTF-8", "en_US.UTF-8", "UTF-8" })
                if (setlocale(LC_CTYPE, l) != nullptr) break;
    }
#endif
```

Lỗi này ảnh hưởng mọi ngôn ngữ có dấu (không riêng tiếng Việt), nên đáng gửi lên MuMain gốc.
