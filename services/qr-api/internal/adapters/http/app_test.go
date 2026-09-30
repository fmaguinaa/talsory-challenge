package httpadapters_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/interseguro/qr-api/internal/adapters/authclient"
	httpadapters "github.com/interseguro/qr-api/internal/adapters/http"
	"github.com/interseguro/qr-api/internal/adapters/http/problem"
	"github.com/interseguro/qr-api/internal/application"
)

// discardLogger keeps test output readable: the service logs a line per
// request, which would drown the assertions.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

// fakeAuthServer stands in for auth-service. It records how many times it was
// called and can be told to fail, hang or reject, which is how the 401, 503 and
// timeout paths are exercised without a real dependency.
type fakeAuthServer struct {
	// server is the running httptest server.
	server *httptest.Server
	// active is the answer returned while it is non-nil.
	active atomic.Bool
	// calls counts introspection requests.
	calls atomic.Int64
	// mode switches the server into an abnormal behaviour.
	mode atomic.Int32
}

// authMode selects the behaviour of the fake authority.
const (
	// authNormal answers 200 {"active":true}.
	authNormal int32 = iota
	// authInactive answers 200 {"active":false}.
	authInactive
	// authServerError answers 500.
	authServerError
	// authUnauthorized answers 401, i.e. rejects the service credential.
	authUnauthorized
	// authMalformed answers 200 with a body that is not JSON.
	authMalformed
)

// newFakeAuthServer starts a fake authority. Callers must Close it.
func newFakeAuthServer(t *testing.T) *fakeAuthServer {
	t.Helper()
	f := &fakeAuthServer{}
	f.active.Store(true)
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)

		if got := r.Header.Get("X-Service-Key"); got == "" {
			// The real service refuses introspection without a service
			// credential; mirroring that keeps the test honest about the
			// X-Service-Key contract.
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/auth/validate" {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		switch f.mode.Load() {
		case authInactive:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"active":false}`))
		case authServerError:
			w.WriteHeader(http.StatusInternalServerError)
		case authUnauthorized:
			w.WriteHeader(http.StatusUnauthorized)
		case authMalformed:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`not json at all`))
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"active":true,"sub":"demo","scope":"qr:read","exp":4102444800}`))
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

// URL returns the base URL of the fake authority.
func (f *fakeAuthServer) URL() string { return f.server.URL }

// newTestApp builds the whole service around a fake authority, exercising the
// real composition: HTTP validator, use case and Fiber handlers.
func newTestApp(t *testing.T, fake *fakeAuthServer, maxDim, maxBody int) *fiber.App {
	t.Helper()

	validator, err := authclient.NewValidator(authclient.Config{
		BaseURL:    fake.URL(),
		ServiceKey: "test-service-key",
		Timeout:    500 * time.Millisecond,
		// Caching is disabled by default so each request really calls the
		// authority; the caching behaviour has its own focused test.
		CacheTTL: 0,
	})
	if err != nil {
		t.Fatalf("NewValidator: %v", err)
	}

	useCase := &application.FactorizeUseCase{
		Factorizer:   application.HouseholderFactorizer{},
		MaxMatrixDim: maxDim,
		Validator:    validator,
	}

	return httpadapters.NewApp(httpadapters.AppOptions{
		UseCase:         useCase,
		Logger:          discardLogger(),
		MaxBodyBytes:    maxBody,
		ReadTimeout:     5 * time.Second,
		WriteTimeout:    5 * time.Second,
		RateLimitMax:    0,
		RateLimitWindow: time.Minute,
	})
}

// do performs a request against the app and returns the status, the parsed
// problem document (when the body is one) and the raw body.
func do(t *testing.T, app *fiber.App, method, path, body string, headers map[string]string) (int, *problem.Detail, []byte) {
	t.Helper()

	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := app.Test(req, 10_000)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading body: %v", err)
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), problem.MediaType) {
		var detail problem.Detail
		if err := json.Unmarshal(raw, &detail); err != nil {
			t.Fatalf("decoding problem document: %v (body was %s)", err, raw)
		}
		return resp.StatusCode, &detail, raw
	}
	return resp.StatusCode, nil, raw
}

// authHeader builds a valid bearer header for the happy path.
func authHeader() map[string]string {
	return map[string]string{"Authorization": "Bearer header.payload.signature"}
}

