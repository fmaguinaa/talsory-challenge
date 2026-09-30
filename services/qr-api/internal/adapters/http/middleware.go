// Package httpadapters wires the Fiber application: middleware, DTOs and
// handlers. Everything here is transport concern; no business rule lives in
// this package, which is what lets the use case be tested without a server.
package httpadapters

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/interseguro/qr-api/internal/adapters/http/problem"
	"github.com/interseguro/qr-api/internal/application"
)

// requestIDHeader is the correlation header propagated across all services.
const requestIDHeader = "X-Request-Id"

// contextKeyRequestID is the private key type used to store the request id in
// a context. A named type prevents collisions with other packages' keys.
type contextKeyRequestID struct{}

// requestIDOf returns the correlation id for the current request.
//
// It reads the *response* header, because that is where requestIDMiddleware
// stored the generated id: c.Get only inspects the inbound request headers, so
// using it here would yield an empty id whenever the client did not send one.
func requestIDOf(c *fiber.Ctx) string {
	if id := c.GetRespHeader(requestIDHeader); id != "" {
		return id
	}
	return c.Get(requestIDHeader)
}

// maxBodyMiddleware rejects an oversized body with a proper problem document.
//
// Fiber's own BodyLimit guard is configured too, but it surfaces as a bare
// Fiber error and, depending on the version, may only trip once the body is
// actually read. Checking Content-Length up front makes the 413 deterministic
// and lets the body be rejected without ever being buffered.
func maxBodyMiddleware(maxBytes int) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if maxBytes > 0 && c.Request().Header.ContentLength() > maxBytes {
			return writeProblem(c, problem.New(
				fiber.StatusRequestEntityTooLarge,
				problem.CategoryPayloadTooLarge,
				"Payload too large",
				"The request body exceeds the maximum accepted size of "+strconv.Itoa(maxBytes)+" bytes.",
				c.Path(),
				requestIDOf(c),
			))
		}
		return c.Next()
	}
}

// requestIDFrom returns the correlation id stored in ctx, or "" if absent.
func requestIDFrom(ctx context.Context) string {
	if v, ok := ctx.Value(contextKeyRequestID{}).(string); ok {
		return v
	}
	return ""
}

// requestIDMiddleware ensures every request carries an X-Request-Id and makes
// it available to the logger and to error bodies.
//
// The id is taken from the inbound header when present so a trace started at
// the orchestrator survives across all four services; otherwise one is
// generated here. The value is validated before being trusted: an attacker
// could otherwise inject newlines and forge log entries.
func requestIDMiddleware(logger *slog.Logger) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := strings.TrimSpace(c.Get(requestIDHeader))
		if !validRequestID(id) {
			id = newRequestID()
		}
		c.Set(requestIDHeader, id)
		c.SetUserContext(context.WithValue(c.UserContext(), contextKeyRequestID{}, id))
		return c.Next()
	}
}

// newRequestID mints a correlation id for requests that arrive without one.
// UUIDv4 is used because it needs no state and has no collision concerns across
// four services logging concurrently.
func newRequestID() string {
	return uuid.NewString()
}

// validRequestID reports whether the header value is safe to reuse verbatim.
func validRequestID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

// recoverMiddleware turns a panic into a problem+json 500 without leaking the
// panic value or stack to the client.
//
// Without this a panic in a handler takes the whole connection down and Fiber's
// default error handler returns plain text, which would break the promise that
// every error body in this system is a problem document.
func recoverMiddleware(logger *slog.Logger) fiber.Handler {
	return func(c *fiber.Ctx) (err error) {
		defer func() {
			if r := recover(); r != nil {
				// The panic value goes to the log, never to the client: it can
				// contain pointers, internal paths or request payloads.
				logger.Error("panic recovered",
					slog.Any("panic", r),
					slog.String("requestId", requestIDOf(c)),
					slog.String("path", c.Path()),
				)
				err = writeProblem(c, problem.New(
					fiber.StatusInternalServerError,
					problem.CategoryInternal,
					"Internal server error",
					"The service failed to handle the request.",
					c.Path(),
					c.Get(requestIDHeader),
				))
			}
		}()
		return c.Next()
	}
}

// writeProblem serializes a problem document into the Fiber response.
func writeProblem(c *fiber.Ctx, resp problem.Response) error {
	for k, v := range resp.Headers {
		c.Set(k, v)
	}
	body, err := resp.Encode()
	if err != nil {
		// A problem document that cannot be serialized is a bug in this
		// package. Rather than recursing, the caller falls back to a minimal
		// hand-written JSON object, which cannot fail.
		body = []byte(`{"type":"` + problem.TypeBase + string(problem.CategoryInternal) +
			`","title":"Internal server error","status":500,` +
			`"detail":"The service failed to handle the request.","instance":"","requestId":""}`)
	}
	c.Set(fiber.HeaderContentType, problem.MediaType)
	c.Status(resp.Detail.Status)
	// Send with raw bytes rather than c.JSON: Fiber's JSON helper always labels
	// the body application/json, and RFC 9457 mandates application/problem+json,
	// which some clients branch on.
	return c.Send(body)
}

