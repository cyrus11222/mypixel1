# mypixel club · GitHub + Vercel 账户版

官网和登录页分别为 `index.html`、`login.html`，保留原动画和服务器地址 `frp-sun.com:56663`。游客可直接浏览官网与玩家开发者社区介绍；登录后可绑定游戏 ID、加入社区，并可选择 30 天自动登录。双击 HTML 可预览外观，账户功能需要通过 Vercel 或本地开发服务运行。

## 本次更新：通行密钥与多设备登录

注册继续使用用户名和密码，不要求邮箱。本次按最新要求取消邮箱绑定、验证码、邮件通知及邮件密码重置；`pushpassword` 不提供读取密码或邮件重置功能。

1. 使用原用户名／密码登录，点击右上角用户名打开用户中心，在“通行密钥”中输入当前密码、为密钥命名，然后添加。
2. 浏览器会显示系统通行密钥窗口；想存到手机时选择“使用其他设备／手机或平板电脑”等选项，用手机扫描系统显示的二维码并完成指纹、面容或设备解锁验证。选项名称取决于浏览器和手机，二维码由系统生成。
3. 之后在登录页点击“使用通行密钥登录”，选择已保存的通行密钥。使用手机跨设备验证时，一般需要手机和电脑开启蓝牙并靠近。首次使用仍需先用密码创建账号并绑定密钥。
4. 用户中心可以查看或移除已绑定的通行密钥；添加和移除均需当前密码。最多绑定 10 个，移除后该密钥不能再登录本站，但不会替你从手机密码管理器中删除副本。用户名／密码登录始终可用。

通行密钥采用 WebAuthn，本站保存公钥和验证元数据，不接收指纹、面容或私钥。可以使用兼容的系统或密码管理器，并不要求微软账号或 Microsoft Authenticator。正式网站必须使用 HTTPS；通行密钥绑定当前 `APP_ORIGIN` 的域名，在其他 Vercel 预览域名不能直接使用。保留 `APP_ORIGIN=https://www.mypixel.com.cn`，无需申请微软 API Key。

同一账户可以同时登录多个设备，普通玩家和管理员都不会因另一台设备正常登录而被踢出。其他仍有效的设备会话会在网页下次检查状态时收到站内提醒（前台通常不超过 30 秒，回到网页时也会检查），每个会话单独确认；网站关闭时不会发送邮件或系统推送。退出只退出当前会话，封禁、删除账户及管理员密码配置轮换仍会使相关旧登录失效。最多保留 50 个有效会话，达到上限时拒绝新登录，不挤掉已有设备。

