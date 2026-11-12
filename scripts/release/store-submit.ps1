# store-submit.ps1 - Submit a built MSIX to Microsoft Store certification
# via the Store Submission API (Azure AD client-credentials OAuth).
#
# Modeled on topcheer/ggcode scripts/release/store-submit.ps1, adapted for
# the TeamClaw Electron desktop.
#
# Required environment (set by .github/workflows/store-submission.yml):
#   STORE_TENANT_ID / STORE_CLIENT_ID / STORE_CLIENT_SECRET / STORE_PRODUCT_ID
# Params:
#   -Version  four-part package version (e.g. 0.1.4.0)
#   -AppxPath glob for the built .appx (default: desktop\dist\*.appx)
#   -Notes    optional release notes
#
# API sequence (Store Submission API):
#   1. POST /{tenant}/oauth2/v2.0/token  -> access token (client_credentials,
#      scope https://manage.devcenter.microsoft.com/.default)
#   2. GET  /v1.0/my/applications/{productId}  -> current package/listing state
#   3. POST /v1.0/my/applications/{productId}/packages/upload  (or the
#      ingestion asset endpoint) -> upload URL / package resource
#   4. POST /v1.0/my/applications/{productId}/submissions  -> draft (optional
#      resumeSubmissionId to continue an interrupted submission)
#   5. PUT  package + listing updates into the draft, then
#      POST .../submissions/{id}/commit -> certification pipeline (1-3 days)
#
# Certification is asynchronous: poll
#   GET /v1.0/my/applications/{productId}/submissions/{id}/status
# until status reads "CommitSucceeded" then "Published"/"Release".
param(
  [Parameter(Mandatory = $true)] [string]$Version,
  [string]$AppxPath = "desktop\dist\*.appx",
  [string]$Notes = "",
  [string]$Product = $env:STORE_PRODUCT_ID,
  [string]$ResumeSubmissionId = ""
)

$ErrorActionPreference = "Stop"

# --- 1. Token ---
$tokenBody = @{
  grant_type    = "client_credentials"
  client_id     = $env:STORE_CLIENT_ID
  client_secret = $env:STORE_CLIENT_SECRET
  scope         = "https://manage.devcenter.microsoft.com/.default"
}
$tokenRes = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$env:STORE_TENANT_ID/oauth2/v2.0/token" -Body $tokenBody -ContentType "application/x-www-form-urlencoded"
$headers = @{ Authorization = "Bearer $($tokenRes.access_token)" }
$api = "https://manage.devcenter.microsoft.com/v1.0/my/applications/$Product"
Write-Host "Store API token acquired."

# --- 2. Package upload ---
$pkg = Get-ChildItem $AppxPath | Select-Object -First 1
if (-not $pkg) { throw "no .appx matched $AppxPath (build step failed?)" }
Write-Host "Submitting $($pkg.Name) v$Version (product $Product)"

# The ingestion API: upload the package blob, then attach it to a draft
# submission. Resumable via ResumeSubmissionId when a run dies mid-flow.
if ($ResumeSubmissionId) {
  $sub = Invoke-RestMethod -Method Get -Uri "$api/submissions/$ResumeSubmissionId" -Headers $headers
} else {
  $sub = Invoke-RestMethod -Method Post -Uri "$api/submissions" -Headers $headers -ContentType "application/json" -Body "{}"
}
$subId = $sub.id
Write-Host "Submission draft: $subId"

# Upload the appx to the draft's package upload URL (the draft response
# carries file upload targets under .uploadUrl / .packages; the blob goes up
# with PUT, then the submission body references it).
$uploadUrl = $sub.uploadUrl
if (-not $uploadUrl) { throw "draft submission did not carry an uploadUrl - check API version/docs" }
Invoke-RestMethod -Method Put -Uri $uploadUrl -InFile $pkg.FullName -Headers @{ "x-ms-blob-type" = "BlockBlob" } | Out-Null
Write-Host "Package blob uploaded."

# --- 3. Draft body: package + optional notes, then commit ---
$submissionBody = @{
  packages = @(
    @{ file = $pkg.Name; version = $Version; uploadUrl = $uploadUrl }
  )
}
if ($Notes) { $submissionBody.listingNotes = $Notes }
Invoke-RestMethod -Method Put -Uri "$api/submissions/$subId" -Headers $headers -ContentType "application/json" -Body ($submissionBody | ConvertTo-Json -Depth 6) | Out-Null

Invoke-RestMethod -Method Post -Uri "$api/submissions/$subId/commit" -Headers $headers -ContentType "application/json" -Body "{}" | Out-Null
Write-Host "Submission $subId committed - certification pipeline started (1-3 days)."
Write-Host "Poll: GET $api/submissions/$subId/status"
