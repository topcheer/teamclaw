# TeamClaw GitHub 登录（OAuth）设计与运维说明

Client ID：`Iv23liqWmzrS3swGiIvK`（GitHub App 客户端 ID）。实现位于
`src/src/controller/github-auth.ts`，路由挂在控制器 HTTP 服务（默认端口 9527），
Web UI 与桌面端均已接入登录/登出入口。

## 1. 一分钟配置（GitHub App 侧）

1. 打开 GitHub App 设置页（Settings -> Developer settings -> GitHub Apps）。
2. **Callback URLs** 至多登记 10 条，必须**精确匹配**（2026-08 起不再默认通配）：
   - `http://localhost:9527/api/v1/auth/github/callback`
   - `http://127.0.0.1:9527/api/v1/auth/github/callback`
   - 若控制器端口被占用会自动 +10 重试（9527 -> 9537 -> ... 最多 10 次），请按需补登实际端口。
3. 生成 **Client Secret**。TeamClaw 侧通过环境变量注入（推荐）：
   `TEAMCLAW_GITHUB_CLIENT_SECRET=xxx`，或插件配置 `githubClientSecret`（env 优先）。
4. 权限按需勾选（如 Contents: Read&Write、Pull requests: Read&Write）。
   GitHub App 不走 scope 参数，令牌权限 = App 权限 ∩ 用户权限。

## 2. 认证流程（Authorization Code + PKCE S256 + state）

```
桌面端/Web UI                控制器 :9527                    GitHub
     |  POST /api/v1/auth/github/login   |                      |
     |---------------------------------->|  生成 state + PKCE    |
     |  { authorizeUrl }                 |  verifier/challenge  |
     |<----------------------------------|                      |
     |  系统浏览器打开 authorizeUrl        |                      |
     |-----------------------------------|--------------------->|
     |        用户在 GitHub 页面授权        |   302 重定向          |
     |  GET /api/v1/auth/github/callback?code=...&state=...      |
     |---------------------------------->|  校验 state(一次性,10min TTL)
     |                                    |  POST /login/oauth/access_token
     |                                    |   (client_id + client_secret + code
     |                                    |    + redirect_uri + code_verifier)
     |                                    |  GET /api.github.com/user
     |                                    |  原子写入 auth/github.json (0600)
     |  浏览器显示"登录成功"; UI 轮询 status 自动刷新              |
```

关键点：

- **PKCE**：每次登录生成 43 字符 base64url verifier，authorize 携带
  `code_challenge_method=S256`，换 token 时带 `code_verifier`。即使 code 被截获也无法兑换。
- **state**：24 字节随机数，进程内存保存，10 分钟 TTL，一次性消费（防 CSRF/重放）。
- **scope=offline_access**：GitHub App 唯一支持的 scope，用于获得过期型 access token
  （8 小时）+ refresh token（6 个月）。不传则拿不到 refresh token。

## 3. 控制器 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/auth/github/status` | 登录态、账号信息、过期时间、回调地址提示 |
| POST | `/api/v1/auth/github/login` | 生成 authorizeUrl（含 state/PKCE），UI 打开系统浏览器 |
| GET | `/api/v1/auth/github/callback` | GitHub 重定向落点，换 token + 拉取用户 + 持久化，返回 HTML 结果页 |
| POST | `/api/v1/auth/github/logout` | 尽力吊销 token（DELETE /applications/{id}/token）后删除本地凭据 |
| POST | `/api/v1/auth/github/refresh` | 手动强制刷新（正常由 getAccessToken 自动触发） |

redirect_uri 由请求 Host 头推导（`http://<host>:<port>/api/v1/auth/github/callback`），
桌面端 127.0.0.1 与浏览器 localhost 两种形态都需要在 GitHub App 登记。

## 4. 持久化方案

**路径**：`~/.openclaw/plugins/teamclaw/auth/github.json`
（`$OPENCLAW_STATE_DIR/plugins/teamclaw/auth/github.json` 优先，与 team-state.json 同目录规则）。

**文件格式**（单账号；`0600` 权限；tmp+rename 原子写；同文件写队列防交错）：

```json
{
  "version": 1,
  "clientId": "Iv23liqWmzrS3swGiIvK",
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

- `getAccessToken()`：距过期 >5 分钟直接返回缓存值；否则单飞（single-flight）执行
  `grant_type=refresh_token`，**刷新令牌轮换**（保存新 ghr_，旧的随之作废）。
- 刷新返回 `bad_refresh_token`（过期/被吊销）-> 删除本地文件，UI 回到未登录态；
  网络类错误不改写文件（避免误删）。
- 无过期型令牌（expiresAt 为 null）直接使用。
- 日志只记录账号名与错误码，任何 token 值不落日志。

## 5. TeamClaw 侧配置

```json
{
  "githubClientId": "Iv23liqWmzrS3swGiIvK",
  "githubClientSecret": ""
}
```

`TEAMCLAW_GITHUB_CLIENT_SECRET` 环境变量优先于配置文件；secret 未配置时
login 接口直接报错提示（不发起无效跳转）。

## 6. 验证

```bash
npm --prefix src run build
node tests/test-github-auth.mjs        # 源码级契约
node tests/test-controller-intake.mjs  # 回归锚点
node tests/test-worker-contracts.mjs   # 回归锚点
node tests/test-ui-contracts.mjs       # UI 契约
```

修改插件配置 schema 后运行 `npm --prefix src run manifest:sync`。
