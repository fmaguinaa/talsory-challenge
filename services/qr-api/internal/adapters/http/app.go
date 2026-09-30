package httpadapters

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/interseguro/qr-api/internal/adapters/http/problem"
	"github.com/interseguro/qr-api/internal/application"
)

// AppOptions carries everything NewApp needs to build the HTTP surface.
type AppOptions struct {
	// UseCase is the application entry point for the QR endpoint.
	UseCase *application.FactorizeUseCase
	// Logger receives request and panic logs.
	Logger *slog.Logger
	// MaxBodyBytes caps the request body; larger bodies are rejected with 413.
	MaxBodyBytes int
	// RateLimitMax caps the requests per window; zero disables rate limiting.
	RateLimitMax int
	// RateLimitWindow is the window length for the rate limiter.
	RateLimitWindow time.Duration
	// ReadTimeout bounds reading a request from the connection.
	ReadTimeout time.Duration
	// WriteTimeout bounds writing a response.
	WriteTimeout time.Duration
}

// NewApp builds the configured Fiber application.
//
// The middleware order matters and is deliberate, outermost first:
//
//	recover      a panic in any later stage still becomes a clean 500
//	requestID    guarantees the correlation id exists for every later stage
//	errorHandler normalizes everything that bubbles up to one shape
//	limiter      sheds load before any real work is done
//	logging      logs the final status, after the error handler has set it
//
// Note that Fiber's built-in recover middleware is NOT used: it produces plain
// text, and we need the panic converted to a problem document instead.
func NewApp(opts AppOptions) *fiber.App {
	app := fiber.New(fiber.Config{
		// Disable the startup banner: it pollutes container logs, which we want
		// to contain structured JSON only.
		DisableStartupMessage: true,
		AppName:               "qr-api",
		// BodyLimit is a hard backstop, deliberately looser than the limit
		// advertised to clients. maxBodyMiddleware rejects anything over
		// MaxBodyBytes with a proper problem document; Fiber's own guard sits
		// above it so a chunked request, which declares no Content-Length,
		// still cannot exhaust memory. The gap exists because Fiber's guard
		// fires at the transport layer, before any middleware runs, and would
		// otherwise pre-empt the nicer error with a bare status line.
		BodyLimit:    opts.MaxBodyBytes * hardBodyLimitFactor,
		ReadTimeout:  opts.ReadTimeout,
		WriteTimeout: opts.WriteTimeout,
		// Errors are surfaced through ErrorHandler, which builds a problem
		// document; Fiber's own text formatting is never used.
		ErrorHandler: errorHandler(opts.Logger),
		// Structured JSON logs; the logger passed through the middleware is
		// built by main and is the single source of truth.
	})

	app.Use(recoverMiddleware(opts.Logger))
	app.Use(requestIDMiddleware(opts.Logger))
	app.Use(maxBodyMiddleware(opts.MaxBodyBytes))
	app.Use(logRequestsMiddleware(opts.Logger))

	if opts.RateLimitMax > 0 {
		app.Use(limiter.New(limiter.Config{
			Max:        opts.RateLimitMax,
			Expiration: opts.RateLimitWindow,
			// The limit is per client IP, which is meaningless behind the
			// orchestrator; the orchestrator applies its own throttle at the
			// edge, where the real client address is known.
			Key: func(c *fiber.Ctx) string {
				return "qr-api-global"
			},
		}))
	}

	// Health endpoints are registered before the API so a probe never pays for
	// rate limiting, and they are deliberately unauthenticated: an orchestrator
	// must be able to check liveness without holding a token.
	registerHealth(app)

	handler := &matrixHandler{useCase: opts.UseCase}
	app.Post("/api/v1/qr/factorize", handler.factorize)

	app.Use(func(c *fiber.Ctx) error {
		return writeProblem(c, problem.New(
			fiber.StatusNotFound,
			problem.CategoryMalformedRequest,
			"Not found",
			"No route matches "+c.Method()+" "+c.Path()+".",
			c.Path(),
			requestIDOf(c),
		))
	})

	return app
}

// hardBodyLimitFactor is how far above the advertised body limit Fiber's own
// transport-level guard sits. It only ever rejects requests that slipped past
// the Content-Length check, so it is not part of the published contract.
const hardBodyLimitFactor = 8

// registerHealth installs the liveness and readiness probes.
//
// Liveness answers "is this process able to serve?" and must never depend on
// another service: if it did, a slow auth-service would make the orchestrator
// restart qr-api, turning a degradation into an outage.
//
// Readiness answers "should traffic be sent here?". qr-api has no local state
// and no persistent dependency, so it is ready as soon as its configuration
// parsed successfully; auth-service reachability is deliberately *not* a
// readiness criterion for the same reason it is not a liveness one.
func registerHealth(app *fiber.App) {
	healthHandler := func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	}
	app.Get("/health/live", healthHandler)
	app.Get("/health/ready", healthHandler)
}
