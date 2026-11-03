package controller

import (
	"context"
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	teav1 "github.com/topcheer/teamclaw/operator/api/v1"
)

const (
	controllerContainerPort = 9527
	workspaceMountPath      = "/home/node/.openclaw/workspace"
	openclawHome            = "/home/node"
	controllerSecretKey     = "openclaw.json"
)

// labelsFor returns the operator-managed labels for a TeamClaw instance.
func labelsFor(tc *teav1.TeamClaw) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":       "teamclaw-controller",
		"app.kubernetes.io/managed-by": "teamclaw-operator",
		"teamclaw.dev/team":            sanitize(tc.Spec.TeamName, 40),
		"teamclaw.dev/instance":        tc.Name,
	}
}

func sanitize(value string, max int) string {
	value = strings.ToLower(value)
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > max {
		out = out[:max]
	}
	if out == "" {
		out = "team"
	}
	return out
}

// TeamClawReconciler reconciles a TeamClaw object.
type TeamClawReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=teamclaw.dev,resources=teamclaws,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=teamclaw.dev,resources=teamclaws/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=teamclaw.dev,resources=teamclaws/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services;serviceaccounts;persistentvolumeclaims;events,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles;rolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=ingresses,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch

// Reconcile drives a TeamClaw deployment toward its desired state.
func (r *TeamClawReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var tc teav1.TeamClaw
	if err := r.Get(ctx, req.NamespacedName, &tc); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Prerequisite: the referenced openclaw config secret must exist.
	if err := r.validateConfigSecret(ctx, &tc); err != nil {
		_ = r.patchStatus(ctx, &tc, func(s *teav1.TeamClawStatus) {
			setCondition(s, "ConfigReady", metav1.ConditionFalse, err.Error())
			setCondition(s, "Ready", metav1.ConditionFalse, "config secret not ready")
		})
		return ctrl.Result{}, err
	}
	_ = r.patchStatus(ctx, &tc, func(s *teav1.TeamClawStatus) {
		setCondition(s, "ConfigReady", metav1.ConditionTrue, "config secret present")
	})

	if err := r.reconcileRBAC(ctx, &tc); err != nil {
		return ctrl.Result{}, fmt.Errorf("rbac: %w", err)
	}
	if err := r.reconcileWorkspace(ctx, &tc); err != nil {
		return ctrl.Result{}, fmt.Errorf("workspace: %w", err)
	}
	if err := r.reconcileDeployment(ctx, &tc); err != nil {
		return ctrl.Result{}, fmt.Errorf("deployment: %w", err)
	}
	if err := r.reconcileService(ctx, &tc); err != nil {
		return ctrl.Result{}, fmt.Errorf("service: %w", err)
	}
	if err := r.reconcileIngress(ctx, &tc); err != nil {
		return ctrl.Result{}, fmt.Errorf("ingress: %w", err)
	}
	if err := r.reconcileStatus(ctx, &tc); err != nil {
		return ctrl.Result{}, fmt.Errorf("status: %w", err)
	}

	logger.Info("reconciled teamclaw", "name", tc.Name)
	return ctrl.Result{}, nil
}

func (r *TeamClawReconciler) validateConfigSecret(ctx context.Context, tc *teav1.TeamClaw) error {
	if tc.Spec.Controller.ModelConfigSecretRef == "" {
		return fmt.Errorf("spec.controller.modelConfigSecretRef is required")
	}
	var secret corev1.Secret
	err := r.Get(ctx, types.NamespacedName{Namespace: tc.Namespace, Name: tc.Spec.Controller.ModelConfigSecretRef}, &secret)
	if apierrors.IsNotFound(err) {
		return fmt.Errorf("config secret %q not found", tc.Spec.Controller.ModelConfigSecretRef)
	}
	if err != nil {
		return err
	}
	if _, ok := secret.Data[controllerSecretKey]; !ok {
		return fmt.Errorf("config secret %q is missing the %q key", tc.Spec.Controller.ModelConfigSecretRef, controllerSecretKey)
	}
	return nil
}

