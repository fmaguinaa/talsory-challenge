// Package authclient implements the TokenValidator port by calling
// auth-service's RFC 7662-style introspection endpoint.
//
// Design notes (ADR-005):
//   - The service is fail-closed: any transport error, timeout or unexpected
//     status becomes ErrAuthUnavailable, never a pass.
//   - Only positive answers are cached, and only until the token's own expiry.
//     Caching negatives would let a revoked token stay rejected after it is
//     legitimately re-issued, and caching beyond exp would accept dead tokens.
//   - The cache is keyed by the SHA-256 digest of the token, never the token
//     itself, so a heap dump of the service cannot leak bearer tokens.
//   - The cache is per instance, so the revocation latency is bounded by the
//     TTL rather than being instantaneous. That is a deliberate trade: it buys
//     one fewer network hop on every authenticated request.
package authclient

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/interseguro/qr-api/internal/application"
)

// defaultCacheSize bounds the cache so a flood of one-off tokens cannot grow
// the process heap without limit.
const defaultCacheSize = 4096

// maxResponseBytes caps how much of an introspection response is read. The
// payload is a handful of claims, so anything larger is a misconfiguration or
// an attack, and an unbounded read would let a peer exhaust our memory.
const maxResponseBytes = 64 << 10

// Config configures the introspection client.
type Config struct {
	// BaseURL is the auth-service base URL, without a trailing slash.
	BaseURL string
	// ServiceKey is the shared secret sent in the X-Service-Key header.
	ServiceKey string
	// Timeout bounds a single introspection call.
	Timeout time.Duration
	// CacheTTL is the lifetime of a cached active answer. Zero disables caching.
	CacheTTL time.Duration
}

// introspectionResponse mirrors the auth-service /auth/validate payload.
type introspectionResponse struct {
	Active bool   `json:"active"`
	Sub    string `json:"sub"`
	Scope  string `json:"scope"`
	Exp    int64  `json:"exp"`
}

// cacheEntry is one memoized introspection answer.
type cacheEntry struct {
	// expiresAt is when the entry stops being usable.
	expiresAt time.Time
	// tokenExp is the token's own expiry, used to cap the entry lifetime.
	tokenExp time.Time
}

// Validator is the HTTP adapter for application.TokenValidator.
//
// The zero value is not usable; construct one with NewValidator.
type Validator struct {
	// client is the HTTP client performing the introspection calls.
	client *http.Client
	// baseURL is the auth-service base URL.
	baseURL string
	// serviceKey is the credential presented to auth-service.
	serviceKey string
	// cacheTTL is the configured lifetime of a cached active answer.
	cacheTTL time.Duration

	// mu guards entries.
	mu sync.RWMutex
	// entries maps a token digest to its cached answer.
	entries map[[sha256.Size]byte]cacheEntry
}

// NewValidator builds a Validator from cfg.
//
// The HTTP client is given its own timeout as a backstop in addition to the
// per-call context deadline, so a hijacked connection cannot pin a goroutine
// forever.
func NewValidator(cfg Config) (*Validator, error) {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return nil, errors.New("authclient: BaseURL is required")
	}
	if strings.TrimSpace(cfg.ServiceKey) == "" {
		return nil, errors.New("authclient: ServiceKey is required")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 1500 * time.Millisecond
	}
	return &Validator{
		client: &http.Client{
			Timeout: timeout,
			// The service calls a handful of internal hosts; keeping the
			// default transport avoids a per-connection socket leak when
			// pods are recycled.
		},
		baseURL:    strings.TrimRight(cfg.BaseURL, "/"),
		serviceKey: cfg.ServiceKey,
		cacheTTL:   cfg.CacheTTL,
		entries:    make(map[[sha256.Size]byte]cacheEntry),
	}, nil
}

