package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	teav1 "github.com/topcheer/teamclaw/operator/api/v1"
	"github.com/topcheer/teamclaw/operator/internal/controller"
	"github.com/topcheer/teamclaw/operator/ui"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(teav1.AddToScheme(scheme))
}

// teamSummary is the UI-facing projection of a TeamClaw CR.
type teamSummary struct {
	Name         string `json:"name"`
	TeamName     string `json:"teamName"`
	Image        string `json:"image"`
	Endpoint     string `json:"endpoint"`
	ConfigSecret string `json:"configSecret"`
	Workspace    *struct {
		Enabled          bool   `json:"enabled"`
		Size             string `json:"size"`
		StorageClassName string `json:"storageClassName"`
	} `json:"workspace,omitempty"`
	Ingress      string `json:"ingress,omitempty"`
	IngressClass string `json:"ingressClass,omitempty"`
	IngressTls   string `json:"ingressTls,omitempty"`
	Workers      *struct {
		Running int32 `json:"running"`
		Pending int32 `json:"pending"`
	} `json:"workers,omitempty"`
	Conditions []condSummary `json:"conditions"`
}

type condSummary struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

func summarize(tc *teav1.TeamClaw) teamSummary {
	s := teamSummary{
		Name:         tc.Name,
		TeamName:     tc.Spec.TeamName,
		Image:        tc.Spec.Image,
		Endpoint:     tc.Status.ControllerEndpoint,
		ConfigSecret: tc.Spec.Controller.ModelConfigSecretRef,
	}
	if tc.Spec.Workspace.Enabled {
		s.Workspace = &struct {
			Enabled          bool   `json:"enabled"`
			Size             string `json:"size"`
			StorageClassName string `json:"storageClassName"`
		}{Enabled: true, Size: tc.Spec.Workspace.Size, StorageClassName: tc.Spec.Workspace.StorageClassName}
	}
	if ing := tc.Spec.Network.Ingress; ing != nil {
		s.Ingress = ing.Host
		s.IngressClass = ing.IngressClassName
		s.IngressTls = ing.TLSSecretName
	}
	if tc.Status.WorkerPods.Running > 0 || tc.Status.WorkerPods.Pending > 0 {
		s.Workers = &struct {
			Running int32 `json:"running"`
			Pending int32 `json:"pending"`
		}{Running: tc.Status.WorkerPods.Running, Pending: tc.Status.WorkerPods.Pending}
	}
	for _, c := range tc.Status.Conditions {
		s.Conditions = append(s.Conditions, condSummary{Type: c.Type, Status: string(c.Status), Message: c.Message})
	}
	return s
}

// teamUpsert is the create/update payload accepted from the UI.
type teamUpsert struct {
	Spec *struct {
		TeamName  string `json:"teamName"`
		Image     string `json:"image"`
		Workspace *struct {
			Enabled          bool   `json:"enabled"`
			Size             string `json:"size"`
			StorageClassName string `json:"storageClassName"`
		} `json:"workspace"`
		Controller *struct {
			ModelConfigSecretRef string `json:"modelConfigSecretRef"`
		} `json:"controller"`
		Network *struct {
			Ingress *struct {
				Host             string            `json:"host"`
				IngressClassName string            `json:"ingressClassName"`
				TLSSecretName    string            `json:"tlsSecretName"`
				Annotations      map[string]string `json:"annotations"`
			} `json:"ingress"`
		} `json:"network"`
	} `json:"spec"`
	// ConfigJson optionally carries an inline openclaw.json; the API creates
	// the backing Secret (<name>-config) and wires modelConfigSecretRef.
	ConfigJson string `json:"configJson"`
}

