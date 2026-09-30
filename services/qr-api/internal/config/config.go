// Package config loads and validates the service configuration from the
// environment.
//
// Validation happens once, at startup, and a bad value is a fatal error: a
// service that boots with a nonsensical limit or a missing auth-service URL
// would otherwise fail much later, in the middle of a request, with a much
// less obvious message.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds every runtime setting of qr-api.
type Config struct {
	// Addr is the listen address, e.g. "0.0.0.0:8081".
	Addr string
	// MaxMatrixDim is the largest number of rows or columns accepted.
	MaxMatrixDim int
	// MaxBodyBytes caps the request body size; larger bodies get a 413.
	MaxBodyBytes int
	// ShutdownGrace bounds how long in-flight requests may take to drain.
	ShutdownGrace time.Duration

	// AuthServiceURL is the base URL of auth-service, e.g. "http://auth-service:4000".
	AuthServiceURL string
	// AuthServiceKey is the shared secret sent as X-Service-Key.
	AuthServiceKey string
	// AuthCacheTTL is the lifetime of a cached "token is active" answer.
	AuthCacheTTL time.Duration
	// AuthValidateTimeout bounds a single introspection call.
	AuthValidateTimeout time.Duration

	// LogLevel is one of debug, info, warn, error.
	LogLevel string
}

// Load reads the configuration from the environment, applying defaults for
// everything that has a sensible one, and returns an error describing the
// first problem it finds.
func Load() (*Config, error) {
	cfg := &Config{
		Addr:         envOrDefault("QR_ADDR", "0.0.0.0:8081"),
		LogLevel:     envOrDefault("LOG_LEVEL", "info"),
		AuthCacheTTL: 30 * time.Second,
	}

	var err error
	if cfg.MaxMatrixDim, err = intFromEnv("MAX_MATRIX_DIM", 100, 1, 10000); err != nil {
		return nil, err
	}
	if cfg.MaxBodyBytes, err = intFromEnv("QR_MAX_BODY_BYTES", 1<<20, 1024, 1<<30); err != nil {
		return nil, err
	}
	if graceSeconds, err := intFromEnv("SHUTDOWN_GRACE_SECONDS", 10, 1, 300); err != nil {
		return nil, err
	} else {
		cfg.ShutdownGrace = time.Duration(graceSeconds) * time.Second
	}

	cfg.AuthServiceURL = strings.TrimRight(envOrDefault("AUTH_SERVICE_URL", "http://auth-service:4000"), "/")
	cfg.AuthServiceKey = os.Getenv("AUTH_SERVICE_KEY")
	if cfg.AuthServiceKey == "" {
		return nil, fmt.Errorf("AUTH_SERVICE_KEY is required: it is the credential qr-api presents to auth-service when introspecting a token")
	}
	if ttl, err := intFromEnv("AUTH_CACHE_TTL_SECONDS", 30, 0, 3600); err != nil {
		return nil, err
	} else {
		cfg.AuthCacheTTL = time.Duration(ttl) * time.Second
	}
	if timeoutMs, err := intFromEnv("AUTH_VALIDATE_TIMEOUT_MS", 1500, 50, 60000); err != nil {
		return nil, err
	} else {
		cfg.AuthValidateTimeout = time.Duration(timeoutMs) * time.Millisecond
	}

	switch cfg.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return nil, fmt.Errorf("LOG_LEVEL must be one of debug, info, warn, error; got %q", cfg.LogLevel)
	}

	return cfg, nil
}

// envOrDefault returns the value of key, or fallback when it is unset or empty.
func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// intFromEnv parses an integer environment variable, enforcing an inclusive
// range. A value outside the range is a configuration mistake worth failing
// fast on: silently clamping it would hide a typo until requests start failing.
func intFromEnv(key string, fallback, min, max int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer, got %q", key, raw)
	}
	if value < min || value > max {
		return 0, fmt.Errorf("%s must be between %d and %d, got %d", key, min, max, value)
	}
	return value, nil
}
