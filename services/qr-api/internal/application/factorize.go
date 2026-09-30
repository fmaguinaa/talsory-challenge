// Package application holds the use cases of qr-api and the ports they depend
// on. It knows nothing about Fiber, HTTP status codes or JSON: it works with
// Go values and domain errors, which is what makes it testable without a
// server and keeps the transport concerns in the adapters.
package application

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/interseguro/qr-api/internal/domain/qr"
)

// Sentinel errors describing why a request could not be served. The HTTP
// adapter maps each one to a status code and a problem+json body, so the
// translation table lives in exactly one place.
var (
	// ErrInvalidMatrix means the matrix is structurally unusable: ragged,
	// empty, non-finite, or beyond the configured dimension limit. It maps to
	// 422 because the request was syntactically fine but semantically wrong.
	ErrInvalidMatrix = errors.New("invalid matrix")
	// ErrMatrixTooLarge is a resource-limit violation, distinct from a
	// malformed matrix: it maps to 413 so clients can tell "too big" from
	// "wrong shape".
	ErrMatrixTooLarge = errors.New("matrix exceeds the configured dimension limit")
	// ErrInvalidToken means the bearer token is missing, malformed, expired or
	// otherwise rejected by the authority. It maps to 401.
	ErrInvalidToken = errors.New("invalid or missing bearer token")
	// ErrAuthUnavailable means auth-service could not be reached or did not
	// answer in time. It maps to 503, never to 401: we genuinely do not know
	// whether the token is valid, and failing closed is the safe choice.
	ErrAuthUnavailable = errors.New("authentication service unavailable")
)

// MatrixError carries a human-readable reason alongside ErrInvalidMatrix so
// the client learns *what* is wrong, e.g. "row 2 has length 2, expected 3".
type MatrixError struct {
	// Reason is the precise explanation shown to the caller.
	Reason string
	// Err is the sentinel this error wraps.
	Err error
}

// Error implements the error interface.
func (e *MatrixError) Error() string { return e.Reason }

// Unwrap exposes the sentinel so errors.Is works.
func (e *MatrixError) Unwrap() error { return e.Err }

// newMatrixError builds a MatrixError wrapping ErrInvalidMatrix.
func newMatrixError(format string, args ...any) *MatrixError {
	return &MatrixError{Reason: fmt.Sprintf(format, args...), Err: ErrInvalidMatrix}
}

// TokenValidator is the port through which the use case asks whether a bearer
// token is currently valid.
//
// It is declared here, in the application layer, and implemented by an adapter
// that speaks HTTP to auth-service. Depending on the interface rather than the
// client keeps the direction of dependencies pointing inward, and lets tests
// substitute a stub without standing up a server.
type TokenValidator interface {
	// Validate reports whether the token is active. It must return
	// ErrAuthUnavailable if the authority cannot be reached, and must never
	// return a positive answer it did not actually obtain.
	Validate(ctx context.Context, token string) error
}

// Factorizer is the port for the numerical core. The production implementation
// is qr.Householder; the indirection exists so the use case can be tested
// without exercising floating-point behaviour.
type Factorizer interface {
	// Factorize returns the full QR factorization of the given matrix.
	Factorize(matrix *qr.Matrix) (*qr.Factorization, error)
}

// FactorizeUseCase validates the request matrix and returns its QR
// factorization. It is the single entry point of the application layer.
type FactorizeUseCase struct {
	// Factorizer performs the numerical work.
	Factorizer Factorizer
	// MaxMatrixDim is the largest number of rows or columns accepted.
	MaxMatrixDim int
	// Validator authorizes the caller before any work is done.
	Validator TokenValidator
}

// FactorizeRequest is the use case input, in domain terms: a slice of rows
// rather than a JSON document.
type FactorizeRequest struct {
	// Token is the raw bearer token presented by the caller.
	Token string
	// Rows is the matrix as sent by the client.
	Rows [][]float64
}

