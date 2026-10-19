# 工具集

知识库配套的本地小工具。**都是零依赖或极少依赖的 Python 脚本**，复制到自己的工作区即可用，不需要安装框架。

```
工具/
├── 联网搜索/
│   ├── ds_search.py            DeepSeek 搜索 / 抓取（全网检索，落盘成 Markdown）
│   └── 知乎检索/
│       ├── zhihu_search.py     知乎站内 / 全网 / 热榜 / 直答 / 额度
│       ├── zhihu_hot_digest.py 热榜逐条问题的高赞回答精选（日报用）
│       ├── README.md           详细用法
│       └── .env.example        密钥配置样例
└── PPT审核/
    ├── layout_check.py         PPT 版面静态预估（不用渲染，秒出结果）
    ├── render_check.py         PPT 版面渲染实测（转 PDF 量真实坐标）
    └── README.md              用法与已知坑
```

---

## 一、联网搜索

### `ds_search.py` —— DeepSeek 官方搜索 / 抓取

调 DeepSeek 的 Search / Fetch 接口，一次搜索返回结构化结果（含 rerank 相关性分、权威性分），可直接写成带 frontmatter 的 Markdown 丢进知识库。

```bash
export DEEPSEEK_API_KEY="sk-..."          # 或写进 工具/联网搜索/.env

python ds_search.py search "公共数据资源授权运营 实施规范" --site gov.cn --after 2026-07
python ds_search.py search "数据交易所 交易规模" --strict --json    # 只留优质结果
python ds_search.py fetch "https://www.nda.gov.cn/xxx.html" --save 输出/查询
python ds_search.py usage                                          # 看当日调用与花费
```

几个实用设计：

- **`--strict` 质量闸门**：`rerank_score >= 1.5` 且 `authority >= 3` 才留。用来识别「有结果但没答案」——长尾 query 常返回一堆壳页，分数会掉到 0.5~1.0。
- **费用记账**：脚本自记 `工具/.ds_usage.json`，按 0.005 元/次估算，`usage` 子命令可查。只有 200 且非空才计费，参数错误/无结果/超时不计费。
- **Fetch 防壳页**：返回 200 不代表抓到正文，404 页和失效链接也会返回 200 且照样计费。脚本默认拒绝正文 < 300 字的响应。

### `zhihu_search.py` / `zhihu_hot_digest.py` —— 知乎检索

走知乎开放平台接口（需要 Access Secret，见 `知乎检索/README.md`）。`zhihu_hot_digest.py` 是专门为「日报里带热门回答」做的：

```
热榜列表（标题 + 摘要）
  → 逐条拿 question id 站内搜索
  → 按 question id 严格对齐（防止标题相似串行）
  → 按赞同数取前 N 条 → 每个问题合成一句精炼 + 内联署名
```

关键点：**不要指望热榜接口直接给回答**，它只有标题和摘要。必须先拿 id 再回查。

---

## 二、PPT 审核

做 PPT 最容易翻车的地方不是美观，是**文字出格**——python-pptx 的文字溢出既不报错也不自动缩，只会静静画到框外。这两个脚本就是把这个环节从「目测」变成「测量」。

```bash
python 工具/PPT审核/layout_check.py 你的.pptx      # 静态预估，秒出
python 工具/PPT审核/render_check.py 你的.pptx      # 转 PDF 实测真实坐标
```

**交付前两个都必须 PASS；只过第一个不算过。** 静态预估是近似值，渲染实测才是真相。

README 里记了几条踩过的坑，做 PPT 前值得读一眼（中文行距会被放大约 1.15 倍、卡片要留 0.15in 内边距、底边安全距 ≥ 0.12in 等）。

---

## 三、使用规则

1. **密钥只走环境变量或本地 `.env`**，`.env` 一律进 `.gitignore`，绝不写进脚本、不提交到仓库。
2. **工具只读已有素材**，产出统一落到 `输出/查询/` 或 `原始素材/`，不覆盖人工整理过的文件。
3. **没查清楚有没有现成工具之前不要装新包**。这几个脚本刻意只用标准库，就是为了换机器能直接跑。
