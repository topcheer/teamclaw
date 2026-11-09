package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/apimachinery/pkg/util/validation"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
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
	// Name names the TeamClaw CR (create path only; query ?name= also works).
	Name string `json:"name"`
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

// badRequestError marks caller-fixable payload problems so handlers can keep
// returning helpful 400s while k8s-internal errors go through writeK8sErr.
type badRequestError struct{ msg string }

func (e *badRequestError) Error() string { return e.msg }

// writeK8sErr maps a k8s API error to an HTTP response. The full error is
// logged server-side; callers get a stable, non-leaking message instead of
// verbatim client-go internals (#224 W5).
func writeK8sErr(w http.ResponseWriter, err error) {
	ctrl.Log.Error(err, "ui api: kubernetes operation failed")
	switch {
	case apierrors.IsNotFound(err):
		writeErr(w, http.StatusNotFound, "not found")
	case apierrors.IsAlreadyExists(err):
		writeErr(w, http.StatusConflict, "already exists")
	case apierrors.IsConflict(err):
		writeErr(w, http.StatusConflict, "conflict: resource changed concurrently, retry")
	case apierrors.IsInvalid(err), apierrors.IsBadRequest(err), apierrors.IsRequestEntityTooLargeError(err):
		writeErr(w, http.StatusBadRequest, "invalid resource")
	case apierrors.IsForbidden(err):
		writeErr(w, http.StatusForbidden, "forbidden")
	case apierrors.IsUnauthorized(err):
		writeErr(w, http.StatusUnauthorized, "unauthorized")
	default:
		writeErr(w, http.StatusInternalServerError, "internal error")
	}
}

func bearerOK(req *http.Request, token string) bool {
	if token == "" {
		return true
	}
	// Constant-time compare: a plain == leaks token length/prefix timing (#224).
	got := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}

// validTeamName enforces DNS-1123 subdomain naming (no "/", no spaces...):
// object names must satisfy it anyway, so reject early with a clean 400 (#224 W2).
func validTeamName(name string) bool {
	return name != "" && len(validation.IsDNS1123Subdomain(name)) == 0
}

// namespaceAllowlist bounds which namespaces the UI API may operate on. The
// operator RBAC is cluster-scoped, so without this a leaked UI token means
// cluster-wide create/update rights (#224 W1). Default: the operator's own
// namespace only; TEAMCLAW_ALLOWED_NAMESPACES (comma-separated) widens it.
type namespaceAllowlist struct {
	own     string
	allowed map[string]bool
}

func newNamespaceAllowlist() namespaceAllowlist {
	a := namespaceAllowlist{own: os.Getenv("TEAMCLAW_OPERATOR_NAMESPACE"), allowed: map[string]bool{}}
	for _, ns := range strings.Split(os.Getenv("TEAMCLAW_ALLOWED_NAMESPACES"), ",") {
		if ns = strings.TrimSpace(ns); ns != "" {
			a.allowed[ns] = true
		}
	}
	return a
}

// resolve returns the effective namespace for a request and whether the
// request may use it. ?namespace= overrides the operator namespace but must
// pass the allowlist and DNS-1123 label validation.
func (a namespaceAllowlist) resolve(req *http.Request) (string, bool) {
	ns := req.URL.Query().Get("namespace")
	if ns == "" {
		ns = a.own
	}
	if ns == "" || len(validation.IsDNS1123Label(ns)) > 0 {
		return ns, false
	}
	if ns == a.own || a.allowed[ns] {
		return ns, true
	}
	return ns, false
}

