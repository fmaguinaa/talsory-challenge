package authclient_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/interseguro/qr-api/internal/adapters/authclient"
	"github.com/interseguro/qr-api/internal/application"
)

// introspectionSpy is a fake auth-service that records how it was called and
// replies with whatever the test asked for.
type introspectionSpy struct {
	// server is the running httptest server.
	server *httptest.Server
	// calls counts /auth/validate requests.
	calls atomic.Int64
	// serviceKeys records the X-Service-Key header of every call.
	serviceKeys chan string
	// reply produces the response for the nth call, keyed by a mode below.
	mode atomic.Int32
}

// Spy modes.
const (
	// spyActive answers 200 {"active":true,...}.
	spyActive int32 = iota
	// spyInactive answers 200 {"active":false}.
	spyInactive
	// spyMalformed answers 200 with a body that is not JSON.
	spyMalformed
	// spyServerError answers 500.
	spyServerError
	// spyUnprocessable answers 422.
	spyUnprocessable
)

// newSpy starts a fake authority. Callers must Close it.
func newSpy(t *testing.T) *introspectionSpy {
	t.Helper()
	s := &introspectionSpy{serviceKeys: make(chan string, 64)}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.calls.Add(1)
		select {
		case s.serviceKeys <- r.Header.Get("X-Service-Key"):
		default:
		}
		if r.URL.Path != "/auth/validate" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch s.mode.Load() {
		case spyInactive:
			fmt.Fprint(w, `{"active":false}`)
		case spyMalformed:
			fmt.Fprint(w, `<html>not json</html>`)
		case spyServerError:
			w.WriteHeader(http.StatusInternalServerError)
		case spyUnprocessable:
			w.WriteHeader(http.StatusUnprocessableEntity)
		default:
			// exp one hour from now, in seconds.
			fmt.Fprintf(w, `{"active":true,"sub":"demo","scope":"qr:read","exp":%d}`, time.Now().Add(time.Hour).Unix())
		}
	}))
	t.Cleanup(s.server.Close)
	return s
}

// URL returns the base URL of the fake authority.
func (s *introspectionSpy) URL() string { return s.server.URL }

// newValidator builds a Validator pointed at the fake authority.
func newValidator(t *testing.T, url string, cacheTTL time.Duration) *authclient.Validator {
	t.Helper()
	v, err := authclient.NewValidator(authclient.Config{
		BaseURL:    url,
		ServiceKey: "unit-service-key",
		Timeout:    300 * time.Millisecond,
		CacheTTL:   cacheTTL,
	})
	if err != nil {
		t.Fatalf("NewValidator: %v", err)
	}
	return v
}

func TestValidateAcceptsAnActiveToken(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL(), 0)

	if err := v.Validate(context.Background(), "good.token.value"); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got := spy.calls.Load(); got != 1 {
		t.Errorf("authority called %d times, want 1", got)
	}
}

func TestValidateSendsTheServiceCredential(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL(), 0)

	if err := v.Validate(context.Background(), "t"); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	select {
	case key := <-spy.serviceKeys:
		if key != "unit-service-key" {
			t.Errorf("X-Service-Key = %q, want %q", key, "unit-service-key")
		}
	default:
		t.Fatal("the authority recorded no call")
	}
}

func TestValidateRejectsAnInactiveToken(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	spy.mode.Store(spyInactive)
	v := newValidator(t, spy.URL(), 0)

	err := v.Validate(context.Background(), "expired.token.value")
	if !errors.Is(err, application.ErrInvalidToken) {
		t.Fatalf("error = %v, want ErrInvalidToken", err)
	}
	// Crucially NOT ErrAuthUnavailable: the authority answered, it just said no.
	if errors.Is(err, application.ErrAuthUnavailable) {
		t.Error("an authoritative 'no' must not be reported as unavailability")
	}
}