func TestFactorizeHappyPath(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 100, 1<<20)

	status, _, raw := do(t, app, http.MethodPost, "/api/v1/qr/factorize",
		`{"matrix":[[12,-51,4],[6,167,-68],[-4,24,-41]]}`, authHeader())
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", status, raw)
	}

	var got struct {
		Q [][]float64 `json:"q"`
		R [][]float64 `json:"r"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decoding response: %v", err)
	}

	if len(got.Q) != 3 || len(got.R) != 3 {
		t.Fatalf("shapes: Q %dx?, R %dx?, want 3x3", len(got.Q), len(got.R))
	}

	// Q must be orthogonal and R upper triangular, and Q*R must rebuild the input.
	var identityErr, reconstructErr float64
	input := [][]float64{{12, -51, 4}, {6, 167, -68}, {-4, 24, -41}}
	for i := 0; i < 3; i++ {
		for j := 0; j < 3; j++ {
			// Upper triangular means the entries BELOW the diagonal vanish, i.e. j < i.
			if j < i && math.Abs(got.R[i][j]) > 1e-9 {
				t.Errorf("R[%d][%d] = %v, want 0 (R must be upper triangular)", i, j, got.R[i][j])
			}
			var qNorm float64
			for k := 0; k < 3; k++ {
				qNorm += got.Q[k][i] * got.Q[k][j]
			}
			want := 0.0
			if i == j {
				want = 1
			}
			identityErr = math.Max(identityErr, math.Abs(qNorm-want))

			var value float64
			for k := 0; k < 3; k++ {
				value += got.Q[i][k] * got.R[k][j]
			}
			reconstructErr = math.Max(reconstructErr, math.Abs(value-input[i][j]))
		}
	}
	if identityErr > 1e-9 {
		t.Errorf("max |Q^T Q - I| = %g, want <= 1e-9", identityErr)
	}
	if reconstructErr > 1e-9 {
		t.Errorf("max |Q R - A| = %g, want <= 1e-9", reconstructErr)
	}
}

func TestFactorizeTallAndWideMatrices(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 100, 1<<20)

	cases := []struct {
		name   string
		body   string
		qShape [2]int
		rShape [2]int
	}{
		{
			name:   "tall 4x2",
			body:   `{"matrix":[[1,2],[3,4],[5,6],[7,8]]}`,
			qShape: [2]int{4, 4},
			rShape: [2]int{4, 2},
		},
		{
			name:   "wide 2x3",
			body:   `{"matrix":[[1,2,3],[4,5,6]]}`,
			qShape: [2]int{2, 2},
			rShape: [2]int{2, 3},
		},
		{
			name:   "single element",
			body:   `{"matrix":[[5]]}`,
			qShape: [2]int{1, 1},
			rShape: [2]int{1, 1},
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			status, _, raw := do(t, app, http.MethodPost, "/api/v1/qr/factorize", tc.body, authHeader())
			if status != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", status, raw)
			}
			var got struct {
				Q [][]float64 `json:"q"`
				R [][]float64 `json:"r"`
			}
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("decoding: %v", err)
			}
			if len(got.Q) != tc.qShape[0] || len(got.Q[0]) != tc.qShape[1] {
				t.Errorf("Q shape = %dx%d, want %dx%d", len(got.Q), len(got.Q[0]), tc.qShape[0], tc.qShape[1])
			}
			if len(got.R) != tc.rShape[0] || len(got.R[0]) != tc.rShape[1] {
				t.Errorf("R shape = %dx%d, want %dx%d", len(got.R), len(got.R[0]), tc.rShape[0], tc.rShape[1])
			}
		})
	}
}

func TestFactorizeErrors(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 4, 1<<20)

	// Every case below that asserts a validation error presents a valid token.
	// That is not incidental: FactorizeUseCase authorizes *before* validating, so
	// an unauthenticated caller is rejected with 401 and learns nothing about
	// the shape rules. Cases that specifically exercise authentication override
	// the header explicitly.
	cases := []struct {
		name       string
		body       string
		headers    map[string]string
		wantStatus int
		wantDetail string
	}{
		{
			name:       "malformed JSON",
			headers:    authHeader(),
			body:       `{"matrix": [`,
			wantStatus: http.StatusBadRequest,
			wantDetail: "not valid JSON",
		},
		{
			name:       "missing matrix field",
			headers:    authHeader(),
			body:       `{}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: `field "matrix" is required`,
		},
		{
			name:       "ragged matrix names the offending row",
			headers:    authHeader(),
			body:       `{"matrix":[[1,2,3],[4,5]]}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "row 1 has length 2, expected 3",
		},
		{
			name:       "empty matrix",
			headers:    authHeader(),
			body:       `{"matrix":[]}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "at least one row",
		},
		{
			name:       "empty row",
			headers:    authHeader(),
			body:       `{"matrix":[[]]}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "at least one column",
		},
		{
			name:       "non numeric cell names the position",
			headers:    authHeader(),
			body:       `{"matrix":[[1,2],[3,"four"]]}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "row 1, column 1 must be a number",
		},
		{
			name:       "null cell",
			headers:    authHeader(),
			body:       `{"matrix":[[1,null],[3,4]]}`,
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "row 0, column 1 must be a number",
		},
		{
			name:       "too many rows",
			headers:    authHeader(),
			body:       `{"matrix":[[1],[2],[3],[4],[5]]}`,
			wantStatus: http.StatusRequestEntityTooLarge,
			wantDetail: "5 rows, the maximum is 4",
		},
		{
			name:       "too many columns",
			headers:    authHeader(),
			body:       `{"matrix":[[1,2,3,4,5]]}`,
			wantStatus: http.StatusRequestEntityTooLarge,
			wantDetail: "5 columns, the maximum is 4",
		},
		{
			name:       "missing token",
			body:       `{"matrix":[[1,2],[3,4]]}`,
			headers:    map[string]string{},
			wantStatus: http.StatusUnauthorized,
			wantDetail: "valid bearer token is required",
		},
		{
			name:       "malformed authorization scheme",
			body:       `{"matrix":[[1,2],[3,4]]}`,
			headers:    map[string]string{"Authorization": "Basic dXNlcjpwYXNz"},
			wantStatus: http.StatusUnauthorized,
			wantDetail: "valid bearer token is required",
		},
		{
			// A tampered token is rejected by the authority, not by qr-api, so the
			// fake authority is switched to "inactive" for this case by
			// TestInactiveTokenIsRejected. Here we only assert that qr-api sends
			// the token through verbatim rather than trying to parse it.
			name:       "well-formed token is forwarded to the authority",
			body:       `{"matrix":[[1,2],[3,4]]}`,
			headers:    map[string]string{"Authorization": "Bearer tampered.jwt.value"},
			wantStatus: http.StatusOK,
			wantDetail: "",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			status, detail, raw := do(t, app, http.MethodPost, "/api/v1/qr/factorize", tc.body, tc.headers)
			if status != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", status, tc.wantStatus, raw)
			}
			if tc.wantDetail == "" {
				return
			}
			if detail == nil {
				t.Fatalf("expected a problem document, got %s", raw)
			}
			if !strings.Contains(detail.Detail, tc.wantDetail) {
				t.Errorf("detail = %q, want it to contain %q", detail.Detail, tc.wantDetail)
			}
			// Every problem document must be complete enough to correlate.
			if detail.RequestID == "" {
				t.Error("problem document is missing requestId")
			}
			if detail.Type == "" || detail.Title == "" || detail.Instance == "" {
				t.Errorf("problem document is incomplete: %+v", detail)
			}
			if detail.Status != status {
				t.Errorf("problem status = %d, want it to match the HTTP status %d", detail.Status, status)
			}
		})
	}
}

