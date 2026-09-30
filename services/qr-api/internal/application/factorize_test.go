package application_test

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/interseguro/qr-api/internal/application"
	"github.com/interseguro/qr-api/internal/domain/qr"
)

// stubValidator is a TokenValidator whose answer the test controls.
type stubValidator struct {
	// err is returned by Validate.
	err error
	// calls counts invocations.
	calls int
	// seenTokens records every token passed in, so a test can assert that the
	// raw token is forwarded rather than parsed or truncated.
	seenTokens []string
}

// Validate implements application.TokenValidator.
func (s *stubValidator) Validate(_ context.Context, token string) error {
	s.calls++
	s.seenTokens = append(s.seenTokens, token)
	return s.err
}

// allowing returns a validator that accepts every token.
func allowing() *stubValidator { return &stubValidator{} }

// newUseCase builds a use case wired to the real algorithm and a stub
// validator, with the given dimension limit.
func newUseCase(validator application.TokenValidator, maxDim int) *application.FactorizeUseCase {
	return &application.FactorizeUseCase{
		Factorizer:   application.HouseholderFactorizer{},
		MaxMatrixDim: maxDim,
		Validator:    validator,
	}
}

func TestExecuteHappyPath(t *testing.T) {
	t.Parallel()

	validator := allowing()
	uc := newUseCase(validator, 100)

	result, err := uc.Execute(context.Background(), application.FactorizeRequest{
		Token: "a.b.c",
		Rows:  [][]float64{{12, -51, 4}, {6, 167, -68}, {-4, 24, -41}},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(result.Q) != 3 || len(result.R) != 3 {
		t.Fatalf("shapes: Q %d rows, R %d rows; want 3 and 3", len(result.Q), len(result.R))
	}
	if validator.calls != 1 {
		t.Errorf("validator called %d times, want 1", validator.calls)
	}
	// The token must reach the port untouched.
	if len(validator.seenTokens) != 1 || validator.seenTokens[0] != "a.b.c" {
		t.Errorf("tokens seen = %v, want [a.b.c]", validator.seenTokens)
	}
}

func TestExecuteAuthorizesBeforeValidating(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want error
	}{
		{
			name: "invalid token wins over an invalid matrix",
			err:  application.ErrInvalidToken,
			// The matrix below is deliberately malformed. If validation ran
			// first we would see ErrInvalidMatrix instead, which would mean an
			// unauthenticated caller could probe the validation rules.
			want: application.ErrInvalidToken,
		},
		{
			name: "auth unavailable is not reported as an invalid token",
			err:  application.ErrAuthUnavailable,
			want: application.ErrAuthUnavailable,
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			uc := newUseCase(&stubValidator{err: tc.err}, 100)
			_, err := uc.Execute(context.Background(), application.FactorizeRequest{
				Token: "a.b.c",
				Rows:  [][]float64{{1, 2, 3}, {4, 5}},
			})
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want it to wrap %v", err, tc.want)
			}
		})
	}
}

func TestExecuteRequiresAToken(t *testing.T) {
	t.Parallel()

	for _, token := range []string{"", "   ", "\t"} {
		validator := allowing()
		uc := newUseCase(validator, 100)
		_, err := uc.Execute(context.Background(), application.FactorizeRequest{
			Token: token,
			Rows:  [][]float64{{1}},
		})
		if !errors.Is(err, application.ErrInvalidToken) {
			t.Errorf("token %q: error = %v, want ErrInvalidToken", token, err)
		}
		if validator.calls != 0 {
			t.Errorf("token %q: validator was called %d times, want 0", token, validator.calls)
		}
	}
}

