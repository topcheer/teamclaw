{{/* Expand the name of the chart. */}}
{{- define "teamclaw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Create a default fully qualified app name. */}}
{{- define "teamclaw.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Create chart name and version as used by the chart label. */}}
{{- define "teamclaw.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels */}}
{{- define "teamclaw.labels" -}}
helm.sh/chart: {{ include "teamclaw.chart" . }}
{{ include "teamclaw.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels */}}
{{- define "teamclaw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "teamclaw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Service account name */}}
{{- define "teamclaw.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "teamclaw.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Worker service account name */}}
{{- define "teamclaw.workerServiceAccountName" -}}
{{- if .Values.workerServiceAccount.create }}
{{- default (printf "%s-worker" (include "teamclaw.fullname" .)) .Values.workerServiceAccount.name }}
{{- else if .Values.workerServiceAccount.name }}
{{- .Values.workerServiceAccount.name }}
{{- else }}
{{- include "teamclaw.serviceAccountName" . }}
{{- end }}
{{- end }}

{{/* Config secret name */}}
{{- define "teamclaw.configSecretName" -}}
{{- if .Values.config.existingSecret }}
{{- .Values.config.existingSecret }}
{{- else if .Values.config.secretName }}
{{- .Values.config.secretName }}
{{- else }}
{{- printf "%s-config" (include "teamclaw.fullname" .) }}
{{- end }}
{{- end }}

{{/* Workspace PVC name */}}
{{- define "teamclaw.workspaceClaimName" -}}
{{- if .Values.workspace.existingClaim }}
{{- .Values.workspace.existingClaim }}
{{- else }}
{{- printf "%s-workspace" (include "teamclaw.fullname" .) }}
{{- end }}
{{- end }}

{{/* Render openclaw.json with chart-controlled defaults. */}}
{{- define "teamclaw.openclawConfig" -}}
{{- $cfg := deepCopy .Values.config.openclaw -}}
{{- $agents := default (dict) (get $cfg "agents") -}}
{{- $defaults := default (dict) (get $agents "defaults") -}}
{{- if .Values.workspace.enabled }}
{{- $_ := set $defaults "workspace" .Values.workspace.mountPath -}}
{{- end }}
{{- $_ := set $agents "defaults" $defaults -}}
{{- $_ := set $cfg "agents" $agents -}}
{{- $plugins := default (dict) (get $cfg "plugins") -}}
{{- $entries := default (dict) (get $plugins "entries") -}}
{{- $teamclaw := default (dict) (get $entries "teamclaw") -}}
{{- $teamclawCfg := default (dict) (get $teamclaw "config") -}}
{{- $_ := set $teamclawCfg "port" (int .Values.service.targetPort) -}}
{{- if and (eq (default "controller" (get $teamclawCfg "mode")) "controller") (eq (default "" (get $teamclawCfg "workerProvisioningType")) "kubernetes") (eq (default "" (get $teamclawCfg "workerProvisioningControllerUrl")) "") -}}
{{- $_ := set $teamclawCfg "workerProvisioningControllerUrl" (printf "http://%s.%s.svc.cluster.local:%v" (include "teamclaw.fullname" .) .Release.Namespace .Values.service.port) -}}
{{- end -}}
{{- if and (eq (default "controller" (get $teamclawCfg "mode")) "controller") (eq (default "" (get $teamclawCfg "workerProvisioningType")) "kubernetes") (eq (default "" (get $teamclawCfg "workerProvisioningKubernetesServiceAccount")) "") -}}
{{- $_ := set $teamclawCfg "workerProvisioningKubernetesServiceAccount" (include "teamclaw.workerServiceAccountName" .) -}}
{{- end -}}
{{- if and .Values.workspace.enabled (eq (default "" (get $teamclawCfg "workerProvisioningType")) "kubernetes") (eq (default "" (get $teamclawCfg "workerProvisioningKubernetesWorkspacePersistentVolumeClaim")) "") -}}
{{- $_ := set $teamclawCfg "workerProvisioningKubernetesWorkspacePersistentVolumeClaim" (include "teamclaw.workspaceClaimName" .) -}}
{{- end -}}
{{- $_ := set $teamclaw "config" $teamclawCfg -}}
{{- $_ := set $entries "teamclaw" $teamclaw -}}
{{- $_ := set $plugins "entries" $entries -}}
{{- $_ := set $cfg "plugins" $plugins -}}
{{- toPrettyJson $cfg -}}
{{- end }}
