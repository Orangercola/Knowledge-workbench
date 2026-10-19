# 知乎检索工具

调用**知乎开放平台**（[developer.zhihu.com](https://developer.zhihu.com)）的内容接口，检索知乎站内与全网内容。
结果以 Markdown 输出，可直接落盘进你的知识库，供后续引用 / 摄入 / 研究。

- 零依赖：只用 Python 标准库（`urllib`），无需 `pip install`。
- 只读：不写知识库任何既有文件，仅在 `--save` 指定时新建检索结果文件。
- 密钥安全：Access Secret 从环境变量读取，另在本地 `.env` 留副本；均已被 `.gitignore` 忽略。

---

## 一、配置与密钥管理

> 脚本的读取优先级：`--secret` 参数 → 环境变量 `ZHIHU_ACCESS_SECRET` → 同目录 `.env` → 知识库根 `.env`。
> 首次使用按下述步骤配置一次即可；`.env` 已列入 `.gitignore`，不会被提交。

**配置步骤：**

1. 登录知乎开放平台 → 个人中心 → 复制 **Access Secret**
   <https://developer.zhihu.com/profile>
2. 设置环境变量（任选其一）：

   **Git Bash（当前会话）**
   ```bash
   export ZHIHU_ACCESS_SECRET="你的Access Secret"
   ```

   **PowerShell（当前会话）**
   ```powershell
   $env:ZHIHU_ACCESS_SECRET="你的Access Secret"
   ```

   **永久设置（Windows，重开终端后生效）**
   ```powershell
   setx ZHIHU_ACCESS_SECRET "你的Access Secret"
   ```

3. 验证是否配置成功：
   ```bash
   python zhihu_search.py quota
   ```

---

## 二、用法

脚本路径：
- `工具/联网搜索/知乎检索/zhihu_search.py` —— 主工具（搜索 / 全网 / 热榜 / 直答 / 额度）
- `工具/联网搜索/知乎检索/zhihu_hot_digest.py` —— 热榜高赞回答精选（日报用，复用前者的鉴权）

### 1. 知乎站内搜索
```bash
python zhihu_search.py search "数据要素" --count 10
python zhihu_search.py search "公共数据授权运营" --save 输出/查询
```

### 2. 全网搜索（整合知乎站内 + 全网权威信源）
```bash
python zhihu_search.py web "可信数据空间" --count 20
python zhihu_search.py web "数据要素×" --db realtime          # 只要实时库
python zhihu_search.py web "数据资产入表" --host gov.cn        # 限定站点
python zhihu_search.py web "数据条例" --since 2026-01-01 --until 2026-10-14
python zhihu_search.py web "数据要素" --save 输出/查询
```

### 3. 知乎热榜
```bash
python zhihu_search.py hot --limit 30
python zhihu_search.py hot --save 原始素材/热点
```

### 4. 知乎热榜 · 高赞回答精选（日报用）
热榜接口只给标题和一句摘要，**不含回答**。本脚本对榜单里每个问题再做一次站内检索，
按 `question id` 严格对齐，取出**该问题下的回答**（按赞同数排序选取，但输出**不展示赞同数**——赞同只反映热度，不代表观点分布）：
```bash
python zhihu_hot_digest.py                             # 热榜 12 条，每问题取前 2 条回答
python zhihu_hot_digest.py --limit 15 --top 3           # 热榜 15 条，每问题取前 3 条
python zhihu_hot_digest.py --json                       # 结构化 JSON（供日报生成消费，含赞同数等原始字段）
python zhihu_hot_digest.py --full                       # 回答正文不截断
python zhihu_hot_digest.py --save 原始素材/热点          # 落盘 Markdown
```
- 输出形态：`💡 回答要点…（回答人 作者 · [原文](链接)）` —— 同一问题下不同回答的要点合成一行、署名紧跟各自观点之后（原格式的单列来源行已取消），另附原文摘录。
- 成本：每条问题 1 次站内搜索（默认 12 条 → 12 次/日，占 5000 额度的 0.24%）。
- 降级：某问题若检索不到同问回答（新问题等），该条标注"未检索到"并保留问题行，不阻断整批、不编造观点。
- 用途：每日热点日报的「知乎热榜 · 高赞回答精选」版块据此为每条问题写一段精炼描述（答题观点后标注回答人）。

### 5. 知乎直答（生成式回答，可选）
```bash
python zhihu_search.py ask "什么是可信数据空间" --model zhida-thinking-1p5
```
模型档位：`zhida-fast-1p5`（快速）/ `zhida-thinking-1p5`（深度思考）/ `zhida-agent`（智能思考）。

### 6. 查询剩余免费额度
```bash
python zhihu_search.py quota
```

### 通用选项
| 选项 | 说明 |
|---|---|
| `--json` | 输出原始 JSON（便于程序处理） |
| `--save DIR` | 将 Markdown 结果保存到目录（自动按日期命名） |
| `--secret S` | 本次临时传入密钥（不推荐，优先用环境变量） |

---

## 三、接口对照表（官方文档）

| 子命令 | HTTP 端点 | 单次上限 | 说明 |
|---|---|---|---|
| `search` | `GET /api/v1/content/zhihu_search` | 10 | 知乎站内内容搜索 |
| `web` | `GET /api/v1/content/global_search` | 20 | 全网搜索（`Filter` 支持 host / publish_time） |
| `hot` | `GET /api/v1/content/hot_list` | 30 | 知乎热榜 |
| `ask` | `POST /v1/chat/completions` | — | 知乎直答 |
| `quota` | `GET /api/v1/quota` | — | 当日免费额度 |

**鉴权**：请求头 `Authorization: Bearer <Access Secret>` + `X-Request-Timestamp`（秒级 Unix 时间戳）+ `Content-Type: application/json`。

**返回结构**：`Code`（0 成功）/`Message`/`Data`。`Data.Items[]` 含 `Title`、`ContentType`、`ContentText`、`Url`、`VoteUpCount`、`CommentCount`、`AuthorName`、`AuthorityLevel`（1 低 ~ 4 超高权威）、`EditTime` 等。

**错误码**：`0` 成功 · `10001` 参数错误 · `20001` 鉴权失败 · `30001` 频率限制 · `30003` 风控拒绝 · `90001` 内部错误。

**额度（2026-10-14 实测）**：按**北京时间 00:00** 重置；实时剩余量以 `python zhihu_search.py quota` 为准。

| 接口 | 每日上限 |
|---|---|
| 知乎搜索 / 全网搜索 | **5000** |
| 热榜 | 100 |
| 问题发现 / 直答 | 100 |
| 知识库 | 500 |
| 知识库检索 / 创作能力 | 200 |
| 知乎用户数据 | 10000 |
| 小工具 | 10 |

脚本内置**当日调用计数**（`.zhihu_usage.json`，已 gitignore）：达到上限 80% 时在 stderr 提示、达到上限时警告，便于防范异常调用。

---

## 四、与知识库的衔接建议

- 检索结果默认输出带 YAML frontmatter 的 Markdown，可直接放入：
  - `输出/查询/` —— 临时查询结果
  - `原始素材/热点/` —— 热榜日报、热榜高赞精选（`YYYY-MM-DD-知乎热榜精选.md`）
- 有价值的检索结果按 `AGENTS.md`「操作 1：摄入」流程编译进知识层。
- 引用时请回原文核对（接口返回的 `Url` 带溯源参数）。

---

## 五、故障排查

| 现象 | 处理 |
|---|---|
| `Code=20001 鉴权失败` | 检查 `ZHIHU_ACCESS_SECRET` 是否正确、是否含多余空格 |
| `Code=30001 频率限制` | 触达频率上限，稍后重试；用 `quota` 查剩余额度 |
| `Code=30003 风控拒绝` | 不要立即重试，稍后联系平台确认 |
| 中文乱码 | 脚本已强制 UTF-8 输出；若仍异常，运行前设 `PYTHONIOENCODING=utf-8` |
| 网络异常 | 检查网络/代理；必要时设 `ZHIHU_BASE_URL` 指向网关 |

---

_建立于 2026-10-14 · 依据知乎开放平台官方接口文档（HTTP API / 端点覆盖）_