参考：[Microsoft 关于通行密钥和手机扫码的说明](https://support.microsoft.com/en-us/accounts-billing/security/passkeys-frequently-asked-questions-faq)、[SimpleWebAuthn 服务端验证](https://simplewebauthn.dev/docs/packages/server)。

## 管理员、工单与玩家开发者社区

- 两张透明 PNG 原样保存在 assets：金色 M 用于网站及登录页，SKYWOLF TECHNOLOGY 标志显示在底部并标注“社区母公司及管理方”。
- 首页和顶部“玩家开发者社区”可直接以游客身份浏览。登录页也有游客入口，账号功能仍需登录。
- 登录／注册提交后共享 60 秒倒计时，前端跨刷新、同源标签页同步；服务端也按 IP 和账号限制间隔。成功后立即进入网站。浏览器仅保存冷却截止时间，不保存密码或登录令牌。
- 左键点击右上角用户名打开白色用户中心，填写完整游戏 ID 绑定。绑定成功后服务端锁定 30 天，期间不能改绑或解绑；锁定期满可操作，同一个 ID 不能绑定多个官网账户。这里记录的是用户自行填写的游戏 ID，不做 Minecraft 官方账户所有权验证，也不会授予游戏权限。
- 已登录并绑定游戏 ID 后可打开入会协议，勾选同意并提交后成为玩家开发者社区成员。服务器保存同意版本及加入时间，刷新和重新登录会保留。改绑或解绑后需重新加入。
- 协议标注“写于 2026/10/1 21:50”，保留四条约定。审核窗口以北京时间表述：工作日 20:30—22:20，休息日全天，休息日参照成都市安排；服务端按 2026 年法定节假日及调休计算审核窗口；工作日包含 22:20 整分钟，22:21 关闭。未来年度调休日历需更新，未更新时仅开放晚间窗口。

**更新部署：** 上传本文件夹内的源码与 assets 等目录，保留原有 `user.txt`，Vercel 中现有七个环境变量继续使用，不要重新生成或替换 `DATA_ENCRYPTION_KEY`；新增管理员需导入下面的两个哈希变量。仍为两个 HTML 文件，社区与用户中心作为首页内的独立视图和对话框实现。上传后等待 Vercel 构建完成即可。

## 管理员配置与命令

管理员用户名固定为 `admindevs`，不允许公开注册、绑定游戏 ID 或加入玩家开发者社区。管理员首次使用正确密码登录时由服务器初始化；账号密码与执行密钥均由服务端哈希校验。

| 新增 Vercel Secret 变量 | 内容 |
| --- | --- |
| `ADMIN_PASSWORD_HASH` | 独立提供的 scrypt 管理员密码哈希 |
| `ADMIN_EXECUTION_KEY_HASH` | 独立提供的 scrypt 管理操作密钥哈希 |

本次另提供私有 `admin-vercel.env`，在 Vercel 的 Environment Variables 页面选择 **Import .env** 导入，作用域选 **Production**，然后手动 Redeploy，并在弹窗中取消勾选 **Use project's Ignore Build Step**，避免账户数据提交触发跳过规则。等待新部署显示 **Ready / Current** 后再登录。这个文件只导入 Vercel，不要上传 GitHub，不在网站 ZIP 中。不要把原始密码填入这两个变量，也不要替换现有账户加密密钥。未配置管理员变量时，普通账号和游客功能继续使用。

管理员登录后点击顶部 **Admin面板**。白色面板中的输入框是网站指令解析器，无法运行系统命令。可输入 `help` 查看指令；执行密钥建议在单独的隐藏输入框填写。命令记录不回显执行密钥。

```text
ban 10m 违反社区规定 PlayerName <执行密钥>
ban inf 严重违规 PlayerName <执行密钥>
unban PlayerName
setintty devplayer 新的完整协议正文
playerout PlayerName <执行密钥>
ztsset add PlayerName
ztsset remove PlayerName
```

- `ban` 支持整数加 `s` 秒、`m` 分钟、`d` 天、`y` 年（按 365 天），`inf` 为永久。撤销该用户所有登录；重新登录时显示封禁期限和原因。`unban` 解除封禁，不恢复旧登录。管理员不能被封禁。
- `playerout` 永久删除当前账户及绑定、社区身份，同时撤销登录；页面执行前确认目标用户名。已有 GitHub 历史提交仍保留加密快照，当前库删除不等于清除整个仓库历史。
- `setintty devplayer` 发布完整协议并更新版本；正在阅读旧版本的用户必须重新阅读后提交；已有成员也需在社区页面同意新版，才能继续提交或批准其工单。协议按纯文字显示，不执行 HTML 或脚本。
- `ztsset` 添加／移除工单审批权限，玩家收到站内弹窗通知，顶部审批入口随权限更新。普通用户不能调用管理员接口。
- 已打开网页会定期检查登录状态，封禁／删除后的所有后续接口立即拒绝，网页检测后返回登录页。游客仍可浏览公共内容。

## 工单与服务器接入

玩家开发者社区成员可提交 **OP、创造模式、物资** 三类工单。每类展示对应二级字段（使用时长、权限级别、世界或物资清单），必须填写用途。玩家只能查看自己的工单；工单管理员和 `admindevs` 可以查看审批列表并批准／驳回，审批意见和结果持久保存。

审批与游戏执行是两个独立状态。本包先完成网页提交、审批、通知及状态记录。Minecraft 服务器接口方案尚待提供，审批通过后显示 **等待接入服务器接口**，不会显示已发放，也不会向游戏服务器发送未经配置的命令。自动执行需补充插件／面板接口文档、服务地址、身份验证方式，以及临时 OP／创造到期撤回规则；密钥仅放服务端配置。

审核时间使用北京时间；2026 调休依据[国务院办公厅通知](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)，适用于成都市的全国统一节假日安排。规则由服务器校验，修改电脑时间不能绕过。

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

构建脚本会比较当前代码与上一次成功部署，只有确认变更全为 `user.txt` 时才跳过构建；缺少历史信息时继续构建。目标分支必须已存在且允许该 Token 提交文件。

**修改环境变量后的手动部署：** 到 Deployments → 对应部署的 **… → Redeploy**，取消勾选 **Use project's Ignore Build Step** 再确认。账户写入提交仍然应跳过自动构建，但环境变量变更需要真正执行一次新部署。`Canceled` 表示未上线，不能让新增环境变量生效。此操作不需要删除账户文件，也不要更换 `DATA_ENCRYPTION_KEY`。参考 [Vercel 的手动重新部署说明](https://vercel.com/docs/project-configuration/project-settings#ignore-build-step-on-redeploy)。

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
  package-lock.json  固定通行密钥验证库及依赖版本
  .env.example       环境变量模板，不含真实密钥
  dev.mjs            本地开发服务
```

密码使用 scrypt（N=32768、r=8、p=3）及独立随机盐；会话仅保存随机令牌的 SHA-256 摘要。不保存明文密码、原始会话令牌或明文 IP。加密文件每次写入使用新的随机 12 字节 IV 和 16 字节认证标签；密钥错误、文件损坏或认证失败时停止读写，不会清空账户重建文件。

旧版私有仓库中的有效明文 JSON 账户文件会在配置密钥后的下一次成功写入时转换为密文。公开仓库中已存在的旧明文账户文件不会自动覆盖，需要先迁移；加密当前文件也不会移除以前 Git 提交中的明文。已有 `user.txt` 会保留，并兼容本次新增的可选账户字段；不要用上传包覆盖账户文件。

勾选自动登录后使用固定 30 天有效期的 `HttpOnly; Secure; SameSite=Lax` Cookie；未勾选时使用浏览器会话 Cookie，服务端最长 12 小时。退出会撤销该会话并清除 Cookie。用于区分浏览器的设备 Cookie 由服务器签名，存储层仅保存摘要，不用于授予登录权限。网站账户独立于 Minecraft/Microsoft 账户，密码和会话令牌不写入 localStorage。

首页由 Vercel Function 公开返回，游客浏览不依赖账户存储；用户资料与所有账户操作仍由服务端验证会话。构建输出仅包含静态资源。服务端检查 Origin、请求大小和持久化限流记录；GitHub 写入使用文件 SHA 比对和重试，避免并发覆盖其他账户。公开仓库仍可看见提交时间和密文大小。

该文件存储方案适合小型社群。登录／注册／退出会产生 GitHub API 请求及提交，可能受到 API 速率限制；加密后的 `user.txt` 达到 800 KB 时停止写入，需要迁移数据库。当前不含密码找回、邮件验证。

## 本地预览与验证

安装 Node.js 24，先在目录内运行 `npm ci` 安装锁定依赖，再运行 `npm start`，访问 `http://127.0.0.1:3000`。Vercel 根据 `package-lock.json` 安装依赖。默认本地账户保存在被 Git 忽略的 `data/user.txt`，仅用于开发，不写 GitHub；该本地文件不加密，不要上传。不要在本地预览时加载生产 `.env`。WebAuthn 本地测试建议把 `APP_ORIGIN` 设为 `http://localhost:3000` 并通过该地址打开；正式手机扫码请在 HTTPS 官网测试。

`npm test` 验证密码哈希、会话过期、退出、限流、HTTP 登录流程、公开仓库加密、篡改拒绝和并发重试；`npm run build` 检查静态资源构建。

本版通过 81 项服务器自动化测试，以及社区、管理员工单、通行密钥三组浏览器验证。通行密钥浏览器验证使用虚拟认证器，覆盖真实 WebAuthn 创建与签名登录、多设备通知、错误密码不退出、移除后拒绝登录、手机宽度排版。所有测试使用隔离的本地账户数据，不修改生产账户。手机和密码管理器的实际扫码窗口还需在正式 HTTPS 域名上由本人确认。

本交付包修改了本地代码；上传替换源码并等待 Vercel 部署完成后才会影响线上服务。现有环境变量保持原值，另添加管理员哈希变量。

技术参考：[Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)、[Vercel 配置](https://vercel.com/docs/project-configuration/vercel-json)、[GitHub 文件 API](https://docs.github.com/en/rest/repos/contents)、[Node.js crypto](https://nodejs.org/api/crypto.html)。
