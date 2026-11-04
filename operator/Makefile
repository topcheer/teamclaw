# TeamClaw Operator - P0 build targets
IMAGE ?= ghcr.io/topcheer/teamclaw-operator:latest
CONTROLLER_GEN := go run sigs.k8s.io/controller-tools/cmd/controller-gen

.PHONY: build vet test manifests docker-build docker-push deploy crd-install

build:
	go build ./...

vet:
	go vet ./...

test:
	go test ./...

manifests:
	$(CONTROLLER_GEN) crd paths=./api/... output:crd:dir=config/crd/bases

docker-build:
	docker build -f operator/Dockerfile -t $(IMAGE) .

docker-push: docker-build
	docker push $(IMAGE)

crd-install:
	kubectl apply -f config/crd/bases/teamclaw.dev_teamclaws.yaml

deploy: crd-install
	kubectl apply -f config/rbac/operator-rbac.yaml
	kubectl apply -f config/manager/deployment.yaml

# Integration tests (envtest): reconciler regressions behind the
# `integration` build tag. Downloads kubebuilder assets once.
.PHONY: test-integration
test-integration:
	go run sigs.k8s.io/controller-runtime/tools/setup-envtest@latest use 1.34.x --bin-dir /tmp/envtest -p path
	KUBEBUILDER_ASSETS=$$(go run sigs.k8s.io/controller-runtime/tools/setup-envtest@latest use 1.34.x --bin-dir /tmp/envtest -p path)  		go test -tags integration ./internal/controller/ -run 'TestReconcile' -v
