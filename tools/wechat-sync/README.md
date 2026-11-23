# 公众号文章同步

宣传组发完公众号文章后，用浏览器书签把文章同步到网站。微信没有接口能读取已群发的文章，微信也会拦截服务器直接打开文章网页，所以由编辑在自己的浏览器里读取文章，再交给服务器处理。

```
编辑的浏览器（公众号文章页）
  └─ 书签“同步到官网”：读取标题、发布时间、封面和正文，提交到内部表单
内部表单（AWS 斯德哥尔摩，堆栈 awdpi-wechat-sync）
  └─ 编辑核对信息，确认分类（AI 预先选好），选原创或转载，输入团队密码 → 存入 S3，启动 GitHub 工作流
GitHub 工作流 wechat-import.yml
  └─ 下载图片并转成 WebP，清理正文，生成 content/stories/<名称>.html，检查网站能生成，提交到 main，发布网站
```

编辑看到的使用说明在内部表单的首页上，地址是堆栈输出的 `Endpoint`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `aws/src/bookmarklet.js` | 书签脚本。首页把它变成书签网址，改动后重新部署堆栈，编辑要重新拖一次书签 |
| `aws/src/index.mjs` | 内部表单：首页、核对页、提交、进度页 |
| `aws/src/classify.mjs` | 用 AI 建议分类和卡片介绍（AWS 斯德哥尔摩的 DeepSeek V3.2） |
| `classify-all.mjs` | 给已有的全部文章分类 |
| `aws/template.yaml` | AWS 资源：HTTP API、Lambda、S3 桶、GitHub 工作流用的角色 |
| `import.mjs` | 导入程序，由工作流运行 |
| `layout.mjs` | 让手机排版在网页上不错位 |
| `status.sh` | 工作流写进度，编辑的进度页会显示 |
| `../../.github/workflows/wechat-import.yml` | 导入工作流 |

## 导入时做什么

- 只接受 AWDPI 公众号（`__biz` 为 `Mzg3MjY5ODAyNA==`）的文章，表单和导入程序各检查一次。
- 去掉只在微信里有用的内容：脚本、公众号名片、小程序卡片，以及旧网站导入时去掉的样式标记、正文顶部的标题图、"END"、"Avoice海外华人女性保护项目介绍链接"。视频和音频换成指向公众号原文的链接。
- 公众号的排版是按手机屏幕设计的，网页上更宽，所以做两处调整（`layout.mjs`）：图片恢复编辑设置的宽度（微信会把它换成编辑电脑上量到的像素宽度）；图文并排的一栏里，图片用负的下边距往下伸出 10 像素以上、而且下面没有别的内容要叠上来的，把这个边距去掉，否则网页上图片会压住下一段文字。
- 下载正文里的所有图片，包括背景图和 SVG 里的图片，转成 WebP：大于 50 KB 的有损压缩（质量 60），小 PNG 无损，其他小图质量 80；转换后反而更大的保留原图。
- 每张图片只存一份，规则见仓库 README 的"加一篇文章"。
- 文章名称和旧导入一样：发布日期（北京时间）加标题 SHA-256 的前 4 位，例如 `20261118-1a2b`。front matter 里记下 `wechat_id`，同一篇文章再提交时替换原来那篇，网址不变。
- 分类：核对页上的下拉框预先选好 AI 建议的分类，编辑确认或改掉。AI 看的是标题和正文开头，分类和定义从 `data/story_categories.json` 读，改了这个文件最多 5 分钟后核对页就用新的。AI 调用失败时下拉框留空，由编辑自己选。
- 卡片介绍（`description`）：编辑在公众号后台写了摘要的，用摘要；没写的（微信会把正文开头当摘要），用 AI 从正文里原样摘的一两句。AI 摘的句子要在正文里找得到才会用，不会出现 AI 自己写的话。
- 编辑选了"转载"的，必须勾选已获授权才能提交，文章的 front matter 里会有 `reprint: true`。
- 已有中英文单独版本（`content/<语言>/stories/`）的文章不会被覆盖，要手动更新。

## 管理

部署或更新 AWS 部分（需要 AWS CLI 和 SAM CLI，`awdpi` SSO 账号）：

```bash
cd tools/wechat-sync/aws
SAM_CLI_TELEMETRY=0 AWS_PROFILE=awdpi sam deploy
```

团队密码存在 SSM 参数 `/awdpi/wechat-sync/password`（SecureString）。查看或更换：

```bash
aws ssm get-parameter --profile awdpi --region eu-north-1 --name /awdpi/wechat-sync/password --with-decryption --query Parameter.Value --output text
aws ssm put-parameter --profile awdpi --region eu-north-1 --name /awdpi/wechat-sync/password --type SecureString --overwrite --value '新密码'
```

表单启动工作流用的 GitHub 令牌存在 `/awdpi/wechat-sync/github-token`（SecureString）。令牌只需要这个仓库的 Actions 读写权限。没有令牌或令牌失效时，提交仍会保存，进度页显示"已收到，管理员会手动处理"，管理员在 Actions 页面手动运行 "Import WeChat article"，填进度页底部的编号即可。改动后最多 5 分钟生效。

手动运行，或只试运行不提交：

```bash
gh workflow run wechat-import.yml -f id=<编号>
gh workflow run wechat-import.yml -f id=<编号> -f dry_run=true
```

给已有文章分类（管理员，需要 `awdpi` SSO 账号；在 `tools/wechat-sync` 下先运行 `npm ci`）：

```bash
AWS_PROFILE=awdpi node classify-all.mjs ../.. 结果.json            # 只问 AI，不改文件；中断了再运行会接着做
AWS_PROFILE=awdpi node classify-all.mjs ../.. 结果.json --write    # 把分类写进还没有分类的文章，没有介绍的补上介绍
```

`--redo` 让 AI 重新分所有文章并覆盖已有分类（人工改过的也会被覆盖，慎用）；`--excerpts` 只给没有介绍的文章再取一次介绍。约 500 篇文章花费约 0.6 美元。AI 对自己的判断总是说"很确定"，所以这个把握程度没有参考价值，核对时按"AI 分类和标题栏目名对不上"的优先看。

从网站上删掉一篇同步过来的文章：删除 `content/stories/<名称>.html` 和 `static/media/stories/<名称>/`，提交到 main。`shared/` 里的图片可能还有其他文章在用，不要删。

数据保存：核对前的草稿 2 天后自动删除，提交的文章和进度 90 天后自动删除，都在 S3 桶 `awdpi-wechat-sync-<账号>`（eu-north-1）。日志不记录文章内容和密码，保留 30 天。

仓库换了所有者或名称（例如转到组织下）时，要改：`aws/template.yaml` 的 `Repository` 和 `GitHubSubject`（用 `gh api repos/<所有者>/<仓库>/actions/oidc/customization/sub` 查新的前缀），工作流里的 `SITE_URL`（网站地址变了的话）和堆栈的 `SiteUrl`，然后重新部署堆栈，并重新生成 GitHub 令牌。网站正式上线、地址改成 awdpi.org 时，也要改 `SiteUrl` 和工作流的 `SITE_URL`。
