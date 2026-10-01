# mypixel club · GitHub + Vercel 账户版

官网和登录页分别为 `index.html`、`login.html`，保留原动画和服务器地址 `frp-sun.com:56663`。首次访问需要登录或注册，可选择 30 天自动登录。双击 HTML 可预览外观，账户功能需要通过 Vercel 或本地开发服务运行。

## 使用现有公开仓库

本版支持 `cyrus11222/mypixel1` 公开仓库，无需更改可见性或另建仓库。Vercel 先使用 scrypt 对密码加盐哈希，再将整个账户文件用 AES-256-GCM 加密，最后写入 GitHub 根目录的 `user.txt`。公开文件只有版本信息、随机 IV、认证标签和密文，不包含可直接读取的用户名、密码哈希或会话记录。

登录错误仍需要补全 Vercel 环境变量才能解决；上传 `.env.example` 不会自动配置 Vercel。代码会明确提示缺少的变量、GitHub 权限问题或解密问题。没有登录 Cookie 的访问者可以正常打开登录页。

## 部署步骤

1. 将这个文件夹内的文件及目录上传到 `cyrus11222/mypixel1` 的项目根目录，保留目录层级；不要多套一层文件夹，不要覆盖已有 `user.txt`。
2. 创建 GitHub fine-grained personal access token，Resource owner 选择 `cyrus11222`，仅授权 `mypixel1`，Repository permissions 设置 **Contents: Read and write**。Token 只填进 Vercel，不能放进源码或 HTML。
3. 打开 Vercel 项目 `mypixel1` → Settings → Environment Variables，添加下面的变量，作用域选择 **Production**。密钥和 Token 设为敏感变量。

| 变量 | 内容 |
| --- | --- |
| `APP_ORIGIN` | `https://www.mypixel.com.cn`（未设置时默认使用此域名） |
| `GITHUB_OWNER` | `cyrus11222` |
| `GITHUB_REPO` | `mypixel1` |
| `GITHUB_BRANCH` | `main` |
| `GITHUB_TOKEN` | 上一步生成的仓库 Token |
| `RATE_LIMIT_SECRET` | 至少 32 字符的随机密钥，用于匿名化限流记录 |
| `DATA_ENCRYPTION_KEY` | 独立生成的 64 位十六进制密钥，用于加密账户文件 |

分别运行以下命令两次，产生两个不同的密钥，依次用于 `RATE_LIMIT_SECRET`、`DATA_ENCRYPTION_KEY`：

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**安全保存 DATA_ENCRYPTION_KEY 的备份。** 已有账户创建后，不能随意更换该值；原密钥丢失将无法读取账户数据。密钥不得提交到公开仓库，也不随交付包提供。

4. Vercel Framework Preset 选 **Other**，Node.js 选 **24.x**。使用随包的 `vercel.json`：Build Command 为 `node scripts/build.mjs`，Output Directory 为 `dist`。完成环境变量设置后 **Redeploy**，让新部署读取这些值。
5. 在 `https://www.mypixel.com.cn/login` 注册账户，确认进入官网后可退出并重新登录，GitHub 出现加密的 `user.txt`。勾选自动登录后 Cookie 固定有效 30 天。不要手动创建空的 `user.txt`；代码会在第一次有效的注册／登录请求中自动创建它。

生产环境应使用上述官网域名。若通过其他域名登录，需要将 `APP_ORIGIN` 改为对应的完整 HTTPS 源地址并重新部署。Preview 应使用独立测试仓库、独立密钥和准确的 Preview 域名。

同一仓库中仅修改 `user.txt` 的提交会跳过构建；账户写入不会反复重新部署网站。目标分支必须已存在且允许该 Token 提交文件。

## 文件和账户行为

```text
mypixel-club-2html/
  index.html         官网首页
  login.html         登录／注册页
  assets/            两页所需的 CSS、JS、图片
  api/               Vercel 登录接口与页面入口
  lib/               密码哈希、会话和加密 GitHub 存储
  scripts/           构建与跳过账户数据部署
  test/              自动化验证
  vercel.json        部署配置
  package.json       运行命令
  .env.example       环境变量模板，不含真实密钥
  dev.mjs            本地开发服务
```

密码使用 scrypt（N=32768、r=8、p=3）及独立随机盐；会话仅保存随机令牌的 SHA-256 摘要。不保存明文密码、原始会话令牌或明文 IP。加密文件每次写入使用新的随机 12 字节 IV 和 16 字节认证标签；密钥错误、文件损坏或认证失败时停止读写，不会清空账户重建文件。

旧版私有仓库中的有效明文 JSON 账户文件会在配置密钥后的下一次成功写入时转换为密文。公开仓库中已存在的旧明文账户文件不会自动覆盖，需要先迁移；加密当前文件也不会移除以前 Git 提交中的明文。本次确认的 `cyrus11222/mypixel1` 尚无 `user.txt`，可直接使用加密版本。

勾选自动登录后使用固定 30 天有效期的 `HttpOnly; Secure; SameSite=Lax` Cookie；未勾选时使用浏览器会话 Cookie，服务端最长 12 小时。退出会撤销该会话并清除 Cookie，每个账户最多保留 10 个会话。网站账户独立于 Minecraft/Microsoft 账户，密码和会话令牌不写入 localStorage。

首页由 Vercel Function 检查会话后返回，构建输出仅包含静态资源。服务端检查 Origin、请求大小和持久化限流记录；GitHub 写入使用文件 SHA 比对和重试，避免并发覆盖其他账户。公开仓库仍可看见提交时间和密文大小。

该文件存储方案适合小型社群。登录／注册／退出会产生 GitHub API 请求及提交，可能受到 API 速率限制；加密后的 `user.txt` 达到 800 KB 时停止写入，需要迁移数据库。当前不含密码找回、邮件验证或管理员后台。

## 本地预览与验证

安装 Node.js 24，在目录内运行 `npm start`，访问 `http://127.0.0.1:3000`。默认本地账户保存在被 Git 忽略的 `data/user.txt`，仅用于开发，不写 GitHub；该本地文件不加密，不要上传。不要在本地预览时加载生产 `.env`。

`npm test` 验证密码哈希、会话过期、退出、限流、HTTP 登录流程、公开仓库加密、篡改拒绝和并发重试；`npm run build` 检查静态资源构建。

本交付包修改了本地代码；只有完成上传、Vercel 环境变量配置和重新部署后才会影响线上服务。

技术参考：[Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)、[Vercel 配置](https://vercel.com/docs/project-configuration/vercel-json)、[GitHub 文件 API](https://docs.github.com/en/rest/repos/contents)、[Node.js crypto](https://nodejs.org/api/crypto.html)。