func TestValidateFailsClosedOnAuthorityProblems(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		mode int32
	}{
		{name: "500 from the authority", mode: spyServerError},
		{name: "422 from the authority", mode: spyUnprocessable},
		{name: "malformed body", mode: spyMalformed},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			spy := newSpy(t)
			spy.mode.Store(tc.mode)
			v := newValidator(t, spy.URL(), 0)

			err := v.Validate(context.Background(), "t")
			if !errors.Is(err, application.ErrAuthUnavailable) {
				t.Fatalf("error = %v, want ErrAuthUnavailable", err)
			}
			// A misconfigured or broken authority must never look like a bad token:
			// telling the client "your token is invalid" would send it into an
			// endless re-login loop against a service that is actually down.
			if errors.Is(err, application.ErrInvalidToken) {
				t.Error("an unavailable authority must not be reported as an invalid token")
			}
		})
	}
}

func TestValidateFailsClosedWhenTheAuthorityIsUnreachable(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	url := spy.URL()
	spy.server.Close()

	v := newValidator(t, url, 0)
	err := v.Validate(context.Background(), "t")
	if !errors.Is(err, application.ErrAuthUnavailable) {
		t.Fatalf("error = %v, want ErrAuthUnavailable", err)
	}
}

func TestValidateFailsClosedOnTimeout(t *testing.T) {
	t.Parallel()

	// A handler that never answers, so the client's own timeout is what fires.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	t.Cleanup(slow.Close)

	v := newValidator(t, slow.URL, 0)

	start := time.Now()
	err := v.Validate(context.Background(), "t")
	elapsed := time.Since(start)

	if !errors.Is(err, application.ErrAuthUnavailable) {
		t.Fatalf("error = %v, want ErrAuthUnavailable", err)
	}
	// The call must give up on its own schedule rather than waiting for the
	// slow server; this is what keeps a hung dependency from pinning a request.
	if elapsed > time.Second {
		t.Errorf("Validate took %v, want it bounded by the 300ms timeout", elapsed)
	}
}

func TestValidateRejectsAnEmptyTokenWithoutCallingTheAuthority(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL(), 0)

	for _, token := range []string{"", "   "} {
		if err := v.Validate(context.Background(), token); !errors.Is(err, application.ErrInvalidToken) {
			t.Errorf("token %q: error = %v, want ErrInvalidToken", token, err)
		}
	}
	if got := spy.calls.Load(); got != 0 {
		t.Errorf("the authority was called %d times for empty tokens, want 0", got)
	}
}

// TestCachingServesRepeatCallsWithoutHittingTheAuthority is the whole point of
// the cache: one introspection call serves several authorized requests.
func TestCachingServesRepeatCallsWithoutHittingTheAuthority(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL(), time.Minute)

	for i := 0; i < 5; i++ {
		if err := v.Validate(context.Background(), "cached.token.value"); err != nil {
			t.Fatalf("Validate #%d: %v", i, err)
		}
	}
	if got := spy.calls.Load(); got != 1 {
		t.Errorf("authority called %d times for 5 validations, want 1", got)
	}
}

func TestCacheIsKeyedPerToken(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL(), time.Minute)

	for _, token := range []string{"token-a", "token-b", "token-a", "token-b"} {
		if err := v.Validate(context.Background(), token); err != nil {
			t.Fatalf("Validate(%q): %v", token, err)
		}
	}
	// Two distinct tokens must each be introspected once, not share an entry.
	if got := spy.calls.Load(); got != 2 {
		t.Errorf("authority called %d times for 2 distinct tokens, want 2", got)
	}
}

// TestOnlyPositiveAnswersAreCached pins the ADR-005 decision: caching a
// negative would keep rejecting a token after it is legitimately re-issued.
func TestOnlyPositiveAnswersAreCached(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	spy.mode.Store(spyInactive)
	v := newValidator(t, spy.URL(), time.Minute)

	for i := 0; i < 3; i++ {
		if err := v.Validate(context.Background(), "revoked.token"); !errors.Is(err, application.ErrInvalidToken) {
			t.Fatalf("Validate #%d = %v, want ErrInvalidToken", i, err)
		}
	}
	if got := spy.calls.Load(); got != 3 {
		t.Errorf("authority called %d times, want 3: negative answers must not be cached", got)
	}
}