func (u *teamUpsert) applySpecTo(tc *teav1.TeamClaw) {
	if u.Spec == nil {
		return
	}
	if u.Spec.TeamName != "" {
		tc.Spec.TeamName = u.Spec.TeamName
	}
	if u.Spec.Image != "" {
		tc.Spec.Image = u.Spec.Image
	}
	if u.Spec.Workspace != nil {
		tc.Spec.Workspace = teav1.WorkspaceSpec{
			Enabled:          u.Spec.Workspace.Enabled,
			Size:             u.Spec.Workspace.Size,
			StorageClassName: u.Spec.Workspace.StorageClassName,
		}
	}
	if u.Spec.Controller != nil && u.Spec.Controller.ModelConfigSecretRef != "" {
		tc.Spec.Controller.ModelConfigSecretRef = u.Spec.Controller.ModelConfigSecretRef
	}
	if u.Spec.Network != nil {
		if u.Spec.Network.Ingress != nil && u.Spec.Network.Ingress.Host != "" {
			tc.Spec.Network.Ingress = &teav1.IngressSpec{
				Host:             u.Spec.Network.Ingress.Host,
				IngressClassName: u.Spec.Network.Ingress.IngressClassName,
				TLSSecretName:    u.Spec.Network.Ingress.TLSSecretName,
				Annotations:      u.Spec.Network.Ingress.Annotations,
			}
		} else {
			tc.Spec.Network.Ingress = nil
		}
	}
}

