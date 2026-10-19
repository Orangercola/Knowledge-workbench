# PPT 版面审核工具

用于在 PPT 交付前，**用测量代替目测**，避免文字出格、贴边、越出页面。

## 两个脚本

### 1. `layout_check.py` —— 静态预估（快，不用渲染）
按字符宽度估算每段文字的排版行数，算出所需高度，与实际框高比对。

```bash
python layout_check.py <pptx路径>
python layout_check.py <pptx路径> -v      # 逐框打印 可用/需要 高度
```

检测项：文字超出文本框高度、形状越出页面。

### 2. `render_check.py` —— 渲染实测（准，需转 PDF）
先调 LibreOffice 把 PPTX 转成 PDF，再用 pymupdf 逐 span 取真实坐标，
判断每段文字是否越出「包含它中心点的最小形状」（即所属卡片）或越出页面。

```bash
python render_check.py <pptx路径>
```

两个脚本都输出 `PASS` / `FAIL` 与具体条目（形状 id、坐标、超标量）。

## 使用约定

**任何 PPT 产出，交付前必须同时满足：**

1. `layout_check.py` → PASS
2. `render_check.py` → PASS

如果只过第一个、没过第二个，以第二个为准——静态预估是近似值，**渲染实测才是真相**。

## 已知坑（做 PPT 时要注意）

- **中文行距会放大**：设定 `line_spacing=1.25` 时，LibreOffice/PPT 对中日韩文字的实际行距约为 `1.25 × 1.15`，比目测的更占地方。预留余量时按 1.15 倍放大估算。
- **卡片要留内边距**：文字框四周至少留 0.15in，否则渲染后容易贴边。
- **文本框默认不裁剪**：python-pptx 的文本框溢出不会报错、不会自动缩小，只会静静地画到框外，所以必须靠工具查。
- **多形状合并成块**：pymupdf 的 `blocks` 会把同一水平线的不同形状文字合并，导致误判，`render_check.py` 因此改用 `spans`。
- **底边安全距**：文字底部距所属卡片底边建议 ≥ 0.12in。