func (r *TeamClawReconciler) reconcileRBAC(ctx context.Context, tc *teav1.TeamClaw) error {
	sa := &corev1.ServiceAccount{ObjectMeta: r.objectMeta(tc, tc.Name+"-controller")}
	if _, err := controllerutil.CreateOrPatch(ctx, r.Client, sa, func() error {
		return controllerutil.SetControllerReference(tc, sa, r.Scheme)
	}); err != nil {
		return err
	}

	role := &rbacv1.Role{ObjectMeta: r.objectMeta(tc, tc.Name+"-controller")}
	if _, err := controllerutil.CreateOrPatch(ctx, r.Client, role, func() error {
		role.Rules = []rbacv1.PolicyRule{{
			APIGroups: []string{""},
			Resources: []string{"pods"},
			Verbs:     []string{"get", "list", "watch", "create", "update", "patch", "delete"},
		}}
		return controllerutil.SetControllerReference(tc, role, r.Scheme)
	}); err != nil {
		return err
	}

	binding := &rbacv1.RoleBinding{ObjectMeta: r.objectMeta(tc, tc.Name+"-controller")}
	_, err := controllerutil.CreateOrPatch(ctx, r.Client, binding, func() error {
		binding.Subjects = []rbacv1.Subject{{Kind: rbacv1.ServiceAccountKind, Name: tc.Name + "-controller", Namespace: tc.Namespace}}
		binding.RoleRef = rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: tc.Name + "-controller"}
		return controllerutil.SetControllerReference(tc, binding, r.Scheme)
	})
	return err
}

func (r *TeamClawReconciler) reconcileWorkspace(ctx context.Context, tc *teav1.TeamClaw) error {
	if !tc.Spec.Workspace.Enabled || tc.Spec.Workspace.ExistingClaim != "" {
		return nil
	}
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: r.objectMeta(tc, tc.Name+"-workspace")}
	_, err := controllerutil.CreateOrPatch(ctx, r.Client, pvc, func() error {
		storage := resource.MustParse("20Gi")
		if tc.Spec.Workspace.Size != "" {
			storage = resource.MustParse(tc.Spec.Workspace.Size)
		}
		if pvc.CreationTimestamp.IsZero() {
			// Fresh claim: full spec.
			pvc.Spec = corev1.PersistentVolumeClaimSpec{
				AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
				Resources: corev1.VolumeResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceStorage: storage},
				},
			}
			if tc.Spec.Workspace.StorageClassName != "" {
				pvc.Spec.StorageClassName = &tc.Spec.Workspace.StorageClassName
			}
		} else {
			// Existing claim: PVC specs are immutable after creation except
			// resources.requests (expansion only). Rewriting the full spec
			// wipes VolumeName/StorageClassName in the patch and gets the
			// whole reconcile rejected ("spec is immutable after creation"),
			// which froze status updates on the k3s demo team.
			if pvc.Spec.Resources.Requests == nil {
				pvc.Spec.Resources.Requests = corev1.ResourceList{}
			}
			current := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
			if storage.Cmp(current) > 0 {
				pvc.Spec.Resources.Requests[corev1.ResourceStorage] = storage
			}
		}
		return controllerutil.SetControllerReference(tc, pvc, r.Scheme)
	})
	return err
}

func (r *TeamClawReconciler) reconcileDeployment(ctx context.Context, tc *teav1.TeamClaw) error {
	dep := &appsv1.Deployment{ObjectMeta: r.objectMeta(tc, tc.Name+"-controller")}
	_, err := controllerutil.CreateOrPatch(ctx, r.Client, dep, func() error {
		labels := labelsFor(tc)
		dep.Spec.Selector = &metav1.LabelSelector{MatchLabels: labels}
		// D4: single replica + Recreate until team-state storage is externalized.
		dep.Spec.Replicas = ptr(int32(1))
		dep.Spec.Strategy = appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType}
		dep.Spec.Template = corev1.PodTemplateSpec{
			ObjectMeta: metav1.ObjectMeta{Labels: labels},
			Spec: corev1.PodSpec{
				ServiceAccountName: tc.Name + "-controller",
				SecurityContext:    &corev1.PodSecurityContext{FSGroup: ptr(int64(1000))},
				Containers:         []corev1.Container{r.controllerContainer(tc)},
				Volumes:            r.volumes(tc),
			},
		}
		return controllerutil.SetControllerReference(tc, dep, r.Scheme)
	})
	return err
}

