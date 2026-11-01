# TeamClaw GitHub 登录（OAuth Device Flow）设计与运维说明

Client ID：`Iv23liqWmzrS3swGiIvK`（GitHub App）。实现位于
`src/src/controller/github-auth.ts`，路由挂在控制器 HTTP 服务（默认端口 9527）。
UI 入口：Web UI 与桌面端**右上角**的 Login 按钮，弹出独立设备授权页 `/ui/auth/github`；
登录后右上角显示用户（点击即退出并删除服务端 token）。

**默认使用 Device Flow，全程不需要 Client Secret**（GitHub 官方对桌面/CLI 应用的
推荐方案）：
- 设备码申请与换 token 只需 `client_id`；
- 官方文档明确：刷新令牌时 `client_secret` "Required **unless** the user access
  token was generated using the device flow" —— 设备流令牌连刷新都免 secret。

## 1. GitHub App 侧配置（无需 secret）

1. GitHub App 设置页勾选 **Enable Device Flow**（必须，否则 login 接口会返回
   `device_flow_disabled` 的明确提示）。
2. 权限按需勾选（如 Contents: Read&Write、Pull requests: Read&Write）。
   GitHub App 不走 scope 参数，令牌权限 = App 权限 ∩ 用户权限。
3. 可选：保留 "Expire user authorization tokens"（默认开启也没关系）——设备流
   令牌 8 小时过期后自动用 refresh token 续期，同样不需要 secret。
4. （可选）Web Flow 作为备用：登记精确匹配的回调
   `http://localhost:9527/api/v1/auth/github/callback` 并配置 client secret。
   仅当显式请求 `{"flow":"web"}` 时才走该路径。

## 2. 认证流程（Device Flow，默认）

```
桌面端/Web UI              控制器 :9527                        GitHub
   | POST /api/v1/auth/github/login     |                        |
   |----------------------------------->| POST /login/device/code |
   |                                    |   (client_id + offline_access, 无 secret)
   | { mode:"device", userCode,         |<-----------------------|
   |  verificationUriComplete, ... }    | device_code/user_code  |
   |<-----------------------------------|                        |
   | 系统浏览器打开                        |                        |
   | github.com/login/device?user_code=… |                        |
   |---------------------------------------------|-------------->|
   |      用户在 GitHub 输入/确认 user code 并授权  |               |
   |                                    | 每 interval 秒轮询       |
   |                                    | POST /login/oauth/access_token
   |                                    |  (client_id + device_code + grant_type, 无 secret)
   |                                    | authorization_pending → 继续轮询
   |                                    | slow_down → 间隔 +5s
   |                                    | 成功: access_token + refresh_token
   |                                    | GET api.github.com/user
   |                                    | 原子写入 auth/github.json (0600)
   | UI 轮询 /status 自动变为已登录         |                        |
```

要点：
- `scope=offline_access`：GitHub App 唯一支持的 scope，换来过期型 access token
  （8h）+ refresh token（6 个月）。
- 轮询节奏完全遵循 GitHub 返回的 `interval`（默认 5s），`slow_down` 自动 +5s，
  过期（默认 15 分钟）或用户拒绝即终止。
- UI 同时显示 user code（可复制）并自动打开预填链接
  `github.com/login/device?user_code=XXXX-XXXX`，通常零输入。
- CSRF/PKCE 不适用于 device flow（RFC 8628 本身以用户输入 code 为凭证）；
  Web Flow 路径仍保留 PKCE S256 + state（10 分钟 TTL，一次性）。

## 3. 控制器 API 与独立登录页

**独立登录页 `GET /ui/auth/github`**（`src/src/ui/github-login.html`，自包含单文件）：
大号设备码 + 倒计时 + 复制按钮 + 预填链接按钮，每 2.5 秒轮询状态，成功后显示账号
与退出按钮。中英文自动切换。右上角 Login 按钮打开此页。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ui/auth/github` | 独立设备授权页（状态/设备码/成功/退出四态） |
| GET | `/api/v1/auth/github/status` | 登录态、账号、过期时间、loginPageUrl、进行中的设备流（user code） |
| POST | `/api/v1/auth/github/login` | 默认返回 `{mode:"device", userCode, verificationUri, verificationUriComplete, expiresAt, loginPageUrl, authorizeUrl}`；`authorizeUrl` 指向独立页以兼容旧客户端；body `{"flow":"web"}` 时走 PKCE Web 流（需 secret） |
| GET | `/api/v1/auth/github/callback` | 仅 Web Flow 使用；换 token + 持久化，返回 HTML 结果页 |
| POST | `/api/v1/auth/github/logout` | 删除服务端保存的 token（auth/github.json）；有 secret 时额外尽力吊销远端 token |
| POST | `/api/v1/auth/github/refresh` | 手动强制刷新（正常由 getAccessToken 自动触发） |

## 4. 持久化方案

**路径**：`~/.openclaw/plugins/teamclaw/auth/github.json`
（`$OPENCLAW_STATE_DIR/plugins/teamclaw/auth/github.json` 优先）。

**文件格式**（单账号；`0600` 权限；tmp+rename 原子写；写队列防交错）：

```json
{
  "version": 1,
  "clientId": "Iv23liqWmzrS3swGiIvK",
  "flowOrigin": "device",
  "account": { "id": 1, "login": "octocat", "name": "...", "avatarUrl": "...", "htmlUrl": "..." },
  "accessToken": "ghu_...",
  "refreshToken": "ghr_...",
  "obtainedAt": 1730000000000,
  "expiresAt": 1730028800000,
  "refreshExpiresAt": 1751568000000,
  "updatedAt": 1730000000000
}
```

**令牌生命周期**：

- `getAccessToken()`：距过期 >5 分钟直接返回；否则单飞（single-flight）执行
  `grant_type=refresh_token`。设备流令牌（`flowOrigin:"device"`）刷新不带
  secret；web 流令牌带 secret（未配置则报错并提示改走设备流）。
  刷新令牌轮换：新 ghr_ 立即落盘。
- 刷新返回 `bad_refresh_token`（过期/吊销）→ 删除本地文件回到未登录态；
  网络类错误不改写文件。
- 日志只记录账号名与错误码，token 值不落日志。

## 5. TeamClaw 侧配置

```json
{
  "githubClientId": "Iv23liqWmzrS3swGiIvK"
}
```

设备流（默认）无需任何 secret。仅当需要 Web Flow 备用路径时才设置
`TEAMCLAW_GITHUB_CLIENT_SECRET` 环境变量或 `githubClientSecret` 配置（env 优先）。

## 6. 验证

```bash
npm --prefix src run build
node tests/test-github-auth.mjs        # 源码级契约（含设备流断言）
node tests/test-controller-intake.mjs  # 回归锚点
node tests/test-worker-contracts.mjs   # 回归锚点
node tests/test-ui-contracts.mjs       # UI 契约
```

修改插件配置 schema 后运行 `npm --prefix src run manifest:sync`。
