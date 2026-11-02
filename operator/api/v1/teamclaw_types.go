package v1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// TeamClawSpec defines the desired state of a TeamClaw deployment.
type TeamClawSpec struct {
	// Image is the teamclaw-openclaw runtime image used by the controller
	// and provisioned workers.
	// +kubebuilder:default="ghcr.io/topcheer/teamclaw-openclaw:latest"
	Image string `json:"image"`

	// TeamName is the teamclaw team identifier persisted in team state.
	TeamName string `json:"teamName"`

	// Controller configures the controller deployment.
	Controller ControllerSpec `json:"controller,omitempty"`

	// Workspace configures the shared git workspace volume.
	Workspace WorkspaceSpec `json:"workspace,omitempty"`

	// Workers configures on-demand worker provisioning.
	Workers WorkersSpec `json:"workers,omitempty"`

	// Network configures controller exposure. The operator UI is exposed
	// separately by the operator installation manifests.
	Network NetworkSpec `json:"network,omitempty"`
}

// ControllerSpec configures the controller workload.
type ControllerSpec struct {
	// Resources for the controller container.
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// ModelConfigSecretRef references a Secret containing openclaw.json.
	// The Secret must have an "openclaw.json" key. Required.
	ModelConfigSecretRef string `json:"modelConfigSecretRef"`

	// Env adds extra environment variables for the controller container.
	Env []corev1.EnvVar `json:"env,omitempty"`
}

// WorkspaceSpec configures the shared workspace volume.
type WorkspaceSpec struct {
	// Enabled mounts a PVC at the controller workspace path.
	// +kubebuilder:default=true
	Enabled bool `json:"enabled,omitempty"`

	// Size of the workspace PVC.
	// +kubebuilder:default="20Gi"
	Size string `json:"size,omitempty"`

	// StorageClassName for the workspace PVC. Empty uses the cluster default.
	StorageClassName string `json:"storageClassName,omitempty"`

	// ExistingClaim reuses an existing PVC instead of creating one.
	ExistingClaim string `json:"existingClaim,omitempty"`
}

// WorkersSpec configures on-demand worker provisioning.
type WorkersSpec struct {
	// ProvisioningType selects the worker backend: "none" or "kubernetes".
	// +kubebuilder:default="kubernetes"
	ProvisioningType string `json:"provisioningType,omitempty"`

	// Namespace where worker pods are created. Empty = controller namespace.
	Namespace string `json:"namespace,omitempty"`

	// ServiceAccount workers run as. Empty = operator-created default.
	ServiceAccount string `json:"serviceAccount,omitempty"`

	// MinPerRole keeps this many ready workers warm per role.
	MinPerRole map[string]int32 `json:"minPerRole,omitempty"`
}

// NetworkSpec configures controller exposure.
type NetworkSpec struct {
	// ServicePort is the controller Service port.
	// +kubebuilder:default=80
	ServicePort int32 `json:"servicePort,omitempty"`

	// Ingress optionally exposes the controller through an Ingress.
	Ingress *IngressSpec `json:"ingress,omitempty"`
}

// IngressSpec exposes the controller through an Ingress.
type IngressSpec struct {
	// Host is the ingress hostname. Required when ingress is enabled.
	Host string `json:"host"`

	// IngressClassName selects the ingress controller. Empty = cluster default.
	IngressClassName string `json:"ingressClassName,omitempty"`

	// Annotations are applied to the Ingress object.
	Annotations map[string]string `json:"annotations,omitempty"`

	// TLSSecretName enables TLS with the given certificate secret.
	TLSSecretName string `json:"tlsSecretName,omitempty"`
}

// WorkerPodsStatus reports worker pod counts reconciled from the cluster.
type WorkerPodsStatus struct {
	Running  int32 `json:"running,omitempty"`
	Pending  int32 `json:"pending,omitempty"`
	Orphaned int32 `json:"orphaned,omitempty"`
}

// TeamClawStatus defines the observed state of a TeamClaw deployment.
type TeamClawStatus struct {
	// Conditions represent the latest available observations.
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`

	// ControllerEndpoint is the in-cluster controller URL.
	ControllerEndpoint string `json:"controllerEndpoint,omitempty"`

	// WorkerPods reports worker pod counts managed by the controller.
	WorkerPods WorkerPodsStatus `json:"workerPods,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=tc
// +kubebuilder:printcolumn:name="Team",type=string,JSONPath=`.spec.teamName`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Workers",type=integer,JSONPath=`.status.workerPods.running`
// +kubebuilder:printcolumn:name="Endpoint",type=string,JSONPath=`.status.controllerEndpoint`

// TeamClaw is the Schema for the teamclaws API.
type TeamClaw struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   TeamClawSpec   `json:"spec,omitempty"`
	Status TeamClawStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// TeamClawList contains a list of TeamClaw.
type TeamClawList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []TeamClaw `json:"items"`
}

func init() {
	SchemeBuilder.Register(&TeamClaw{}, &TeamClawList{})
}
