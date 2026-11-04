//go:build integration

// Integration tests for the TeamClaw reconciler (envtest).
//
// Skipped unless KUBEBUILDER_ASSETS is set - run via:
//
//	make test-integration   (downloads envtest assets via setup-envtest)
//
// Covers the two regressions that burned real clusters:
//   - reconcileService honoring spec.network.serviceType/nodePort (#113)
//   - reconcileWorkspace not rewriting a bound PVC spec (#104)
package controller

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	teav1 "github.com/topcheer/teamclaw/operator/api/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
)

func startEnvTest(t *testing.T) client.Client {
	t.Helper()
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("KUBEBUILDER_ASSETS not set; run `make test-integration` (setup-envtest) to enable")
	}
	logf.SetLogger(zap.New(zap.WriteTo(testWriter(t))))
	// go test runs with cwd = <operator>/internal/controller; resolve the CRD
	// dir relative to the actual working directory so it works from anywhere.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	crdDir := filepath.Join(filepath.Dir(filepath.Dir(wd)), "config", "crd", "bases")
	testEnv := &envtest.Environment{
		CRDDirectoryPaths:     []string{crdDir},
		ErrorIfCRDPathMissing: true,
	}
	cfg, err := testEnv.Start()
	if err != nil {
		t.Fatalf("envtest start: %v", err)
	}
	t.Cleanup(func() { _ = testEnv.Stop() })
	scheme := runtime.NewScheme()
	_ = teav1.AddToScheme(scheme)
	_ = corev1.AddToScheme(scheme)
	c, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	return c
}

func testWriter(t *testing.T) *testLogWriter { return &testLogWriter{t: t} }

type testLogWriter struct{ t *testing.T }

func (w *testLogWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", p)
	return len(p), nil
}

func testTeam(name string) *teav1.TeamClaw {
	return &teav1.TeamClaw{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: teav1.TeamClawSpec{
			TeamName: name,
			Image:    "ghcr.io/topcheer/teamclaw-openclaw:latest",
			Controller: teav1.ControllerSpec{
				ModelConfigSecretRef: name + "-config",
			},
			Workspace: teav1.WorkspaceSpec{Enabled: false},
		},
	}
}

// TestReconcileServiceTypeNodePort: spec.network.serviceType/nodePort and
// serviceAnnotations must reach the Service (#113 regression guard).
func TestReconcileServiceTypeNodePort(t *testing.T) {
	c := startEnvTest(t)
	ctx := context.Background()

	tm := testTeam("svc-np")
	tm.Spec.Network = teav1.NetworkSpec{
		ServiceType:        "NodePort",
		NodePort:           31999,
		ServiceAnnotations: map[string]string{"test.example/ann": "x"},
	}
	if err := c.Create(ctx, tm); err != nil {
		t.Fatalf("create teamclaw: %v", err)
	}

	r := &TeamClawReconciler{Client: c, Scheme: c.Scheme()}
	if err := r.reconcileService(ctx, tm); err != nil {
		t.Fatalf("reconcileService: %v", err)
	}

	svc := &corev1.Service{}
	if err := c.Get(ctx, types.NamespacedName{Namespace: "default", Name: "svc-np-controller"}, svc); err != nil {
		t.Fatalf("get service: %v", err)
	}
	if svc.Spec.Type != corev1.ServiceTypeNodePort {
		t.Errorf("type = %s, want NodePort", svc.Spec.Type)
	}
	if n := svc.Spec.Ports[0].NodePort; n != 31999 {
		t.Errorf("nodePort = %d, want 31999", n)
	}
	if svc.Annotations["test.example/ann"] != "x" {
		t.Errorf("serviceAnnotations not merged: %v", svc.Annotations)
	}
}

// TestReconcileWorkspaceIdempotent: a second reconcile pass must not fail
// with a spec-immutability patch error (#104 regression guard).
func TestReconcileWorkspaceIdempotent(t *testing.T) {
	c := startEnvTest(t)
	ctx := context.Background()

	tm := testTeam("pvc-idem")
	tm.Spec.Workspace = teav1.WorkspaceSpec{Enabled: true, Size: "1Gi"}
	sc := "standard"
	tm.Spec.Workspace.StorageClassName = sc
	if err := c.Create(ctx, tm); err != nil {
		t.Fatalf("create: %v", err)
	}
	r := &TeamClawReconciler{Client: c, Scheme: c.Scheme()}
	if err := r.reconcileWorkspace(ctx, tm); err != nil {
		t.Fatalf("first reconcileWorkspace: %v", err)
	}

	// Second pass (same spec) must succeed without an immutable-spec patch.
	if err := r.reconcileWorkspace(ctx, tm); err != nil {
		t.Fatalf("second reconcileWorkspace: %v (immutable-spec regression)", err)
	}

	pvc := &corev1.PersistentVolumeClaim{}
	if err := c.Get(ctx, types.NamespacedName{Namespace: "default", Name: "pvc-idem-workspace"}, pvc); err != nil {
		t.Fatalf("get pvc: %v", err)
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != sc {
		t.Errorf("storageClassName = %v, want %s (full-spec rewrite wiped it)", pvc.Spec.StorageClassName, sc)
	}
}
