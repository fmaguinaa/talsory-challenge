// Command qr-api serves the QR factorization endpoint.
//
// It is a thin composition root: read configuration, build the adapters, wire
// them into the use case, start the server, and shut down cleanly on SIGTERM.
// All real logic lives in internal/, which keeps this file readable and makes
// the interesting parts testable without a process.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/interseguro/qr-api/internal/adapters/authclient"
	httpadapters "github.com/interseguro/qr-api/internal/adapters/http"
	"github.com/interseguro/qr-api/internal/application"
	"github.com/interseguro/qr-api/internal/config"
)

func main() {
	if err := run(); err != nil {
		// The logger may not exist yet if configuration failed, so this one
		// message goes to stderr in the standard library's plain format.
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

// run wires and runs the service, returning an error instead of exiting so
// that a failure has a single exit path.
func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	logger := newLogger(cfg.LogLevel)
	slog.SetDefault(logger)

	validator, err := authclient.NewValidator(authclient.Config{
		BaseURL:    cfg.AuthServiceURL,
		ServiceKey: cfg.AuthServiceKey,
		Timeout:    cfg.AuthValidateTimeout,
		CacheTTL:   cfg.AuthCacheTTL,
	})
	if err != nil {
		return fmt.Errorf("token validator: %w", err)
	}

	useCase := &application.FactorizeUseCase{
		Factorizer:   application.HouseholderFactorizer{},
		MaxMatrixDim: cfg.MaxMatrixDim,
		Validator:    validator,
	}

	app := httpadapters.NewApp(httpadapters.AppOptions{
		UseCase:         useCase,
		Logger:          logger,
		MaxBodyBytes:    cfg.MaxBodyBytes,
		ReadTimeout:     10 * time.Second,
		WriteTimeout:    15 * time.Second,
		RateLimitMax:    120,
		RateLimitWindow: time.Minute,
	})

	// Serving runs in its own goroutine so the signal handler below owns the
	// main goroutine and shutdown can be sequenced deterministically.
	serverErr := make(chan error, 1)
	go func() {
		logger.Info("qr-api listening",
			slog.String("addr", cfg.Addr),
			slog.Int("maxMatrixDim", cfg.MaxMatrixDim),
			slog.String("authServiceUrl", cfg.AuthServiceURL),
			slog.Duration("authCacheTtl", cfg.AuthCacheTTL),
		)
		if err := app.Listen(cfg.Addr); err != nil {
			serverErr <- err
		}
	}()

	// SIGINT is for local development (Ctrl-C); SIGTERM is what container
	// orchestrators send. Both must drain in-flight requests, otherwise a
	// rolling deploy drops calls mid-flight.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	select {
	case err := <-serverErr:
		// app.Listen returns nil after a clean shutdown, so a non-nil value here
		// is a genuine failure such as a port already in use.
		if err != nil && !errors.Is(err, context.Canceled) {
			return fmt.Errorf("server: %w", err)
		}
		return nil
	case <-ctx.Done():
		logger.Info("shutdown signal received", slog.Duration("grace", cfg.ShutdownGrace))
	}

	// App.Shutdown waits for in-flight requests to finish or for the grace
	// period to expire, whichever comes first.
	if err := app.ShutdownWithTimeout(cfg.ShutdownGrace); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	logger.Info("qr-api stopped cleanly")
	return nil
}

// newLogger builds the structured JSON logger used by the whole service.
func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}
