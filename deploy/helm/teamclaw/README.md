# TeamClaw Helm chart

This chart deploys a TeamClaw controller on Kubernetes and can optionally let the controller provision worker pods with `workerProvisioningType: kubernetes`.

## Private registry workflow

If your cluster cannot pull `ghcr.io/topcheer/teamclaw-openclaw`, push the runtime image to your own registry and create an image pull secret:

```bash
bash scripts/teamclaw-runtime-image.sh \
  registry.example.com/teamclaw/teamclaw-openclaw:latest

kubectl create secret docker-registry regcred \
  --namespace teamclaw \
  --docker-server=registry.example.com \
  --docker-username="$REGISTRY_USERNAME" \
  --docker-password="$REGISTRY_PASSWORD"
```

Then install or upgrade with the example values file:

```bash
helm upgrade --install teamclaw ./deploy/helm/teamclaw \
  --namespace teamclaw \
  --create-namespace \
  -f deploy/helm/teamclaw/values-private-registry.yaml
```

Update these values before applying:

- `image.repository`
- `image.tag`
- `imagePullSecrets[].name`
- any provider secrets or pass-through env such as `ZAI_API_KEY`

## Worker image propagation

When `workerProvisioningType: kubernetes` is enabled, the chart now auto-fills these TeamClaw config fields if you leave them empty:

- `workerProvisioningImage` from the chart's `image.repository:image.tag`
- `workerProvisioningKubernetesServiceAccount` from the chart's worker service account
- `workerProvisioningKubernetesImagePullSecrets` from the chart's `imagePullSecrets`
- `workerProvisioningKubernetesWorkspacePersistentVolumeClaim` from the chart workspace PVC

This keeps controller and dynamically provisioned worker pods aligned by default.