// uiServer serves the operator HTTP face: static UI + token-guarded JSON API.
func uiServer(token string, k8s client.Client, namespaces namespaceAllowlist) *http.ServeMux {
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

	// resolveNamespace guards every namespaced handler: the resolved
	// namespace must be valid and allowed (#224 W1).
	resolveNamespace := func(w http.ResponseWriter, req *http.Request) (string, bool) {
		ns, ok := namespaces.resolve(req)
		if !ok {
			writeErr(w, http.StatusBadRequest,
				"namespace not allowed: set TEAMCLAW_ALLOWED_NAMESPACES to enable teams beyond the operator namespace")
			return "", false
		}
		return ns, true
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
				writeK8sErr(w, err)
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
			name := up.Name
			if name == "" {
				name = req.URL.Query().Get("name")
			}
			if !validTeamName(name) {
				writeErr(w, http.StatusBadRequest, "name is required and must be a DNS-1123 subdomain (lowercase alphanumerics, '-', '.')")
				return
			}
			namespace, ok := resolveNamespace(w, req)
			if !ok {
				return
			}
			tc := &teav1.TeamClaw{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace}}
			up.applySpecTo(tc)
			// Inline config: validate the payload up front, wire the derived
			// secret ref, and create the CR first so the backing Secret can
			// carry an ownerReference - a failed CR create no longer orphans
			// a credential Secret (#224 W2).
			if up.ConfigJson != "" {
				var check map[string]any
				if err := json.Unmarshal([]byte(up.ConfigJson), &check); err != nil {
					writeErr(w, http.StatusBadRequest, "configJson is not valid JSON: "+err.Error())
					return
				}
				tc.Spec.Controller.ModelConfigSecretRef = name + "-config"
			} else if tc.Spec.Controller.ModelConfigSecretRef == "" {
				writeErr(w, http.StatusBadRequest, "either spec.controller.modelConfigSecretRef or inline configJson is required")
				return
			}
			if err := k8s.Create(ctx, tc); err != nil {
				writeK8sErr(w, err)
				return
			}
			if up.ConfigJson != "" {
				// The CR exists and points at the secret name; if this fails
				// the operator surfaces ConfigReady=False and the client
				// retries via PUT - nothing is orphaned.
				if err := ensureInlineConfig(ctx, k8s, tc, up.ConfigJson); err != nil {
					var bre *badRequestError
					if errors.As(err, &bre) {
						writeErr(w, http.StatusBadRequest, bre.Error())
					} else {
						writeK8sErr(w, err)
					}
					return
				}
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
		if !validTeamName(name) {
			writeErr(w, http.StatusBadRequest, "bad team name (must be a DNS-1123 subdomain)")
			return
		}
		namespace, ok := resolveNamespace(w, req)
		if !ok {
			return
		}
		ctx := req.Context()
		key := types.NamespacedName{Namespace: namespace, Name: name}
		var tc teav1.TeamClaw
		if err := k8s.Get(ctx, key, &tc); err != nil {
			writeK8sErr(w, err)
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
				var bre *badRequestError
				if errors.As(err, &bre) {
					writeErr(w, http.StatusBadRequest, bre.Error())
				} else {
					writeK8sErr(w, err)
				}
				return
			}
			if err := k8s.Update(ctx, &tc); err != nil {
				writeK8sErr(w, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(summarize(&tc))
		case http.MethodDelete:
			if err := k8s.Delete(ctx, &tc); err != nil {
				writeK8sErr(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	})
	return mux
}

// ensureInlineConfig creates/updates the backing Secret when an inline
// openclaw.json is supplied and points spec.controller.modelConfigSecretRef
// at it. With no inline payload it only validates that a ref exists. The
// Secret is owned by the TeamClaw CR, so model credentials are
// garbage-collected with the team instead of outliving it (#224 W2).
func ensureInlineConfig(ctx context.Context, k8s client.Client, tc *teav1.TeamClaw, configJson string) error {
	if configJson == "" {
		if tc.Spec.Controller.ModelConfigSecretRef == "" {
			return &badRequestError{msg: "either spec.controller.modelConfigSecretRef or inline configJson is required"}
		}
		return nil
	}
	var check map[string]any
	if err := json.Unmarshal([]byte(configJson), &check); err != nil {
		return &badRequestError{msg: "configJson is not valid JSON: " + err.Error()}
	}
	secretName := tc.Name + "-config"
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: secretName, Namespace: tc.Namespace}}
	existing := &corev1.Secret{}
	err := k8s.Get(ctx, types.NamespacedName{Namespace: tc.Namespace, Name: secretName}, existing)
	switch {
	case apierrors.IsNotFound(err):
		secret.Data = map[string][]byte{"openclaw.json": []byte(configJson)}
		// The owner UID is always populated here: callers Create/Get the CR
		// first, so the API server has already stamped metadata.uid.
		if err := controllerutil.SetControllerReference(tc, secret, scheme); err != nil {
			return fmt.Errorf("own config secret: %w", err)
		}
		if err := k8s.Create(ctx, secret); err != nil {
			return fmt.Errorf("create config secret: %w", err)
		}
	case err == nil:
		existing.Data = map[string][]byte{"openclaw.json": []byte(configJson)}
		// Refuse to steal a Secret already controlled by another owner.
		if err := controllerutil.SetControllerReference(tc, existing, scheme); err != nil {
			return fmt.Errorf("own config secret: %w", err)
		}
		if err := k8s.Update(ctx, existing); err != nil {
			return fmt.Errorf("update config secret: %w", err)
		}
	default:
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

	// Operator UI (NodePort service targets this port). Registered as a
	// manager runnable so graceful shutdown covers it and the server gets
	// sane timeouts instead of a bare ListenAndServe (#224 W4).
	token := os.Getenv("TEAMCLAW_OPERATOR_UI_TOKEN")
	if token == "" {
		token = generateToken()
		ctrl.Log.Info("generated ephemeral operator UI token; set TEAMCLAW_OPERATOR_UI_TOKEN for stable auth")
	}
	if os.Getenv("TEAMCLAW_OPERATOR_NAMESPACE") == "" {
		// In-cluster default; harmless outside the cluster.
		os.Setenv("TEAMCLAW_OPERATOR_NAMESPACE", detectNamespace())
	}
	if err := mgr.Add(&uiRunnable{
		addr:       uiAddr,
		token:      token,
		k8s:        mgr.GetClient(),
		namespaces: newNamespaceAllowlist(),
	}); err != nil {
		ctrl.Log.Error(err, "operator UI server setup failed")
		os.Exit(1)
	}

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

// uiRunnable runs the operator UI http.Server under the manager lifecycle:
// it starts with the manager, and on context cancellation drains in-flight
// requests before returning (#224 W4).
type uiRunnable struct {
	addr       string
	token      string
	k8s        client.Client
	namespaces namespaceAllowlist
}

// Start implements manager.Runnable.
func (u *uiRunnable) Start(ctx context.Context) error {
	srv := &http.Server{
		Addr:              u.addr,
		Handler:           uiServer(u.token, u.k8s, u.namespaces),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ln, err := net.Listen("tcp", u.addr)
	if err != nil {
		return fmt.Errorf("operator UI listen %s: %w", u.addr, err)
	}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