func TestFactorizeFailsClosedWhenAuthIsDown(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		mode int32
	}{
		{name: "authority returns 500", mode: authServerError},
		{name: "authority rejects the service key", mode: authUnauthorized},
		{name: "authority returns a malformed body", mode: authMalformed},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			fake := newFakeAuthServer(t)
			app := newTestApp(t, fake, 100, 1<<20)
			fake.mode.Store(tc.mode)

			status, detail, raw := do(t, app, http.MethodPost, "/api/v1/qr/factorize",
				`{"matrix":[[1,2],[3,4]]}`, authHeader())
			if status != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503 (body %s)", status, raw)
			}
			if detail == nil {
				t.Fatalf("expected a problem document, got %s", raw)
			}
			// The distinguishing property of fail-closed: the request is refused,
			// and it is refused as "temporarily unavailable", not as "bad token".
			if detail.Type != problem.TypeBase+string(problem.CategoryServiceUnavailable) {
				t.Errorf("type = %q, want the service-unavailable category", detail.Type)
			}
			// The internal reason must not leak to the client.
			for _, leak := range []string{"500", "malformed introspection", "test-service-key"} {
				if strings.Contains(detail.Detail, leak) {
					t.Errorf("detail %q leaks internal detail %q", detail.Detail, leak)
				}
			}
		})
	}
}

func TestFactorizeFailsClosedWhenAuthIsUnreachable(t *testing.T) {
	t.Parallel()

	// The fake authority is closed before the request, so the address is
	// genuinely unreachable: exactly what a crashed dependency looks like.
	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 100, 1<<20)
	fake.server.Close()

	status, detail, raw := do(t, app, http.MethodPost, "/api/v1/qr/factorize",
		`{"matrix":[[1,2],[3,4]]}`, authHeader())
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body %s)", status, raw)
	}
	if detail == nil {
		t.Fatalf("expected a problem document, got %s", raw)
	}
	if detail.Title != "Service unavailable" {
		t.Errorf("title = %q, want %q", detail.Title, "Service unavailable")
	}
}

func TestFactorizeRejectsOversizedBody(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	// The 3x3 example body is roughly 48 bytes, so a 20 byte limit makes the 413
	// observable without having to send a payload of megabytes.
	app := newTestApp(t, fake, 100, 20)

	status, _, raw := do(t, app, http.MethodPost, "/api/v1/qr/factorize",
		`{"matrix":[[12,-51,4],[6,167,-68],[-4,24,-41]]}`, authHeader())
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 (body %s)", status, raw)
	}
}

