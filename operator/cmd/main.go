package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	teav1 "github.com/topcheer/teamclaw/operator/api/v1"
	"github.com/topcheer/teamclaw/operator/internal/controller"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(teav1.AddToScheme(scheme))
}

// uiServer serves the operator HTTP face: health endpoints plus a minimal
// token-guarded JSON API that the P2 UI SPA will extend.
func uiServer(token string, listTeams func(ctx context.Context) ([]string, error)) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/v1/teams", func(w http.ResponseWriter, req *http.Request) {
		auth := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
		if token != "" && auth != token {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte("unauthorized"))
			return
		}
		teams, err := listTeams(req.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		quoted := make([]string, len(teams))
		for i, name := range teams {
			quoted[i] = `"` + name + `"`
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"teams":[%s]}`, strings.Join(quoted, ","))
	})
	return mux
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

	// Operator UI face (NodePort service targets this port).
	token := os.Getenv("TEAMCLAW_OPERATOR_UI_TOKEN")
	if token == "" {
		token = generateToken()
		ctrl.Log.Info("generated ephemeral operator UI token; set TEAMCLAW_OPERATOR_UI_TOKEN for stable auth")
	}
	go func() {
		if err := http.ListenAndServe(uiAddr, uiServer(token, func(ctx context.Context) ([]string, error) {
			var list teav1.TeamClawList
			if err := mgr.GetClient().List(ctx, &list); err != nil {
				return nil, err
			}
			names := make([]string, len(list.Items))
			for i, item := range list.Items {
				names[i] = item.Name
			}
			return names, nil
		})); err != nil {
			ctrl.Log.Error(err, "operator UI server failed")
		}
	}()

	ctrl.Log.Info("starting teamclaw operator")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "operator exited")
		os.Exit(1)
	}
}
