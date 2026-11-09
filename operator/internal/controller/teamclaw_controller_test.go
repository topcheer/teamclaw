// Unit tests for the TeamClaw reconciler (fake client, no envtest needed).
//
// Regression guards for #224:
//   - the worker-pod List selector must match the labels the operator stamps
//     (a mismatch made status.workerPods permanently 0 with no error signal)
//   - reconcileStatus must count labelled pods and keep previous counts on
//     List errors instead of silently reporting 0
//   - equalStatus must compare condition Messages so error text doesn't go stale
//   - reconcileDeployment must preserve third-party pod-template annotations
package controller

import (
	"context"
	"errors"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	klabels "k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	teav1 "github.com/topcheer/teamclaw/operator/api/v1"
)

func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	sch := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(sch); err != nil {
		t.Fatalf("clientgo scheme: %v", err)
	}
	if err := teav1.AddToScheme(sch); err != nil {
		t.Fatalf("teamclaw scheme: %v", err)
	}
	return sch
}

// TestWorkerPodSelectorMatchesLabels asserts the invariant at the heart of
// #224: every label the pod List selector demands is stamped by labelsFor,
// so the selector actually selects the operator's pods.
func TestWorkerPodSelectorMatchesLabels(t *testing.T) {
	tm := &teav1.TeamClaw{
		ObjectMeta: metav1.ObjectMeta{Name: "alpha", Namespace: "default"},
		Spec:       teav1.TeamClawSpec{TeamName: "Alpha Team!"},
	}
	stamped := labelsFor(tm)
	selector := workerPodSelector(tm)
	if len(selector) == 0 {
		t.Fatal("workerPodSelector is empty")
	}
	for k, v := range selector {
		got, ok := stamped[k]
		if !ok {
			t.Errorf("selector key %q is never stamped by labelsFor - pods will never match (the #224 bug)", k)
			continue
		}
		if got != v {
			t.Errorf("selector %s=%q but labelsFor stamps %s=%q", k, v, k, got)
		}
	}

	// End-to-end check: the selector matches a pod carrying labelsFor output.
	sel, err := metav1.LabelSelectorAsSelector(&metav1.LabelSelector{MatchLabels: selector})
	if err != nil {
		t.Fatalf("selector conversion: %v", err)
	}
	if !sel.Matches(klabels.Set(stamped)) {
		t.Errorf("selector %v does not match labelsFor output %v", selector, stamped)
	}
	// ...and does not match the stale pre-#224 label set.
	stale := klabels.Set{"teamclaw.managed": "true", "teamclaw.team": sanitize(tm.Spec.TeamName, 40)}
	if sel.Matches(stale) {
		t.Errorf("selector unexpectedly matches stale teamclaw.managed/team labels")
	}
}

func newTestClient(t *testing.T, objs ...client.Object) client.WithWatch {
	t.Helper()
	return fake.NewClientBuilder().
		WithScheme(testScheme(t)).
		WithStatusSubresource(&teav1.TeamClaw{}).
		WithObjects(objs...).
		Build()
}

func podWithLabels(name, namespace string, labels map[string]string, phase corev1.PodPhase) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, Labels: labels},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

// TestReconcileStatusCountsWorkerPods: pods stamped by labelsFor are counted;
// pods with stale labels or in other namespaces are not.
func TestReconcileStatusCountsWorkerPods(t *testing.T) {
	tm := &teav1.TeamClaw{
		ObjectMeta: metav1.ObjectMeta{Name: "alpha", Namespace: "default"},
		Spec: teav1.TeamClawSpec{
			TeamName:   "Alpha Team",
			Controller: teav1.ControllerSpec{ModelConfigSecretRef: "alpha-config"},
		},
	}
	c := newTestClient(t, tm,
		podWithLabels("w1", "default", labelsFor(tm), corev1.PodRunning),
		podWithLabels("w2", "default", labelsFor(tm), corev1.PodPending),
		podWithLabels("w3", "default", labelsFor(tm), corev1.PodSucceeded), // not running/pending
		// Stale pre-#224 labels: must never be counted.
		podWithLabels("stale", "default", map[string]string{
			"teamclaw.managed": "true",
			"teamclaw.team":    sanitize(tm.Spec.TeamName, 40),
		}, corev1.PodRunning),
		// Same instance label but different namespace: must not be counted.
		podWithLabels("other-ns", "elsewhere", labelsFor(tm), corev1.PodRunning),
	)
	ctx := context.Background()

	var fresh teav1.TeamClaw
	if err := c.Get(ctx, types.NamespacedName{Namespace: "default", Name: "alpha"}, &fresh); err != nil {
		t.Fatalf("get teamclaw: %v", err)
	}
	r := &TeamClawReconciler{Client: c, Scheme: c.Scheme()}
	if err := r.reconcileStatus(ctx, &fresh); err != nil {
		t.Fatalf("reconcileStatus: %v", err)
	}

	var after teav1.TeamClaw
	if err := c.Get(ctx, types.NamespacedName{Namespace: "default", Name: "alpha"}, &after); err != nil {
		t.Fatalf("get after: %v", err)
	}
	if after.Status.WorkerPods.Running != 1 || after.Status.WorkerPods.Pending != 1 {
		t.Errorf("workerPods = running:%d pending:%d, want running:1 pending:1", after.Status.WorkerPods.Running, after.Status.WorkerPods.Pending)
	}
	if after.Status.ControllerEndpoint != "http://alpha-controller.default.svc" {
		t.Errorf("controllerEndpoint = %q", after.Status.ControllerEndpoint)
	}
	var ready *metav1.Condition
	for i := range after.Status.Conditions {
		if after.Status.Conditions[i].Type == "Ready" {
			ready = &after.Status.Conditions[i]
		}
	}
	if ready == nil || ready.Status != metav1.ConditionFalse {
		t.Errorf("Ready condition = %+v, want False (no deployment in fixture)", ready)
	}
}