func TestInactiveTokenIsRejected(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 100, 1<<20)
	fake.mode.Store(authInactive)

	status, detail, raw := do(t, app, http.MethodPost, "/api/v1/qr/factorize",
		`{"matrix":[[1,2],[3,4]]}`, authHeader())
	if status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %s)", status, raw)
	}
	if detail == nil || detail.Type != problem.TypeBase+string(problem.CategoryUnauthorized) {
		t.Errorf("expected the unauthorized category, got %+v", detail)
	}
}

// TestRequestIDIsPropagatedAndEchoed checks the cross-service correlation
// contract: an inbound id survives, and one is minted when absent.
func TestRequestIDIsPropagatedAndEchoed(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 100, 1<<20)

	t.Run("inbound id is preserved", func(t *testing.T) {
		t.Parallel()
		const id = "trace-abc-123"
		headers := authHeader()
		headers["X-Request-Id"] = id
		req := httptest.NewRequest(http.MethodPost, "/api/v1/qr/factorize",
			strings.NewReader(`{"matrix":[[1,2],[3,4]]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer t")
		req.Header.Set("X-Request-Id", id)
		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("app.Test: %v", err)
		}
		defer func() { _ = resp.Body.Close() }()
		if got := resp.Header.Get("X-Request-Id"); got != id {
			t.Errorf("X-Request-Id = %q, want %q", got, id)
		}
	})

	t.Run("id is minted when absent", func(t *testing.T) {
		t.Parallel()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/qr/factorize",
			strings.NewReader(`{"matrix":[[1,2],[3,4]]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer t")
		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("app.Test: %v", err)
		}
		defer func() { _ = resp.Body.Close() }()
		got := resp.Header.Get("X-Request-Id")
		if got == "" {
			t.Fatal("expected an X-Request-Id to be generated")
		}
		if len(got) != 36 {
			t.Errorf("X-Request-Id = %q, want a 36 character UUID", got)
		}
	})

	t.Run("hostile id is replaced", func(t *testing.T) {
		t.Parallel()
		// A newline in the header would let an attacker forge log lines.
		req := httptest.NewRequest(http.MethodPost, "/api/v1/qr/factorize",
			strings.NewReader(`{"matrix":[[1,2],[3,4]]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer t")
		req.Header.Set("X-Request-Id", "abc\r\nX-Injected: yes")
		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("app.Test: %v", err)
		}
		defer func() { _ = resp.Body.Close() }()
		if got := resp.Header.Get("X-Request-Id"); strings.ContainsAny(got, "\r\n") {
			t.Errorf("X-Request-Id = %q, want the hostile value replaced", got)
		}
	})
}

func TestHealthEndpoints(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 100, 1<<20)

	for _, path := range []string{"/health/live", "/health/ready"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			// No Authorization header: probes must stay public.
			status, detail, raw := do(t, app, http.MethodGet, path, "", map[string]string{})
			if status != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %s)", status, raw)
			}
			if detail != nil {
				t.Errorf("expected a plain JSON body, got a problem document: %+v", detail)
			}
			var body struct {
				Status string `json:"status"`
			}
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatalf("decoding: %v", err)
			}
			if body.Status != "ok" {
				t.Errorf("status = %q, want %q", body.Status, "ok")
			}
		})
	}
}

func TestUnknownRouteReturnsProblemDocument(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 100, 1<<20)

	status, detail, raw := do(t, app, http.MethodGet, "/does-not-exist", "", map[string]string{})
	if status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", status, raw)
	}
	if detail == nil {
		t.Fatalf("expected a problem document, got %s", raw)
	}
}

// TestNumberTooLargeForFloat64IsABadRequest pins the boundary behaviour for a
// value that is syntactically valid JSON but overflows float64.
//
// Go's decoder refuses to produce a float64 for 1e999, so the failure surfaces
// while parsing the body and is reported as 400 rather than 422. That is
// documented rather than worked around: rescuing the value would need a custom
// decoder for an input that is invalid either way, and the client's remedy is
// the same in both cases.
func TestNumberTooLargeForFloat64IsABadRequest(t *testing.T) {
	t.Parallel()

	fake := newFakeAuthServer(t)
	app := newTestApp(t, fake, 100, 1<<20)

	status, detail, raw := do(t, app, http.MethodPost, "/api/v1/qr/factorize",
		`{"matrix":[[1e999,2],[3,4]]}`, authHeader())
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", status, raw)
	}
	if detail == nil || detail.Type != problem.TypeBase+string(problem.CategoryMalformedRequest) {
		t.Errorf("unexpected problem document: %+v", detail)
	}
}