// errorHandler is Fiber's catch-all error handler. It converts an error that
// bubbled up to the router into a problem document, mapping known sentinel
// errors to their status codes and treating everything else as a 500.
func errorHandler(logger *slog.Logger) fiber.ErrorHandler {
	return func(c *fiber.Ctx, err error) error {
		requestID := requestIDOf(c)

		// Fiber's own errors (404, 405, body-too-large, ...) carry a status.
		var fiberErr *fiber.Error
		if errors.As(err, &fiberErr) {
			category, title := categoryForStatus(fiberErr.Code)
			return writeProblem(c, problem.New(fiberErr.Code, category, title, fiberErr.Message, c.Path(), requestID))
		}

		// Errors raised by the use case keep their own precise wording, because
		// "row 2 has length 2, expected 3" is exactly what a client needs.
		var matrixErr *application.MatrixError
		if errors.As(err, &matrixErr) {
			status := fiber.StatusUnprocessableEntity
			category := problem.CategoryInvalidMatrix
			title := "Invalid matrix"
			if errors.Is(err, application.ErrMatrixTooLarge) {
				status = fiber.StatusRequestEntityTooLarge
				category = problem.CategoryPayloadTooLarge
				title = "Matrix too large"
			}
			return writeProblem(c, problem.New(status, category, title, matrixErr.Reason, c.Path(), requestID))
		}

		switch {
		case errors.Is(err, application.ErrInvalidToken):
			return writeProblem(c, problem.New(
				fiber.StatusUnauthorized, problem.CategoryUnauthorized, "Unauthorized",
				"A valid bearer token is required.", c.Path(), requestID,
			))
		case errors.Is(err, application.ErrAuthUnavailable):
			// Retry-After is included so a well-behaved client backs off instead
			// of hammering a dependency that is already in trouble.
			return writeProblem(c, problem.Response{
				Detail: problem.New(
					fiber.StatusServiceUnavailable, problem.CategoryServiceUnavailable, "Service unavailable",
					"The authentication service could not be reached, so the request could not be authorized.",
					c.Path(), requestID,
				).Detail,
				Headers: map[string]string{
					"Retry-After": strconv.Itoa(int(retryAfterSeconds)),
					// RFC 6750: tell the client how to authenticate.
					"WWW-Authenticate": `Bearer realm="qr-api"`,
				},
			})
		}

		// Anything else is a bug. Log it with detail, tell the client nothing.
		logger.Error("unhandled error",
			slog.String("requestId", requestID),
			slog.String("path", c.Path()),
			slog.Any("error", err),
		)
		return writeProblem(c, problem.New(
			fiber.StatusInternalServerError, problem.CategoryInternal, "Internal server error",
			"The service failed to handle the request.", c.Path(), requestID,
		))
	}
}

// retryAfterSeconds is how long a client is asked to wait after a 503.
const retryAfterSeconds = 5

// categoryForStatus picks the problem category for a bare HTTP status.
func categoryForStatus(status int) (problem.Category, string) {
	switch status {
	case fiber.StatusBadRequest:
		return problem.CategoryMalformedRequest, "Malformed request"
	case fiber.StatusUnauthorized, fiber.StatusForbidden:
		return problem.CategoryUnauthorized, "Unauthorized"
	case fiber.StatusNotFound:
		return problem.CategoryMalformedRequest, "Not found"
	case fiber.StatusRequestEntityTooLarge:
		return problem.CategoryPayloadTooLarge, "Payload too large"
	case fiber.StatusUnprocessableEntity:
		return problem.CategoryInvalidMatrix, "Invalid matrix"
	case fiber.StatusTooManyRequests:
		return problem.CategoryRateLimited, "Too many requests"
	case fiber.StatusBadGateway:
		return problem.CategoryBadGateway, "Bad gateway"
	case fiber.StatusGatewayTimeout:
		return problem.CategoryGatewayTimeout, "Gateway timeout"
	case fiber.StatusServiceUnavailable:
		return problem.CategoryServiceUnavailable, "Service unavailable"
	case fiber.StatusRequestTimeout, fiber.StatusGatewayTimeout + 1000:
		return problem.CategoryGatewayTimeout, "Gateway timeout"
	default:
		return problem.CategoryInternal, "Internal server error"
	}
}

// logRequestsMiddleware emits one structured line per request after it
// completes. The line carries the correlation id and the outcome, which is
// what makes a cross-service trace possible from the logs alone.
func logRequestsMiddleware(logger *slog.Logger) fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		if err != nil {
			// Let the error handler turn it into a response first, so the log
			// line records the status that was actually sent.
			err = c.App().ErrorHandler(c, err)
		}
		logger.Info("request",
			slog.String("requestId", requestIDOf(c)),
			slog.String("method", c.Method()),
			slog.String("path", c.Path()),
			slog.Int("status", c.Response().StatusCode()),
			slog.Duration("duration", time.Since(start)),
		)
		return err
	}
}