// controllerContainer builds the controller container spec (translated from
// the helm chart deployment template).
func (r *TeamClawReconciler) controllerContainer(tc *teav1.TeamClaw) corev1.Container {
	bootstrap := strings.Join([]string{
		"set -eu",
		"mkdir -p " + openclawHome + "/.openclaw",
		"cp /tmp/config/" + controllerSecretKey + " " + openclawHome + "/.openclaw/" + controllerSecretKey,
		"set -eu\nmkdir -p /home/node/.openclaw/extensions\ncp /tmp/config/openclaw.json /home/node/.openclaw/openclaw.json\nln -sfn /app/extensions/teamclaw /home/node/.openclaw/extensions/teamclaw\nexec node /app/openclaw.mjs gateway --allow-unconfigured",
	}, "\n")
	return corev1.Container{
		Name:  "controller",
		Image: tc.Spec.Image,
		// Default spec.image uses a rolling :latest tag; IfNotPresent pins stale
		// node-local layers forever (observed in k3s e2e), so always pull.
		ImagePullPolicy: corev1.PullAlways,
		Command:         []string{"sh", "-lc"},
		Args:            []string{bootstrap},
		Env: append([]corev1.EnvVar{
			{Name: "HOME", Value: openclawHome},
			{Name: "OPENCLAW_HOME", Value: openclawHome},
			{Name: "OPENCLAW_STATE_DIR", Value: openclawHome + "/.openclaw"},
			{Name: "OPENCLAW_CONFIG_PATH", Value: openclawHome + "/.openclaw/" + controllerSecretKey},
		}, tc.Spec.Controller.Env...),
		Ports:          []corev1.ContainerPort{{Name: "http", ContainerPort: controllerContainerPort, Protocol: corev1.ProtocolTCP}},
		ReadinessProbe: r.probe(5, 5),
		LivenessProbe:  r.probe(15, 10),
		StartupProbe:   &corev1.Probe{ProbeHandler: r.handler(), FailureThreshold: 30, PeriodSeconds: 5},
		Resources:      tc.Spec.Controller.Resources,
		SecurityContext: &corev1.SecurityContext{
			RunAsNonRoot:             ptr(true),
			RunAsUser:                ptr(int64(1000)),
			RunAsGroup:               ptr(int64(1000)),
			AllowPrivilegeEscalation: ptr(false),
		},
		VolumeMounts: r.volumeMounts(tc),
	}
}

func (r *TeamClawReconciler) reconcileService(ctx context.Context, tc *teav1.TeamClaw) error {
	svc := &corev1.Service{ObjectMeta: r.objectMeta(tc, tc.Name+"-controller")}
	port := tc.Spec.Network.ServicePort
	if port == 0 {
		port = 80
	}
	_, err := controllerutil.CreateOrPatch(ctx, r.Client, svc, func() error {
		svc.Spec.Type = corev1.ServiceTypeClusterIP
		svc.Spec.Selector = labelsFor(tc)
		svc.Spec.Ports = []corev1.ServicePort{{
			Name:       "http",
			Port:       port,
			TargetPort: intstr.FromString("http"),
			Protocol:   corev1.ProtocolTCP,
		}}
		return controllerutil.SetControllerReference(tc, svc, r.Scheme)
	})
	return err
}

func (r *TeamClawReconciler) reconcileIngress(ctx context.Context, tc *teav1.TeamClaw) error {
	name := types.NamespacedName{Namespace: tc.Namespace, Name: tc.Name + "-controller"}
	var existing networkingv1.Ingress
	getErr := r.Get(ctx, name, &existing)
	spec := tc.Spec.Network.Ingress
	if spec == nil || spec.Host == "" {
		// No ingress desired: delete any previously created one.
		if apierrors.IsNotFound(getErr) {
			return nil
		}
		if getErr != nil {
			return getErr
		}
		return client.IgnoreNotFound(r.Delete(ctx, &existing))
	}
	if getErr != nil && !apierrors.IsNotFound(getErr) {
		return getErr
	}
	ing := networkingv1.Ingress{ObjectMeta: r.objectMeta(tc, tc.Name+"-controller")}
	_, err := controllerutil.CreateOrPatch(ctx, r.Client, &ing, func() error {
		pathType := networkingv1.PathTypePrefix
		ing.Spec.Rules = []networkingv1.IngressRule{{
			Host: spec.Host,
			IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{
				Paths: []networkingv1.HTTPIngressPath{{
					Path:     "/",
					PathType: &pathType,
					Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{
						Name: tc.Name + "-controller",
						Port: networkingv1.ServiceBackendPort{Name: "http"},
					}},
				}},
			}},
		}}
		if spec.IngressClassName != "" {
			ing.Spec.IngressClassName = &spec.IngressClassName
		}
		if spec.TLSSecretName != "" {
			ing.Spec.TLS = []networkingv1.IngressTLS{{Hosts: []string{spec.Host}, SecretName: spec.TLSSecretName}}
		}
		ing.Annotations = spec.Annotations
		return controllerutil.SetControllerReference(tc, &ing, r.Scheme)
	})
	return err
}

