# Microsoft Store 提交指南 — TeamClaw Desktop

本目录是 Microsoft Store 首次提交的完整元数据包（模式沿用 ggcode 仓库的 msix-store / store-submission 流程）。

## 文件
- `appxmanifest.template.xml` — MSIX 打包清单模板（占位符：IDENTITY_NAME / PUBLISHER / VERSION / ARCH）
- `metadata.json` — Partner Center 提交元数据（双语言 listing、分级、分类、系统要求、素材清单）

## 提交前需要完成的一次性步骤（需要 Partner Center 账号操作）

1. **预留产品名**：Partner Center → 新建产品 → 名称 "TeamClaw Desktop"。
2. **记录 App identity**（App 管理 → App identity）：
   - Package/Identity Name → 填入打包的 `{{IDENTITY_NAME}}`
   - Publisher（CN=…）→ 填入 `{{PUBLISHER}}`
   - 产品 ID（URL 里的数字）→ 存为 CI secret `STORE_PRODUCT_ID`
3. **Azure AD 应用**（账号设置 → 用户 → Azure AD 应用）：创建无 UI 的 ClientSecret 应用，权限选"管理"；记下：
   - Tenant ID → secret `STORE_TENANT_ID`
   - Client ID → secret `STORE_CLIENT_ID`
   - Client Secret → secret `STORE_CLIENT_SECRET`
4. **补齐 metadata.json 的 TODO**：支持邮箱、隐私页（若无则先发布 `docs/PRIVACY.md`）、确认数据收集声明。
5. **截图**：按 metadata.json assets 段要求截 3 张 1366x768+ PNG（建议：Mission / Tasks / Controller 页）。

## 打包 MSIX

MSIX 不需要开发者签名（Partner Center 接收时重签）。用 electron-builder 的 `--win msi`不行——Store 要 MSIX：

```powershell
# 从 win-unpacked 产物用 MakeAppx 打包（身份值来自步骤 2）
npx electron-builder --win appx --x64 --config.win.appx.identityName=<IDENTITY_NAME> --config.win.appx.publisher=<PUBLISHER>
```

产物 `dist/*.appx` 即可上传（appx 与 msix 同格式，Store 均接收）。首提可直接在 Partner Center 网页上传；后续提交可参照 ggcode 的 `scripts/release/submit-store.ps1`（同租户/客户端凭据）自动化。

## 与 GitHub release 的关系

desktop-release.yml（desktop-latest）出的 NSIS 安装器继续作为直发渠道；Store 渠道是独立的 MSIX 包，两者共存不冲突。macOS 侧已在同 workflow 里加 Developer ID 签名 + 公证（凭据缺失时自动降级 unsigned）。