// FactorizeResult is the use case output, ready to be serialized.
type FactorizeResult struct {
	// Q is the orthogonal factor, m x m.
	Q [][]float64
	// R is the upper triangular factor, m x n.
	R [][]float64
}

// Execute runs the use case: authorize first, validate second, compute last.
//
// Authorizing before validating is deliberate. A caller without a valid token
// learns nothing about the shape rules, which keeps the endpoint from being a
// free oracle for probing the validation logic, and it avoids spending CPU on
// requests that would be rejected anyway.
func (uc *FactorizeUseCase) Execute(ctx context.Context, req FactorizeRequest) (*FactorizeResult, error) {
	if strings.TrimSpace(req.Token) == "" {
		return nil, ErrInvalidToken
	}
	if uc.Validator != nil {
		if err := uc.Validator.Validate(ctx, req.Token); err != nil {
			return nil, err
		}
	}

	matrix, err := uc.parseMatrix(req.Rows)
	if err != nil {
		return nil, err
	}

	f, err := uc.Factorizer.Factorize(matrix)
	if err != nil {
		// The domain rejects only non-finite input, which the parser above
		// already excludes. Reaching here means the request slipped past a
		// check, so it is reported as an invalid matrix rather than a 500:
		// there is no useful internal detail to expose to the caller anyway.
		return nil, &MatrixError{
			Reason: fmt.Sprintf("matrix could not be factorized: %v", err),
			Err:    ErrInvalidMatrix,
		}
	}

	return &FactorizeResult{Q: f.Q.ToRows(), R: f.R.ToRows()}, nil
}

// parseMatrix turns raw request rows into a validated domain matrix.
//
// Every rule here exists because skipping it produces a wrong answer rather
// than a clean failure: a ragged matrix silently produces a shorter factor,
// and a NaN silently poisons every statistic computed downstream.
func (uc *FactorizeUseCase) parseMatrix(rows [][]float64) (*qr.Matrix, error) {
	if len(rows) == 0 {
		return nil, newMatrixError("matrix must contain at least one row")
	}
	if uc.MaxMatrixDim > 0 {
		if len(rows) > uc.MaxMatrixDim {
			return nil, &MatrixError{
				Reason: fmt.Sprintf("matrix has %d rows, the maximum is %d", len(rows), uc.MaxMatrixDim),
				Err:    ErrMatrixTooLarge,
			}
		}
		if len(rows[0]) > uc.MaxMatrixDim {
			return nil, &MatrixError{
				Reason: fmt.Sprintf("matrix has %d columns, the maximum is %d", len(rows[0]), uc.MaxMatrixDim),
				Err:    ErrMatrixTooLarge,
			}
		}
	}

	cols := len(rows[0])
	if cols == 0 {
		return nil, newMatrixError("matrix must contain at least one column per row")
	}

	// The copy inside FromRows is what allows the per-element checks below to
	// report the exact position of a bad value.
	for i, row := range rows {
		if len(row) != cols {
			return nil, newMatrixError("row %d has length %d, expected %d", i, len(row), cols)
		}
		for j, v := range row {
			if !isFinite(v) {
				return nil, newMatrixError("value at row %d, column %d is not a finite number", i, j)
			}
		}
	}

	matrix, err := qr.FromRows(rows)
	if err != nil {
		// Unreachable given the checks above, but converting it keeps the
		// invariant local rather than relying on a comment.
		return nil, newMatrixError("invalid matrix: %v", err)
	}
	return matrix, nil
}

// isFinite reports whether v is neither NaN nor an infinity.
func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

// HouseholderFactorizer adapts the pure domain function to the Factorizer
// port. It exists so the use case depends on an interface rather than on a
// package-level function, which keeps the domain free to change its signature
// without rippling into the tests and wiring.
type HouseholderFactorizer struct{}

// Factorize runs the Householder QR factorization.
func (HouseholderFactorizer) Factorize(matrix *qr.Matrix) (*qr.Factorization, error) {
	return qr.Householder(matrix)
}
