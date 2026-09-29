# mypixel club · GitHub + Vercel 账户版

## 2026-09-29 登录修复

已在线确认 `https://www.mypixel.com.cn/api/auth?action=me` 返回 503，且不涉及账户查询的请求也在 Origin 配置检查阶段返回 503。旧版会因 `APP_ORIGIN` 缺失或格式不符直接失败，并把所有配置问题显示为同一句“账户服务暂不可用”。未获得 Vercel 配置读取权限，无法确认线上实际变量值。

**现有部署立即处理：** Vercel → 项目 → Settings → Environment Variables，将 Production 中的 `APP_ORIGIN` 设为 `https://www.mypixel.com.cn`，然后 Redeploy。只在 GitHub 上传 `.env.example` 不会设置 Vercel 环境变量。

**本修复版：** 未设置 `APP_ORIGIN` 时使用已确认的官网域名；允许首尾空格和域名后的 `/`。没有登录 Cookie 的访客正常进入登录页，不会先初始化整个账户服务。真正提交登录／注册时仍验证服务配置；缺少变量或 GitHub 权限不足会显示具体错误，不会绕过登录或改用浏览器存储。函数日志只记录错误代码与变量名，不记录密钥。

仍须在 Vercel 设置 `GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_TOKEN`、`RATE_LIMIT_SECRET`；数据分支不是 `main` 时填写 `GITHUB_BRANCH`。这些值无法从公开网站获取。替换本文件夹源码后重新部署；不要覆盖账户仓库内已有的 `user.txt`。本次修复未改动现有密码、会话或账户数据格式。

已保留原官网、动画和服务器地址 `frp-sun.com:56663`，增加首次访问登录／注册、30 天自动登录、退出登录。顶层只有两个 HTML，双击可查看页面外观；注册／登录必须通过部署后的 Vercel 网站或本地开发服务使用。此版本由 Vercel Functions 处理验证。

## 部署到现有 GitHub + Vercel 项目

1. 解压 `mypixel-club-2html.zip`，将其中的文件及目录放到 **Vercel 项目根目录对应的 GitHub 目录**，保留目录层级。顶层的 `index.html` 是官网，`login.html` 是登录／注册页。两页需要的样式、脚本和图片在 `assets/`；其余目录是运行账户功能需要的后端及配置。
2. 准备一个 **私有 GitHub 仓库** 保存账户。可以使用当前私有官网仓库，也可以单独建私有账户仓库。仓库必须至少有一次提交（例如 README），并有目标分支。代码会在第一次有效的注册／登录请求中自动创建根目录的 `user.txt`，无需手动创建空文本文件。
3. 在 GitHub 创建 **fine-grained personal access token**：仅允许访问该账户仓库，Repository permissions 中赋予 **Contents: Read and write**。令牌只填进 Vercel 环境变量，不要写进任何源码、HTML、聊天或提交历史。
4. 在 Vercel → 项目 Settings → Environment Variables 添加下表变量，作用域选择 Production。设置完成后重新部署。若使用 Preview，给 Preview 单独设置它的准确域名与独立测试账户仓库，不要把生产账户令牌提供给不受信任的分支。

| 环境变量 | 内容 |
| --- | --- |
| `APP_ORIGIN` | 官网完整 HTTPS 源地址，例如 `https://mypixel.example.com`，末尾不要 `/`，不要路径。浏览器必须从该域名访问。 |
| `GITHUB_OWNER` | 账户仓库的拥有者或组织名称 |
| `GITHUB_REPO` | 账户仓库名称，仅名称，不是完整链接 |
| `GITHUB_BRANCH` | 账户数据分支，通常是 `main`，必须已存在且允许该 Token 写入 |
| `GITHUB_TOKEN` | 上一步的私有仓库访问令牌，设为敏感变量 |
| `RATE_LIMIT_SECRET` | 至少 32 字符的随机密钥，设为敏感变量；用于匿名化限流记录，不是用户密码 |

生成随机密钥：

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