func TestDisabledCacheAlwaysCallsTheAuthority(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL(), 0)

	for i := 0; i < 3; i++ {
		if err := v.Validate(context.Background(), "t"); err != nil {
			t.Fatalf("Validate #%d: %v", i, err)
		}
	}
	if got := spy.calls.Load(); got != 3 {
		t.Errorf("authority called %d times with caching disabled, want 3", got)
	}
}

// TestCacheEntryExpires checks that an entry stops being honoured once its TTL
// elapses, which is what bounds the revocation latency documented in ADR-005.
func TestCacheEntryExpires(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL(), 60*time.Millisecond)

	if err := v.Validate(context.Background(), "t"); err != nil {
		t.Fatalf("first Validate: %v", err)
	}
	// Immediately after, the cached answer must still be used.
	if err := v.Validate(context.Background(), "t"); err != nil {
		t.Fatalf("cached Validate: %v", err)
	}
	if got := spy.calls.Load(); got != 1 {
		t.Fatalf("authority called %d times before the TTL elapsed, want 1", got)
	}

	time.Sleep(90 * time.Millisecond)

	if err := v.Validate(context.Background(), "t"); err != nil {
		t.Fatalf("post-TTL Validate: %v", err)
	}
	if got := spy.calls.Load(); got != 2 {
		t.Errorf("authority called %d times after the TTL elapsed, want 2", got)
	}
}

// TestCacheNeverOutlivesTheToken proves the TTL is capped by exp: a token that
// expires in two seconds must not be served from cache after that.
func TestCacheNeverOutlivesTheToken(t *testing.T) {
	t.Parallel()

	// An authority that reports a token expiring almost immediately.
	var calls atomic.Int64
	shortLived := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"active":true,"exp":%d}`, time.Now().Add(120*time.Millisecond).Unix())
	}))
	t.Cleanup(shortLived.Close)

	// A cache TTL far longer than the token's remaining life.
	v := newValidator(t, shortLived.URL, time.Hour)

	if err := v.Validate(context.Background(), "short-lived"); err != nil {
		t.Fatalf("first Validate: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	// After the token's own exp the entry must be gone: a one hour cache TTL
	// must not keep serving a token that died after 120ms.
	if err := v.Validate(context.Background(), "short-lived"); err != nil {
		t.Fatalf("Validate after exp: %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Errorf("authority called %d times, want 2: the entry must expire with the token", got)
	}
}

// TestNewValidatorRejectsIncompleteConfiguration covers the fail-fast startup
// path: a missing URL or key is a deployment bug, not a runtime condition.
func TestNewValidatorRejectsIncompleteConfiguration(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		cfg  authclient.Config
	}{
		{name: "missing base URL", cfg: authclient.Config{ServiceKey: "k"}},
		{name: "blank base URL", cfg: authclient.Config{BaseURL: "   ", ServiceKey: "k"}},
		{name: "missing service key", cfg: authclient.Config{BaseURL: "http://auth-service:4000"}},
		{name: "blank service key", cfg: authclient.Config{BaseURL: "http://auth-service:4000", ServiceKey: " "}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if _, err := authclient.NewValidator(tc.cfg); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

// TestTrailingSlashInBaseURLIsTolerated guards against producing a double slash
// in the request path, which some proxies normalize and others do not.
func TestTrailingSlashInBaseURLIsTolerated(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL()+"/", 0)
	if err := v.Validate(context.Background(), "t"); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

// TestConcurrentValidatesAreSafe is a race-detector guard: the cache is shared
// mutable state and the service is concurrent by construction.
func TestConcurrentValidatesAreSafe(t *testing.T) {
	t.Parallel()

	spy := newSpy(t)
	v := newValidator(t, spy.URL(), time.Minute)

	const workers = 32
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(i int) {
			defer wg.Done()
			if err := v.Validate(context.Background(), fmt.Sprintf("token-%d", i%4)); err != nil {
				t.Errorf("Validate: %v", err)
			}
		}(i)
	}
	wg.Wait()
}
