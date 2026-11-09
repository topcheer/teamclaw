// Unit tests for the operator UI API hardening (#224):
//   - namespace allowlist bounds ?namespace= to operator-namespace + allowlist
//   - team names are DNS-1123 validated on POST and on the item path
//   - inline config: CR first, Secret owned by the CR, nothing orphaned
//   - k8s internals are not leaked verbatim to API callers
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	teav1 "github.com/topcheer/teamclaw/operator/api/v1"
)

func cmdScheme(t *testing.T) *runtime.Scheme {
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

func TestNamespaceAllowlistResolve(t *testing.T) {
	t.Setenv("TEAMCLAW_OPERATOR_NAMESPACE", "teamclaw-system")
	t.Setenv("TEAMCLAW_ALLOWED_NAMESPACES", " teams-a, teams-b ,,teams-a ")
	a := newNamespaceAllowlist()

	req := func(ns string) *http.Request {
		r, _ := http.NewRequest(http.MethodGet, "http://x/api/v1/teams", nil)
		if ns != "" {
			r.URL.RawQuery = "namespace=" + ns
		}
		return r
	}

	cases := []struct {
		query  string
		wantNS string
		wantOK bool
	}{
		{"", "teamclaw-system", true},                // default: operator ns
		{"teamclaw-system", "teamclaw-system", true}, // explicit own ns
		{"teams-a", "teams-a", true},                 // allowlisted
		{"teams-b", "teams-b", true},                 // allowlisted (dedup/trims)
		{"kube-system", "kube-system", false},        // valid name, not allowed
		{"not_a_ns", "not_a_ns", false},              // invalid DNS-1123 label
	}
	for _, tc := range cases {
		ns, ok := a.resolve(req(tc.query))
		if ns != tc.wantNS || ok != tc.wantOK {
			t.Errorf("resolve(query=%q) = (%q, %v), want (%q, %v)", tc.query, ns, ok, tc.wantNS, tc.wantOK)
		}
	}
}

func TestValidTeamName(t *testing.T) {
	valid := []string{"alpha", "alpha-1", "team.a"}
	invalid := []string{"", "Alpha", "bad name", "has/slash", "trailing-", strings.Repeat("a", 254)}
	for _, n := range valid {
		if !validTeamName(n) {
			t.Errorf("validTeamName(%q) = false, want true", n)
		}
	}
	for _, n := range invalid {
		if validTeamName(n) {
			t.Errorf("validTeamName(%q) = true, want false", n)
		}
	}
}

func TestBearerOK(t *testing.T) {
	req := func(auth string) *http.Request {
		r, _ := http.NewRequest(http.MethodGet, "http://x", nil)
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		return r
	}
	if bearerOK(req(""), "") != true {
		t.Error("empty configured token must accept all requests")
	}
	if bearerOK(req("Bearer secret"), "secret") != true {
		t.Error("matching bearer token rejected")
	}
	if bearerOK(req("Bearer wrong"), "secret") != false {
		t.Error("wrong bearer token accepted")
	}
	if bearerOK(req(""), "secret") != false {
		t.Error("missing Authorization accepted")
	}
}

func apiServer(t *testing.T, c client.WithWatch) *httptest.Server {
	t.Helper()
	t.Setenv("TEAMCLAW_OPERATOR_NAMESPACE", "teamclaw-system")
	srv := httptest.NewServer(uiServer("test-token", c, newNamespaceAllowlist()))
	t.Cleanup(srv.Close)
	return srv
}

func doReq(t *testing.T, method, url, body string) *http.Response {
	t.Helper()
	var rd *bytes.Reader
	if body != "" {
		rd = bytes.NewReader([]byte(body))
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, url, rd)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	return resp
}

// TestPostTeamInlineConfigCreatesOwnedSecret: POST with inline configJson
// creates the CR first, then a Secret owned by the CR (#224 W2).
func TestPostTeamInlineConfigCreatesOwnedSecret(t *testing.T) {
	c := fake.NewClientBuilder().WithScheme(cmdScheme(t)).Build()
	srv := apiServer(t, c)

	resp := doReq(t, http.MethodPost, srv.URL+"/api/v1/teams",
		`{"name":"alpha","spec":{"teamName":"Alpha"},"configJson":"{\"models\":{}}"}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}

	ctx := context.Background()
	var tc teav1.TeamClaw
	if err := c.Get(ctx, types.NamespacedName{Namespace: "teamclaw-system", Name: "alpha"}, &tc); err != nil {
		t.Fatalf("teamclaw not created: %v", err)
	}
	if tc.Spec.Controller.ModelConfigSecretRef != "alpha-config" {
		t.Errorf("modelConfigSecretRef = %q, want alpha-config", tc.Spec.Controller.ModelConfigSecretRef)
	}

	var secret corev1.Secret
	if err := c.Get(ctx, types.NamespacedName{Namespace: "teamclaw-system", Name: "alpha-config"}, &secret); err != nil {
		t.Fatalf("config secret not created: %v", err)
	}
	if string(secret.Data["openclaw.json"]) != `{"models":{}}` {
		t.Errorf("secret payload = %q", secret.Data["openclaw.json"])
	}
	if len(secret.OwnerReferences) != 1 {
		t.Fatalf("secret ownerReferences = %v, want the controlling TeamClaw", secret.OwnerReferences)
	}
	ref := secret.OwnerReferences[0]
	if ref.Kind != "TeamClaw" || ref.Name != "alpha" || ref.Controller == nil || !*ref.Controller {
		t.Errorf("ownerReference = %+v, want controller TeamClaw/alpha", ref)
	}
}

// TestPostTeamNamespaceGuard: ?namespace= outside the allowlist is rejected
// before any cluster mutation (#224 W1).
func TestPostTeamNamespaceGuard(t *testing.T) {
	c := fake.NewClientBuilder().WithScheme(cmdScheme(t)).Build()
	srv := apiServer(t, c)

	for _, url := range []string{
		srv.URL + "/api/v1/teams?namespace=kube-system",
		srv.URL + "/api/v1/teams/notallowed?namespace=kube-system",
	} {
		resp := doReq(t, http.MethodPost, url, `{"name":"evil","spec":{},"configJson":"{}"}`)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("POST %s status = %d, want 400", url, resp.StatusCode)
		}
		resp.Body.Close()
	}

	var all teav1.TeamClawList
	if err := c.List(context.Background(), &all); err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all.Items) != 0 {
		t.Errorf("%d TeamClaws created despite namespace guard", len(all.Items))
	}
}

// TestPostTeamRejectsInvalidName: non DNS-1123 names never reach the cluster.
func TestPostTeamRejectsInvalidName(t *testing.T) {
	c := fake.NewClientBuilder().WithScheme(cmdScheme(t)).Build()
	srv := apiServer(t, c)

	resp := doReq(t, http.MethodPost, srv.URL+"/api/v1/teams", `{"name":"Bad Name!"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	resp = doReq(t, http.MethodGet, srv.URL+"/api/v1/teams/a/b", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("item path with slash: status = %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()
}

// TestApiErrorsDoNotLeakInternals: k8s errors map to fixed messages (#224 W5).
func TestApiErrorsDoNotLeakInternals(t *testing.T) {
	c := fake.NewClientBuilder().WithScheme(cmdScheme(t)).Build()
	srv := apiServer(t, c)

	resp := doReq(t, http.MethodGet, srv.URL+"/api/v1/teams/ghost", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	defer resp.Body.Close()
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["error"] != "not found" {
		t.Errorf("error = %q, want fixed \"not found\" (no internals)", body["error"])
	}
}
