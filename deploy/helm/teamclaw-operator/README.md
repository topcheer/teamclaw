
## Release discipline

OCI registries reject re-pushing an existing chart version. ALWAYS bump
`version` in Chart.yaml before merging chart changes - the release CI
(`helm-chart-release.yml`) pushes on every merge to main.