// TestReconcileStatusKeepsCountsOnListError: a failing pod List must keep the
// previously observed counts, not silently report 0 (#224).
func TestReconcileStatusKeepsCountsOnListError(t *testing.T) {
	tm := &teav1.TeamClaw{
		ObjectMeta: metav1.ObjectMeta{Name: "alpha", Namespace: "default"},
		Spec: teav1.TeamClawSpec{
			TeamName:   "Alpha Team",
			Controller: teav1.ControllerSpec{ModelConfigSecretRef: "alpha-config"},
		},
		Status: teav1.TeamClawStatus{WorkerPods: teav1.WorkerPodsStatus{Running: 5, Pending: 2}},
	}
	c := fake.NewClientBuilder().
		WithScheme(testScheme(t)).
		WithStatusSubresource(&teav1.TeamClaw{}).
		WithObjects(tm).
		WithInterceptorFuncs(interceptor.Funcs{
			List: func(ctx context.Context, cl client.WithWatch, list client.ObjectList, opts ...client.ListOption) error {
				if _, ok := list.(*corev1.PodList); ok {
					return errors.New("api server unreachable")
				}
				return cl.List(ctx, list, opts...)
			},
		}).
		Build()
	ctx := context.Background()

	var fresh teav1.TeamClaw
	if err := c.Get(ctx, types.NamespacedName{Namespace: "default", Name: "alpha"}, &fresh); err != nil {
		t.Fatalf("get teamclaw: %v", err)
	}
	r := &TeamClawReconciler{Client: c, Scheme: c.Scheme()}
	if err := r.reconcileStatus(ctx, &fresh); err != nil {
		t.Fatalf("reconcileStatus: %v", err)
	}

	var after teav1.TeamClaw
	if err := c.Get(ctx, types.NamespacedName{Namespace: "default", Name: "alpha"}, &after); err != nil {
		t.Fatalf("get after: %v", err)
	}
	if after.Status.WorkerPods.Running != 5 || after.Status.WorkerPods.Pending != 2 {
		t.Errorf("workerPods = running:%d pending:%d, want preserved running:5 pending:2", after.Status.WorkerPods.Running, after.Status.WorkerPods.Pending)
	}
}

// TestEqualStatusComparesMessage: Message-only changes must produce unequal
// status so error messages don't go stale (#224 W3).
func TestEqualStatusComparesMessage(t *testing.T) {
	a := teav1.TeamClawStatus{Conditions: []metav1.Condition{{
		Type: "Ready", Status: metav1.ConditionFalse, Reason: "Progressing", Message: "config secret not found",
	}}}
	b := teav1.TeamClawStatus{Conditions: []metav1.Condition{{
		Type: "Ready", Status: metav1.ConditionFalse, Reason: "Progressing", Message: "deployment not ready",
	}}}
	if equalStatus(a, b) {
		t.Error("equalStatus ignored Message difference")
	}
	b.Conditions[0].Message = a.Conditions[0].Message
	if !equalStatus(a, b) {
		t.Error("equalStatus must treat identical status as equal")
	}
}

// TestReconcileDeploymentPreservesTemplateAnnotations: annotations injected on
// the pod template by third parties (webhook mutators) must survive a
// reconcile that rebuilds the template (#224 Info).
func TestReconcileDeploymentPreservesTemplateAnnotations(t *testing.T) {
	tm := &teav1.TeamClaw{
		ObjectMeta: metav1.ObjectMeta{Name: "alpha", Namespace: "default"},
		Spec: teav1.TeamClawSpec{
			TeamName:   "Alpha Team",
			Image:      "ghcr.io/topcheer/teamclaw-openclaw:latest",
			Controller: teav1.ControllerSpec{ModelConfigSecretRef: "alpha-config"},
		},
	}
	c := newTestClient(t, tm)
	ctx := context.Background()

	r := &TeamClawReconciler{Client: c, Scheme: c.Scheme()}
	if err := r.reconcileDeployment(ctx, tm); err != nil {
		t.Fatalf("first reconcileDeployment: %v", err)
	}

	// Simulate a mutating webhook stamping an annotation after creation.
	dep := &appsv1.Deployment{}
	key := types.NamespacedName{Namespace: "default", Name: "alpha-controller"}
	if err := c.Get(ctx, key, dep); err != nil {
		t.Fatalf("get deployment: %v", err)
	}
	dep.Spec.Template.Annotations = map[string]string{"vault.example.com/agent-inject": "true"}
	if err := c.Update(ctx, dep); err != nil {
		t.Fatalf("inject annotation: %v", err)
	}

	if err := r.reconcileDeployment(ctx, tm); err != nil {
		t.Fatalf("second reconcileDeployment: %v", err)
	}
	dep = &appsv1.Deployment{}
	if err := c.Get(ctx, key, dep); err != nil {
		t.Fatalf("get deployment after: %v", err)
	}
	if dep.Spec.Template.Annotations["vault.example.com/agent-inject"] != "true" {
		t.Errorf("third-party template annotation wiped by reconcile: %v", dep.Spec.Template.Annotations)
	}
	// No stray volumes: the unused "state" EmptyDir must stay gone (#224).
	for _, v := range dep.Spec.Template.Spec.Volumes {
		if v.Name == "state" {
			t.Errorf("unused state EmptyDir volume still present")
		}
	}
}