func (r *TeamClawReconciler) reconcileStatus(ctx context.Context, tc *teav1.TeamClaw) error {
	var dep appsv1.Deployment
	depErr := r.Get(ctx, types.NamespacedName{Namespace: tc.Namespace, Name: tc.Name + "-controller"}, &dep)
	var pods corev1.PodList
	_ = r.List(ctx, &pods, client.InNamespace(tc.Namespace), client.MatchingLabels{
		"teamclaw.managed": "true",
		"teamclaw.team":    sanitize(tc.Spec.TeamName, 40),
	})
	var running, pending int32
	for _, pod := range pods.Items {
		switch pod.Status.Phase {
		case corev1.PodRunning:
			running++
		case corev1.PodPending:
			pending++
		}
	}
	return r.patchStatus(ctx, tc, func(s *teav1.TeamClawStatus) {
		s.ControllerEndpoint = fmt.Sprintf("http://%s-controller.%s.svc", tc.Name, tc.Namespace)
		s.WorkerPods = teav1.WorkerPodsStatus{Running: running, Pending: pending}
		if depErr != nil {
			setCondition(s, "Ready", metav1.ConditionFalse, "controller deployment not found")
			return
		}
		if dep.Status.ReadyReplicas >= 1 {
			setCondition(s, "Ready", metav1.ConditionTrue, "controller is ready")
		} else {
			setCondition(s, "Ready", metav1.ConditionFalse, "controller is not ready yet")
		}
	})
}

func (r *TeamClawReconciler) patchStatus(ctx context.Context, tc *teav1.TeamClaw, mutate func(*teav1.TeamClawStatus)) error {
	base := tc.DeepCopy()
	mutate(&base.Status)
	if equalStatus(base.Status, tc.Status) {
		return nil
	}
	return r.Status().Patch(ctx, base, client.MergeFrom(tc.DeepCopy()))
}

func equalStatus(a, b teav1.TeamClawStatus) bool {
	if a.ControllerEndpoint != b.ControllerEndpoint || a.WorkerPods != b.WorkerPods {
		return false
	}
	if len(a.Conditions) != len(b.Conditions) {
		return false
	}
	for i := range a.Conditions {
		if a.Conditions[i].Type != b.Conditions[i].Type ||
			a.Conditions[i].Status != b.Conditions[i].Status ||
			a.Conditions[i].Reason != b.Conditions[i].Reason {
			return false
		}
	}
	return true
}

func setCondition(s *teav1.TeamClawStatus, condType string, status metav1.ConditionStatus, message string) {
	for i := range s.Conditions {
		if s.Conditions[i].Type == condType {
			s.Conditions[i].Status = status
			s.Conditions[i].Message = message
			s.Conditions[i].Reason = reasonFor(status)
			s.Conditions[i].LastTransitionTime = metav1.Now()
			return
		}
	}
	s.Conditions = append(s.Conditions, metav1.Condition{
		Type:               condType,
		Status:             status,
		Reason:             reasonFor(status),
		Message:            message,
		LastTransitionTime: metav1.Now(),
	})
}

func reasonFor(status metav1.ConditionStatus) string {
	if status == metav1.ConditionTrue {
		return "Succeeded"
	}
	return "Progressing"
}

func (r *TeamClawReconciler) objectMeta(tc *teav1.TeamClaw, name string) metav1.ObjectMeta {
	return metav1.ObjectMeta{
		Name:      name,
		Namespace: tc.Namespace,
		Labels:    labelsFor(tc),
	}
}

func (r *TeamClawReconciler) handler() corev1.ProbeHandler {
	return corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/api/v1/health", Port: intstr.FromString("http")}}
}

func (r *TeamClawReconciler) probe(initialDelay, period int32) *corev1.Probe {
	return &corev1.Probe{ProbeHandler: r.handler(), InitialDelaySeconds: initialDelay, PeriodSeconds: period}
}

func (r *TeamClawReconciler) volumeMounts(tc *teav1.TeamClaw) []corev1.VolumeMount {
	mounts := []corev1.VolumeMount{
		{Name: "config", MountPath: "/tmp/config", ReadOnly: true},
	}
	if tc.Spec.Workspace.Enabled {
		mounts = append(mounts, corev1.VolumeMount{Name: "workspace", MountPath: workspaceMountPath})
	}
	return mounts
}

func (r *TeamClawReconciler) volumes(tc *teav1.TeamClaw) []corev1.Volume {
	volumes := []corev1.Volume{
		{Name: "state", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
		{Name: "config", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
			SecretName: tc.Spec.Controller.ModelConfigSecretRef,
		}}},
	}
	if tc.Spec.Workspace.Enabled {
		claim := tc.Spec.Workspace.ExistingClaim
		if claim == "" {
			claim = tc.Name + "-workspace"
		}
		volumes = append(volumes, corev1.Volume{Name: "workspace", VolumeSource: corev1.VolumeSource{
			PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: claim},
		}})
	}
	return volumes
}

func ptr[T any](v T) *T { return &v }

// SetupWithManager wires the controller into the manager.
func (r *TeamClawReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&teav1.TeamClaw{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Complete(r)
}