5. Vercel Framework Preset 选择 **Other**，Node.js 选择 **24.x**，使用随包的 `vercel.json` 配置：构建命令为 `node scripts/build.mjs`，Output Directory 为 `dist`。构建仅复制静态资源，首页交给 `api/site.js` 验证登录后返回，登录页由 `api/login.js` 返回；两个 HTML 会包含在函数内，不会直接公开为静态首页。
6. 访问 `APP_ORIGIN`，注册一个账户。确认自动进入官网、可以退出，且 GitHub 仓库出现 `user.txt`。勾选 30 天自动登录后，关闭并重新打开浏览器，应自动进入。未配置环境变量或私有仓库不可用时会显示服务不可用，不会假装注册成功。

如果账户和网页在同一仓库，`ignoreCommand` 会跳过仅修改 `user.txt` 的构建，避免账户写入反复部署网站。独立账户仓库则完全不触发网站构建。GitHub 分支保护如果禁止 API 直接提交，需要选择专用账户分支。

## 文件与数据

```text
mypixel-club-2html/
  index.html         官网首页
  login.html         登录／注册页
  assets/            两页所需的 CSS、JS、图片
  api/               Vercel 登录接口与页面入口
  lib/               账户哈希、会话和 GitHub 存储
  scripts/           构建与跳过账户数据部署
  test/              自动化验证
  vercel.json        部署配置
  package.json       运行命令
  .env.example       环境变量模板
  dev.mjs            本地预览服务
```

`user.txt` 是 UTF-8 JSON 文本，包含 `schema`、`users` 和 `limits`。每个用户保存用户名、随机盐与 scrypt 密码哈希、创建时间，以及会话令牌的 SHA-256 摘要和到期时间。**不保存明文密码、原始会话令牌或明文 IP。** SHA-256 只用于随机令牌摘要，密码使用 scrypt（N=32768、r=8、p=3）。

勾选时使用 30 天固定有效期的 `HttpOnly; Secure; SameSite=Lax` Cookie，不是每次访问无限续期。未勾选时使用浏览器会话 Cookie，服务端最长 12 小时；部分浏览器会恢复会话 Cookie，因此手动退出最可靠。退出会删除服务端会话并清除 Cookie；每个账户最多保留 10 个登录会话。网站账户与 Minecraft/Microsoft 游戏账户独立。

密码不写入 localStorage。服务端检查 Origin，限定请求大小，保存可跨 Vercel 实例生效的尝试次数，并通过 GitHub 文件 SHA 比对和重试保护并发更新。公开仓库会被拒绝作为账户存储；哈希也需要保密。私有仓库的 Git 历史会保留旧版本，请限制协作者权限，不要公开历史。

这是适合小型社群的文件存储方案：注册／登录／退出会产生 GitHub API 请求及提交；频繁请求会受到 GitHub 速率限制，数据文件达到 800 KB 后会拒绝继续写入而不是覆盖数据。用户规模扩大时应迁移数据库。当前不含密码找回、邮件验证或管理员后台。

## 本地预览与测试

安装 Node.js 24 后，在项目目录运行 `npm start`，访问 `http://127.0.0.1:3000`。未设置环境变量时使用仅限本地的 `data/user.txt`，不写 GitHub；不要把这个目录上传。`npm test` 验证哈希存储、过期、退出、限流、GitHub 并发重试和 HTTP 登录流程。

本地预览不要加载生产 `.env`；如已有 `.env`，请将 `AUTH_STORE` 改为 `local`，`APP_ORIGIN` 改为 `http://127.0.0.1:3000`。线上始终使用 GitHub 存储，不依赖 Vercel 的临时文件系统。

当前交付未连接实际 GitHub 仓库、未在 Vercel 发布。已完成本地验证；真实 Token 权限、分支保护与线上路由需部署后按上述步骤验证。

技术依据：[Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)、[Vercel 配置](https://vercel.com/docs/project-configuration/vercel-json)、[GitHub 文件 API](https://docs.github.com/en/rest/repos/contents)、[Node.js crypto](https://nodejs.org/api/crypto.html)。
