# AWDPI 网站

awdpi.org 的新网站，中英双语，用 [Hugo](https://gohugo.io/)（0.169 或更新的 extended 版）生成静态页面。

```bash
hugo server        # 本地预览：http://localhost:1313/
hugo               # 生成整站到 public/
```

## 目录结构

```
hugo.toml              网站设置：语言、导航菜单、页脚菜单、preview 开关
content/
  en/                  英文页面
  zh-cn/               中文页面（和英文同名的文件就是彼此的翻译）
  stories/             两种语言共用的文章（多数文章只有中文版）
data/organisations.toml  四个注册主体的法律信息
data/donate.toml         捐赠页：各国的开通状态、币种、嵌入的捐赠工具、外部公益平台和项目
data/partners.toml       关于页的合作伙伴标志（文件在 static/img/partners/）
i18n/en.toml, zh-cn.toml  模板里的界面文字（页头、页脚、按钮）
layouts/               模板
static/
  css/style.css        全站样式
  js/app.js            全站脚本
  fonts/  img/         字体和设计用图
  media/stories/       文章里的图片
  reports/             研究报告和影响力报告 PDF
  handbooks/           普法手册 PDF
```

每个页面只写自己的正文，页头、页脚、`<head>` 都来自 `layouts/`：

| 文件 | 作用 |
| --- | --- |
| `layouts/baseof.html` | 每个页面的外框 |
| `layouts/_partials/head.html` | `<head>`：标题、描述、字体、样式 |
| `layouts/_partials/header.html` | 页头：导航、语言切换、一键退出 |
| `layouts/_partials/footer.html` | 页脚 |
| `layouts/_partials/legal-line.html` | 页脚的法律信息一行 |
| `layouts/legal/` | 法律信息页、隐私声明、隐私政策和使用条款页 |
| `layouts/stories/` | 文章页和"全部文章"列表 |
| `layouts/research/` | 研究报告页 |

## 网址

| 网址 | 文件 |
| --- | --- |
| `/`、`/about/`、`/focus-areas/`、`/avoice/`、`/get-help/`、`/support-us/` | `content/<语言>/*.html` |
| `/research/`、`/research/<id>/` | `content/<语言>/research/` |
| `/stories/`、`/stories/<名称>/`、`/stories/all/` | `content/<语言>/stories/`、`content/stories/` |
| `/organisations/`、`/uk/`、`/be/`、`/us/`、`/au/` | `content/en/`，内容来自 `data/organisations.toml` |
| `/uk/privacy/`、`/be/privacy/`、`/us/privacy/`、`/au/privacy/` | `content/en/<id>/privacy.md` |
| `/privacy/`、`/terms/` | `content/<语言>/privacy.md`、`terms.md` |
| `/donate/`、`/donate/us/`、`/donate/uk/`、`/donate/be/`、`/donate/au/` | `content/<语言>/donate/`，设置在 `data/donate.toml` |

中文页面在 `/zh-cn/` 下。旧网站的 `/focus_areas/`、`/aids/`、`/support/` 会自动跳转到新地址；文章、研究报告、PDF 的网址和旧网站相同。

## 常见修改

**改某个页面的文字**：编辑 `content/en/` 或 `content/zh-cn/` 里对应的文件。两种语言要分别改。

**改页头或页脚**：文字在 `i18n/`，链接在 `hugo.toml` 的菜单里，结构在 `layouts/_partials/`。

**改主体的法律信息**：只改 `data/organisations.toml`，文件开头有填写规则。法律信息页、页脚、关于页卡片和隐私声明里的名称编号都会一起更新。

**增删合作伙伴**：编辑 `data/partners.toml`，标志文件放进 `static/img/partners/`（优先 SVG，其次透明背景的 PNG）。暂时没有标志的，`logo` 留空，页面会显示文字标志。

**开通某个国家的捐赠**：在 `data/donate.toml` 里把这个国家的 `status` 改成 `"open"`，把捐赠工具（例如美国的 Givebutter）给的嵌入代码粘贴到 `embed`，外部公益平台的活动（例如 GoFundMe）加到 `campaigns`。文件开头列了开通前要做的事，包括更新隐私声明。页面上的"捐赠须知"在 `content/<语言>/donate/<国家>.md`，由各主体提供合规写法；中文页下方会自动附上英文原文。

**改 Avoice 聊天窗口**：结构在 `layouts/_partials/chat.html`，文字在 `i18n/`（以 `chat` 开头），样式和脚本在 `static/css/style.css` 和 `static/js/app.js` 的"Avoice chat"部分。聊天发送到 `hugo.toml` 里 `chatEndpoint` 指定的 Avoice 中转服务（AWS 斯德哥尔摩，仓库 `awdp-avoice/avoice-chat-relay`），对话只保存在当前页面里，不写 Cookie 或浏览器存储。中转服务只接受它列出的网址（awdpi.org、本预览站和本地预览）。独立聊天页是 `content/<lang>/chat.html`（front matter 里 `chatPage: true`），聊天在这个页面上铺满窗口；小窗右上角的展开按钮会让聊天铺满窗口并把地址换成这个页面，对话保留，返回键回到小窗。旧网站的聊天窗口是从这里移植的，改动后要同步到 `avoice-site-hugo`。

**加一篇文章**：在 `content/stories/` 新建 `<名称>.html`（或 `.md`），图片放进 `static/media/stories/<名称>/`：

```
---
title: "文章标题"
date: 2026-11-20
image: /media/stories/<名称>/cover.webp
---
正文
```

文章会同时出现在中英两种语言下。如果某篇文章两种语言内容不同，就分别放进 `content/en/stories/` 和 `content/zh-cn/stories/`。

**加一份研究报告**：PDF 放进 `static/reports/`，封面放进 `static/img/report-<id>.jpg`，再在 `content/en/research/` 和 `content/zh-cn/research/` 各加一个 `<id>.md`（照现有文件的格式），并在两种语言的研究页（`research/_index.html`）列表里加一行。

## 上线前

1. `hugo.toml` 里把 `preview` 改成 `false`：去掉每页的 `noindex`，`robots.txt` 允许抓取并给出 sitemap。
2. 绑定域名 awdpi.org 时，在 GitHub 仓库 Settings > Pages 设置自定义域名（发布由 `.github/workflows/deploy.yml` 负责）。
3. 分享图 `static/share.jpg` 还没有，社交媒体分享时不会显示图片。
4. 隐私声明写明的存储地点要先落实：英国和比利时机构的邮件和个案记录存放在欧盟，美国机构的存放在美国，澳大利亚机构的存放在澳大利亚。
5. 各国隐私声明（`content/en/<id>/privacy.md`）开头注释里列出的事项，由各机构逐项确认，包括保存期限和回复时限。
6. "支持我们"页的留言表单接通后，在隐私页（`content/en/privacy.md` 和中文版）写明投递留言的服务。
7. 隐私页"Avoice AI 助手"一节开头注释里列出的事项要确认：由哪家机构运营助手和持有 AWS 账号、UK GDPR 第 9 条的处理条件、DPIA。

整站约 1.3 GB，其中文章图片约 1.1 GB（旧网站发布的内容约 1.5 GB）。