func TestExecuteRejectsInvalidMatrices(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		rows       [][]float64
		maxDim     int
		wantErr    error
		wantReason string
	}{
		{
			name:       "no rows",
			rows:       nil,
			maxDim:     100,
			wantErr:    application.ErrInvalidMatrix,
			wantReason: "at least one row",
		},
		{
			name:       "empty row",
			rows:       [][]float64{{}},
			maxDim:     100,
			wantErr:    application.ErrInvalidMatrix,
			wantReason: "at least one column",
		},
		{
			name:       "ragged",
			rows:       [][]float64{{1, 2, 3}, {4, 5}},
			maxDim:     100,
			wantErr:    application.ErrInvalidMatrix,
			wantReason: "row 1 has length 2, expected 3",
		},
		{
			name:       "ragged with a longer second row",
			rows:       [][]float64{{1, 2}, {3, 4, 5}},
			maxDim:     100,
			wantErr:    application.ErrInvalidMatrix,
			wantReason: "row 1 has length 3, expected 2",
		},
		{
			name:       "too many rows",
			rows:       [][]float64{{1}, {2}, {3}, {4}, {5}},
			maxDim:     4,
			wantErr:    application.ErrMatrixTooLarge,
			wantReason: "5 rows, the maximum is 4",
		},
		{
			name:       "too many columns",
			rows:       [][]float64{{1, 2, 3, 4, 5}},
			maxDim:     4,
			wantErr:    application.ErrMatrixTooLarge,
			wantReason: "5 columns, the maximum is 4",
		},
		{
			name:       "limit is inclusive",
			rows:       [][]float64{{1, 2, 3, 4}},
			maxDim:     4,
			wantErr:    nil,
			wantReason: "",
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			uc := newUseCase(allowing(), tc.maxDim)
			result, err := uc.Execute(context.Background(), application.FactorizeRequest{
				Token: "a.b.c",
				Rows:  tc.rows,
			})
			if tc.wantErr == nil {
				if err != nil {
					t.Fatalf("Execute: unexpected error %v", err)
				}
				if result == nil {
					t.Fatal("expected a result")
				}
				return
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error = %v, want it to wrap %v", err, tc.wantErr)
			}
			var matrixErr *application.MatrixError
			if !errors.As(err, &matrixErr) {
				t.Fatalf("error = %T, want a *application.MatrixError", err)
			}
			if !strings.Contains(matrixErr.Reason, tc.wantReason) {
				t.Errorf("reason = %q, want it to contain %q", matrixErr.Reason, tc.wantReason)
			}
		})
	}
}

func TestExecuteRejectsNonFiniteValues(t *testing.T) {
	t.Parallel()

	// NaN and the infinities cannot be spelled in JSON, but they can reach the
	// use case from an in-process caller, and the guard must hold regardless of
	// which adapter is on top.
	cases := []struct {
		name string
		rows [][]float64
	}{
		{name: "NaN", rows: [][]float64{{1, 2}, {3, math.NaN()}}},
		{name: "positive infinity", rows: [][]float64{{1, 2}, {3, math.Inf(1)}}},
		{name: "negative infinity", rows: [][]float64{{1, 2}, {3, math.Inf(-1)}}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			uc := newUseCase(allowing(), 100)
			_, err := uc.Execute(context.Background(), application.FactorizeRequest{
				Token: "a.b.c",
				Rows:  tc.rows,
			})
			if !errors.Is(err, application.ErrInvalidMatrix) {
				t.Fatalf("error = %v, want ErrInvalidMatrix", err)
			}
			var matrixErr *application.MatrixError
			if errors.As(err, &matrixErr) && !strings.Contains(matrixErr.Reason, "not a finite number") {
				t.Errorf("reason = %q, want it to mention a non-finite value", matrixErr.Reason)
			}
		})
	}
}

// TestExecuteWithoutAValidatorDocumentsTheOptionalPort makes the optional
// validator explicit: a service deployed without auth still factorizes, which
// is what keeps the unit tests of the use case free of any HTTP stub.
func TestExecuteWithoutAValidatorDocumentsTheOptionalPort(t *testing.T) {
	t.Parallel()

	uc := &application.FactorizeUseCase{
		Factorizer:   application.HouseholderFactorizer{},
		MaxMatrixDim: 100,
	}
	result, err := uc.Execute(context.Background(), application.FactorizeRequest{
		Token: "a.b.c",
		Rows:  [][]float64{{1, 2}, {3, 4}},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(result.Q) != 2 || len(result.R) != 2 {
		t.Fatalf("unexpected shapes: Q %d, R %d", len(result.Q), len(result.R))
	}
}

// TestHouseholderFactorizerSatisfiesThePort keeps the adapter honest: if the
// domain function stops satisfying the port, this fails at compile time.
func TestHouseholderFactorizerSatisfiesThePort(t *testing.T) {
	t.Parallel()

	var factorizer application.Factorizer = application.HouseholderFactorizer{}
	m, err := qr.FromRows([][]float64{{1, 2}, {3, 4}})
	if err != nil {
		t.Fatalf("FromRows: %v", err)
	}
	if _, err := factorizer.Factorize(m); err != nil {
		t.Fatalf("Factorize: %v", err)
	}
}
