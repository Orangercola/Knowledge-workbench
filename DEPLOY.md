# DEPLOY.md

> 将此文件内容复制到 WorkBuddy 对话中，让 AI 帮你完成工作台的部署配置。

---

## AI 部署提示词

```
你是知识工作台部署助手。我在 GitHub 上下载了 workbench-forge 仓库的 zip 包，
已经解压到本地。请依次帮我完成以下任务：

### 第一步：信息收集
请询问我以下信息：
1. 我的名字（将显示在工作台界面中）
2. 我想把知识库放在哪个目录（例如 ~/Documents/MyKB）

### 第二步：知识库初始化
1. 把「知识库骨架」目录下的所有文件和子目录（日常/_模板.md、日常/_分类表.md 等）
   复制到我指定的知识库目录
2. 如果该目录尚不存在，先创建
3. 告诉我如何安装 Obsidian（obsidian.md）并打开这个知识库目录作为仓库
   - Obsidian 用于日常编辑 Markdown、创建[[双向链接]]、管理 Frontmatter 元数据
   - 如果我不想装 Obsidian，告诉我可以用 VS Code / Typora / 记事本代替

### 第三步：代码适配
在「工作台/」目录中，把所有代码文件里的占位符替换为我的实际信息：
- __USER_NAME__ → 我的名字
- __KB_ROOT__ → 我的知识库目录路径（注意 Windows 反斜杠转义）
- __AI_AUTOMATION_ID__ → 暂时保留占位符，后续再配置

### 第四步：启动验证
1. 用 node 工作台/server.js 启动服务
2. 打开浏览器访问 http://localhost:5173
3. 确认页面加载正常，侧边栏显示我的名字

### 第五步（可选）：WorkBuddy 自动化
如果我有 WorkBuddy 账号：
1. 帮我创建一个自动化：「工作台 AI 对话服务」
   - 用途：监听「输出/查询/inbox/」目录，自动读取提问并回答
2. 帮我创建一个自动化：「每日待办提醒」
   - 用途：每天早上读取「日常/当天日期.md」，推送待办和每日工作
3. 把 AI 对话服务的 automation ID 更新到 server.js 的 __AI_AUTOMATION_ID__ 中

### 第六步：收尾
1. 确认 http://localhost:5173 可正常访问
2. 告诉我已部署完成，可以开始使用
```

---

## 手动部署（无需 AI）

如果你的 AI 不可用，也可以手动完成上述步骤：

```bash
# 1. 复制知识库骨架
cp -r 知识库骨架/* ~/Documents/MyKB/

# 2. 设置知识库路径环境变量
# Windows PowerShell:
$env:WB_KB_ROOT = "C:\Users\你的用户名\Documents\MyKB"
# macOS / Linux:
export WB_KB_ROOT="$HOME/Documents/MyKB"

# 3. 改界面名字（用编辑器在以下文件中搜索替换 __USER_NAME__ → 你的名字）
#    - 工作台/index.html
#    - 工作台/app.js
#    - 工作台/style.css
#    - 工作台/fx.js

# 4. 启动
node 工作台/server.js
```