// Validate reports whether the token is currently active.
//
// It returns nil when the token is valid, application.ErrInvalidToken when the
// authority says it is not, and application.ErrAuthUnavailable when the
// authority could not be asked. The distinction matters: the first is a 401,
// the second is a 503.
func (v *Validator) Validate(ctx context.Context, token string) error {
	if strings.TrimSpace(token) == "" {
		return application.ErrInvalidToken
	}

	digest := sha256.Sum256([]byte(token))
	if v.isCached(digest) {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, v.client.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v.baseURL+"/auth/validate", nil)
	if err != nil {
		return fmt.Errorf("%w: building introspection request: %v", application.ErrAuthUnavailable, err)
	}
	req.Header.Set("X-Service-Key", v.serviceKey)
	req.Header.Set("Accept", "application/json")

	resp, err := v.client.Do(req)
	if err != nil {
		// Timeouts, refused connections and DNS failures all land here. They
		// are indistinguishable from the caller's perspective and all mean the
		// same thing: we cannot vouch for the token.
		return fmt.Errorf("%w: introspection call failed: %v", application.ErrAuthUnavailable, err)
	}
	defer func() {
		// Drain a bounded amount so the connection can be reused, then close.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseBytes))
		_ = resp.Body.Close()
	}()

	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		// auth-service rejected *us* (bad or missing service key). That is a
		// deployment misconfiguration, not a bad user token, and it must never
		// be reported as 401 or the client would think re-authenticating helps.
		return fmt.Errorf("%w: introspection rejected the service credential (HTTP %d)", application.ErrAuthUnavailable, resp.StatusCode)
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("%w: unexpected introspection status %d", application.ErrAuthUnavailable, resp.StatusCode)
	}

	var body introspectionResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&body); err != nil {
		return fmt.Errorf("%w: malformed introspection response: %v", application.ErrAuthUnavailable, err)
	}

	if !body.Active {
		return application.ErrInvalidToken
	}

	v.store(digest, body.Exp)
	return nil
}

// isCached reports whether the digest has a live cache entry.
func (v *Validator) isCached(digest [sha256.Size]byte) bool {
	if v.cacheTTL <= 0 {
		return false
	}
	v.mu.RLock()
	entry, ok := v.entries[digest]
	v.mu.RUnlock()
	if !ok {
		return false
	}
	if time.Now().After(entry.expiresAt) {
		// Lazily evict rather than running a sweeper: entries are tiny and a
		// background goroutine would be harder to reason about than a stale
		// entry that is simply ignored once.
		v.mu.Lock()
		delete(v.entries, digest)
		v.mu.Unlock()
		return false
	}
	return true
}

// store memoizes a positive answer for the digest.
//
// The entry lifetime is the minimum of the configured TTL and the time left on
// the token itself, so the cache can never make an expired token look active.
func (v *Validator) store(digest [sha256.Size]byte, tokenExp int64) {
	if v.cacheTTL <= 0 {
		return
	}
	now := time.Now()
	expiresAt := now.Add(v.cacheTTL)
	if tokenExp > 0 {
		if tokenExpiry := time.Unix(tokenExp, 0); tokenExpiry.Before(expiresAt) {
			expiresAt = tokenExpiry
		}
	}
	// A token that expires in the past is not worth caching, and an empty
	// window would just churn the map.
	if !expiresAt.After(now) {
		return
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	// Bound the map. Dropping the whole cache at the ceiling is crude but
	// predictable and happens at most once per cacheSize distinct tokens.
	if len(v.entries) >= defaultCacheSize {
		v.entries = make(map[[sha256.Size]byte]cacheEntry, defaultCacheSize)
	}
	v.entries[digest] = cacheEntry{expiresAt: expiresAt, tokenExp: time.Unix(tokenExp, 0)}
}

// ValidationRequestBody is the fallback form accepted by /auth/validate. It is
// exported because the integration tests assert that the header path is used
// and that this shape is understood by the authority.
type ValidationRequestBody struct {
	// Token is the compact JWT to introspect.
	Token string `json:"token"`
}

// Encode renders the body used when a token cannot travel in a header.
func (b ValidationRequestBody) Encode() ([]byte, error) {
	return json.Marshal(b)
}

// compile-time assertion that the adapter satisfies the port it exists for.
var _ application.TokenValidator = (*Validator)(nil)
