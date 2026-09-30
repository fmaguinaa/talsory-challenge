package config_test

import (
	"strings"
	"testing"
	"time"

	"github.com/interseguro/qr-api/internal/config"
)

// setEnv sets an environment variable for the duration of the test and
// registers its cleanup, so tests never leak configuration into each other.
func setEnv(t *testing.T, key, value string) {
	t.Helper()
	t.Setenv(key, value)
}

// TestLoadAppliesDefaults checks that a service with only the mandatory
// variables still boots with sensible limits, which keeps local development
// to a one-line .env.
func TestLoadAppliesDefaults(t *testing.T) {
	setEnv(t, "AUTH_SERVICE_KEY", "k")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Addr != "0.0.0.0:8081" {
		t.Errorf("Addr = %q, want the default", cfg.Addr)
	}
	if cfg.MaxMatrixDim != 100 {
		t.Errorf("MaxMatrixDim = %d, want 100", cfg.MaxMatrixDim)
	}
	if cfg.MaxBodyBytes != 1<<20 {
		t.Errorf("MaxBodyBytes = %d, want 1 MiB", cfg.MaxBodyBytes)
	}
	if cfg.AuthCacheTTL != 30*time.Second {
		t.Errorf("AuthCacheTTL = %v, want 30s", cfg.AuthCacheTTL)
	}
	if cfg.AuthValidateTimeout != 1500*time.Millisecond {
		t.Errorf("AuthValidateTimeout = %v, want 1500ms", cfg.AuthValidateTimeout)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("LogLevel = %q, want info", cfg.LogLevel)
	}
}

func TestLoadReadsOverrides(t *testing.T) {
	setEnv(t, "AUTH_SERVICE_KEY", "k")
	setEnv(t, "QR_ADDR", "0.0.0.0:9999")
	setEnv(t, "MAX_MATRIX_DIM", "25")
	setEnv(t, "QR_MAX_BODY_BYTES", "2048")
	setEnv(t, "AUTH_CACHE_TTL_SECONDS", "5")
	setEnv(t, "AUTH_VALIDATE_TIMEOUT_MS", "250")
	setEnv(t, "AUTH_SERVICE_URL", "http://auth:4000/")
	setEnv(t, "LOG_LEVEL", "debug")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Addr != "0.0.0.0:9999" {
		t.Errorf("Addr = %q", cfg.Addr)
	}
	if cfg.MaxMatrixDim != 25 {
		t.Errorf("MaxMatrixDim = %d", cfg.MaxMatrixDim)
	}
	if cfg.MaxBodyBytes != 2048 {
		t.Errorf("MaxBodyBytes = %d", cfg.MaxBodyBytes)
	}
	if cfg.AuthCacheTTL != 5*time.Second {
		t.Errorf("AuthCacheTTL = %v", cfg.AuthCacheTTL)
	}
	if cfg.AuthValidateTimeout != 250*time.Millisecond {
		t.Errorf("AuthValidateTimeout = %v", cfg.AuthValidateTimeout)
	}
	// The trailing slash is stripped so the adapter can concatenate paths.
	if cfg.AuthServiceURL != "http://auth:4000" {
		t.Errorf("AuthServiceURL = %q, want the trailing slash removed", cfg.AuthServiceURL)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("LogLevel = %q", cfg.LogLevel)
	}
}

// TestLoadFailsFastOnBadConfiguration is the central point of validating at
// startup: a typo in a limit must surface immediately with a message naming
// the variable, not on the first request that trips it.
func TestLoadFailsFastOnBadConfiguration(t *testing.T) {
	cases := []struct {
		name     string
		env      map[string]string
		wantText string
	}{
		{
			// Set to the empty string, which is what "unset" looks like to
			// os.Getenv: the credential is mandatory.
			name:     "missing service key",
			env:      map[string]string{"AUTH_SERVICE_KEY": ""},
			wantText: "AUTH_SERVICE_KEY is required",
		},
		{
			name:     "non numeric dimension",
			env:      map[string]string{"MAX_MATRIX_DIM": "many"},
			wantText: "MAX_MATRIX_DIM must be an integer",
		},
		{
			name:     "dimension below the floor",
			env:      map[string]string{"MAX_MATRIX_DIM": "0"},
			wantText: "between 1 and 10000",
		},
		{
			name:     "dimension above the ceiling",
			env:      map[string]string{"MAX_MATRIX_DIM": "99999"},
			wantText: "between 1 and 10000",
		},
		{
			name:     "body limit too small to be usable",
			env:      map[string]string{"QR_MAX_BODY_BYTES": "10"},
			wantText: "between 1024",
		},
		{
			name:     "auth cache TTL out of range",
			env:      map[string]string{"AUTH_CACHE_TTL_SECONDS": "-1"},
			wantText: "AUTH_CACHE_TTL_SECONDS",
		},
		{
			name:     "auth timeout out of range",
			env:      map[string]string{"AUTH_VALIDATE_TIMEOUT_MS": "5"},
			wantText: "AUTH_VALIDATE_TIMEOUT_MS",
		},
		{
			name:     "unknown log level",
			env:      map[string]string{"LOG_LEVEL": "chatty"},
			wantText: "LOG_LEVEL must be one of",
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			// A valid base configuration, with the case's overrides applied on
			// top, so the assertion is about the specific field under test.
			setEnv(t, "AUTH_SERVICE_KEY", "k")
			for k, v := range tc.env {
				setEnv(t, k, v)
			}
			_, err := config.Load()
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.wantText) {
				t.Errorf("error = %q, want it to mention %q", err.Error(), tc.wantText)
			}
		})
	}
}