func writeErr(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func bearerOK(req *http.Request, token string) bool {
	if token == "" {
		return true
	}
	return strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ") == token
}

// uiServer serves the operator HTTP face: static UI + token-guarded JSON API.
func uiServer(token string, k8s client.Client) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		page := ui.Index()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(page)
	})

	guard := func(w http.ResponseWriter, req *http.Request) bool {
		if !bearerOK(req, token) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return false
		}
		return true
	}

	mux.HandleFunc("/api/v1/teams", func(w http.ResponseWriter, req *http.Request) {
		if !guard(w, req) {
			return
		}
		ctx := req.Context()
		switch req.Method {
		case http.MethodGet:
			var list teav1.TeamClawList
			if err := k8s.List(ctx, &list); err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			teams := make([]teamSummary, 0, len(list.Items))
			for i := range list.Items {
				teams = append(teams, summarize(&list.Items[i]))
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"teams": teams})
		case http.MethodPost:
			body, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
			if err != nil {
				writeErr(w, http.StatusBadRequest, "unreadable body")
				return
			}
			var up teamUpsert
			if err := json.Unmarshal(body, &up); err != nil {
				writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
				return
			}
			name := req.URL.Query().Get("name")
			var payload struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(body, &payload)
			if payload.Name != "" {
				name = payload.Name
			}
			if name == "" {
				writeErr(w, http.StatusBadRequest, "name is required")
				return
			}
			tc := &teav1.TeamClaw{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespaceOf(req)}}
			up.applySpecTo(tc)
			if err := ensureInlineConfig(ctx, k8s, tc, up.ConfigJson); err != nil {
				writeErr(w, http.StatusBadRequest, err.Error())
				return
			}
			if err := k8s.Create(ctx, tc); err != nil {
				writeErr(w, http.StatusConflict, err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(summarize(tc))
		default:
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	})

	mux.HandleFunc("/api/v1/teams/", func(w http.ResponseWriter, req *http.Request) {
		if !guard(w, req) {
			return
		}
		name := strings.TrimPrefix(req.URL.Path, "/api/v1/teams/")
		if name == "" || strings.Contains(name, "/") {
			writeErr(w, http.StatusBadRequest, "bad team name")
			return
		}
		ctx := req.Context()
		key := types.NamespacedName{Namespace: namespaceOf(req), Name: name}
		var tc teav1.TeamClaw
		if err := k8s.Get(ctx, key, &tc); err != nil {
			if apierrors.IsNotFound(err) {
				writeErr(w, http.StatusNotFound, "not found")
			} else {
				writeErr(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		switch req.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(summarize(&tc))
		case http.MethodPut:
			body, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
			if err != nil {
				writeErr(w, http.StatusBadRequest, "unreadable body")
				return
			}
			var up teamUpsert
			if err := json.Unmarshal(body, &up); err != nil {
				writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
				return
			}
			// Preserve immutable identity; only apply editable spec fields.
			up.applySpecTo(&tc)
			if err := ensureInlineConfig(ctx, k8s, &tc, up.ConfigJson); err != nil {
				writeErr(w, http.StatusBadRequest, err.Error())
				return
			}
			if err := k8s.Update(ctx, &tc); err != nil {
				writeErr(w, http.StatusConflict, err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(summarize(&tc))
		case http.MethodDelete:
			if err := k8s.Delete(ctx, &tc); err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	})
	return mux
}

// namespaceOf resolves the target namespace: explicit ?namespace= override,
// else the operator's own namespace (the common case: teams live alongside).
func namespaceOf(req *http.Request) string {
	if ns := req.URL.Query().Get("namespace"); ns != "" {
		return ns
	}
	return os.Getenv("TEAMCLAW_OPERATOR_NAMESPACE")
}

// ensureInlineConfig creates/updates the backing Secret when an inline
// openclaw.json is supplied and points spec.controller.modelConfigSecretRef
// at it. With no inline payload it only validates that a ref exists.
func ensureInlineConfig(ctx context.Context, k8s client.Client, tc *teav1.TeamClaw, configJson string) error {
	if configJson == "" {
		if tc.Spec.Controller.ModelConfigSecretRef == "" {
			return fmt.Errorf("either spec.controller.modelConfigSecretRef or inline configJson is required")
		}
		return nil
	}
	var check map[string]any
	if err := json.Unmarshal([]byte(configJson), &check); err != nil {
		return fmt.Errorf("configJson is not valid JSON: %w", err)
	}
	secretName := tc.Name + "-config"
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: secretName, Namespace: tc.Namespace}}
	existing := &corev1.Secret{}
	err := k8s.Get(ctx, types.NamespacedName{Namespace: tc.Namespace, Name: secretName}, existing)
	if apierrors.IsNotFound(err) {
		secret.Data = map[string][]byte{"openclaw.json": []byte(configJson)}
		if err := k8s.Create(ctx, secret); err != nil {
			return fmt.Errorf("create config secret: %w", err)
		}
	} else if err == nil {
		existing.Data = map[string][]byte{"openclaw.json": []byte(configJson)}
		if err := k8s.Update(ctx, existing); err != nil {
			return fmt.Errorf("update config secret: %w", err)
		}
	} else {
		return err
	}
	tc.Spec.Controller.ModelConfigSecretRef = secretName
	return nil
}

func generateToken() string {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

func main() {
	var metricsAddr string
	var probeAddr string
	var uiAddr string
	var enableLeaderElection bool
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "metrics server bind")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "health probe bind")
	flag.StringVar(&uiAddr, "ui-bind-address", ":9090", "operator UI bind")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true, "leader election")
	opts := zap.Options{Development: false}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "teamclaw-operator.teamclaw.dev",
	})
	if err != nil {
		ctrl.Log.Error(err, "manager setup failed")
		os.Exit(1)
	}

	if err := (&controller.TeamClawReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		ctrl.Log.Error(err, "controller setup failed")
		os.Exit(1)
	}
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		ctrl.Log.Error(err, "health check setup failed")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		ctrl.Log.Error(err, "ready check setup failed")
		os.Exit(1)
	}

	// Operator UI (NodePort service targets this port).
	token := os.Getenv("TEAMCLAW_OPERATOR_UI_TOKEN")
	if token == "" {
		token = generateToken()
		ctrl.Log.Info("generated ephemeral operator UI token; set TEAMCLAW_OPERATOR_UI_TOKEN for stable auth")
	}
	if os.Getenv("TEAMCLAW_OPERATOR_NAMESPACE") == "" {
		// In-cluster default; harmless outside the cluster.
		os.Setenv("TEAMCLAW_OPERATOR_NAMESPACE", detectNamespace())
	}
	go func() {
		if err := http.ListenAndServe(uiAddr, uiServer(token, mgr.GetClient())); err != nil {
			ctrl.Log.Error(err, "operator UI server failed")
		}
	}()

	ctrl.Log.Info("starting teamclaw operator")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "operator exited")
		os.Exit(1)
	}
}

func detectNamespace() string {
	data, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if err == nil && len(data) > 0 {
		return strings.TrimSpace(string(data))
	}
	return "default"
}
