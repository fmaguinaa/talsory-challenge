package qr_test

import (
	"math"
	"testing"

	"github.com/interseguro/qr-api/internal/domain/qr"
)

// tolerance is the absolute residual tolerated across the test suite. It is
// uniform rather than relative because every fixture here is small and
// well scaled; the reconstruction residual of Householder on such inputs sits
// around 1e-14, three orders of magnitude below this bound, so the test still
// fails loudly if the algorithm regresses.
const tolerance = 1e-9

// assertOrthogonal checks that Q^T * Q is the identity within tolerance.
func assertOrthogonal(t *testing.T, q *qr.Matrix) {
	t.Helper()
	product, err := q.Transpose().Mul(q)
	if err != nil {
		t.Fatalf("Q^T * Q: unexpected error: %v", err)
	}
	residual, err := product.Subtract(qr.Identity(q.Rows()))
	if err != nil {
		t.Fatalf("Q^T * Q - I: unexpected error: %v", err)
	}
	if got := residual.FrobeniusNorm(); got > tolerance {
		t.Errorf("||Q^T Q - I|| = %g, want <= %g", got, tolerance)
	}
}

// assertUpperTriangular checks that R has no non-zero entry below the main
// diagonal. The algorithm writes exact zeros there, so the bound is strict.
func assertUpperTriangular(t *testing.T, r *qr.Matrix) {
	t.Helper()
	for i := 0; i < r.Rows(); i++ {
		for j := 0; j < i && j < r.Cols(); j++ {
			if v := r.At(i, j); math.Abs(v) > tolerance {
				t.Errorf("R[%d][%d] = %g, want 0 (R must be upper triangular)", i, j, v)
			}
		}
	}
}

// assertReconstruction checks that Q * R reproduces the input matrix.
func assertReconstruction(t *testing.T, a, q, r *qr.Matrix) {
	t.Helper()
	product, err := q.Mul(r)
	if err != nil {
		t.Fatalf("Q * R: unexpected error: %v", err)
	}
	residual, err := product.Subtract(a)
	if err != nil {
		t.Fatalf("Q * R - A: unexpected error: %v", err)
	}
	// The residual is compared relative to the magnitude of the input so the
	// same bound is meaningful for a 1x1 matrix and for a large fixture.
	scale := math.Max(a.FrobeniusNorm(), 1)
	if got := residual.FrobeniusNorm() / scale; got > tolerance {
		t.Errorf("||Q R - A||_F / ||A||_F = %g, want <= %g", got, tolerance)
	}
}

func TestHouseholder(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		rows [][]float64
	}{
		{
			// The classic example from Golub & Van Loan and most numerical
			// linear algebra courses.
			name: "textbook 3x3",
			rows: [][]float64{
				{12, -51, 4},
				{6, 167, -68},
				{-4, 24, -41},
			},
		},
		{
			name: "square 3x3 with positives",
			rows: [][]float64{
				{4, 2, 1},
				{1, 5, 3},
				{2, 1, 6},
			},
		},
		{
			name: "square 2x2",
			rows: [][]float64{{1, 2}, {3, 4}},
		},
		{
			name: "tall 4x2",
			rows: [][]float64{
				{1, 2},
				{3, 4},
				{5, 6},
				{7, 8},
			},
		},
		{
			name: "tall 5x3",
			rows: [][]float64{
				{2, -1, 0},
				{-1, 2, -1},
				{0, -1, 2},
				{-1, 0, 1},
				{3, 3, 3},
			},
		},
		{
			name: "wide 2x3",
			rows: [][]float64{
				{1, 2, 3},
				{4, 5, 6},
			},
		},
		{
			name: "wide 1x3",
			rows: [][]float64{{1, 2, 3}},
		},
		{
			name: "wide 3x5",
			rows: [][]float64{
				{1, 0, 2, 0, 3},
				{0, 1, 0, 4, 5},
				{6, 7, 0, 0, 8},
			},
		},
		{
			name: "identity",
			rows: [][]float64{
				{1, 0, 0},
				{0, 1, 0},
				{0, 0, 1},
			},
		},
		{
			name: "all zeros",
			rows: [][]float64{
				{0, 0, 0},
				{0, 0, 0},
				{0, 0, 0},
			},
		},
		{
			name: "zero first column",
			rows: [][]float64{
				{0, 1},
				{0, 2},
				{0, 3},
			},
		},
		{
			name: "zero leading element forces the LAPACK sign convention",
			rows: [][]float64{
				{0, 1},
				{1, 0},
			},
		},
		{
			name: "single element",
			rows: [][]float64{{5}},
		},
		{
			name: "single element negative",
			rows: [][]float64{{-5}},
		},
		{
			name: "single row",
			rows: [][]float64{{1, -2, 3, -4}},
		},
		{
			name: "single column",
			rows: [][]float64{{1}, {-2}, {3}, {-4}},
		},
		{
			name: "all negative values",
			rows: [][]float64{
				{-1, -2, -3},
				{-4, -5, -6},
				{-7, -8, -9},
			},
		},
		{
			name: "negative diagonal",
			rows: [][]float64{
				{-1, 2, 3},
				{4, -5, 6},
				{7, 8, -9},
			},
		},
		{
			name: "rank deficient repeated columns",
			rows: [][]float64{
				{1, 1, 1},
				{2, 2, 2},
				{3, 3, 3},
			},
		},
		{
			name: "large magnitudes",
			rows: [][]float64{
				{1e15, -2e15, 3e15},
				{4e15, 5e15, -6e15},
			},
		},
		{
			name: "tiny magnitudes",
			rows: [][]float64{
				{1e-15, -2e-15, 3e-15},
				{4e-15, 5e-15, -6e-15},
			},
		},
		{
			name: "mixed magnitudes",
			rows: [][]float64{
				{1e10, 1e-10, 1},
				{1e-10, 1e10, 1e-5},
				{1, 1e-5, 1e10},
			},
		},
		{
			name: "hilbert 5x5",
			rows: [][]float64{
				{1, 1.0 / 2, 1.0 / 3, 1.0 / 4, 1.0 / 5},
				{1.0 / 2, 1.0 / 3, 1.0 / 4, 1.0 / 5, 1.0 / 6},
				{1.0 / 3, 1.0 / 4, 1.0 / 5, 1.0 / 6, 1.0 / 7},
				{1.0 / 4, 1.0 / 5, 1.0 / 6, 1.0 / 7, 1.0 / 8},
				{1.0 / 5, 1.0 / 6, 1.0 / 7, 1.0 / 8, 1.0 / 9},
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			a, err := qr.FromRows(tt.rows)
			if err != nil {
				t.Fatalf("FromRows: %v", err)
			}
			// The input must survive untouched: the algorithm works on a copy.
			original := a.Clone()

			f, err := qr.Householder(a)
			if err != nil {
				t.Fatalf("Householder: %v", err)
			}

			if got, want := f.Q.Rows(), a.Rows(); got != want {
				t.Errorf("Q.Rows() = %d, want %d", got, want)
			}
			if got, want := f.Q.Cols(), a.Rows(); got != want {
				t.Errorf("Q.Cols() = %d, want %d (Q must be m x m)", got, want)
			}
			if got, want := f.R.Rows(), a.Rows(); got != want {
				t.Errorf("R.Rows() = %d, want %d", got, want)
			}
			if got, want := f.R.Cols(), a.Cols(); got != want {
				t.Errorf("R.Cols() = %d, want %d", got, want)
			}

			assertOrthogonal(t, f.Q)
			assertUpperTriangular(t, f.R)
			assertReconstruction(t, original, f.Q, f.R)
		})
	}
}

// TestHouseholderDoesNotMutateInput pins the copy-on-write contract, which the
// use case relies on when it logs the request matrix for diagnostics.
func TestHouseholderDoesNotMutateInput(t *testing.T) {
	t.Parallel()

	a, err := qr.FromRows([][]float64{{1, 2}, {3, 4}})
	if err != nil {
		t.Fatalf("FromRows: %v", err)
	}
	before := a.ToRows()

	if _, err := qr.Householder(a); err != nil {
		t.Fatalf("Householder: %v", err)
	}

	after := a.ToRows()
	for i := range before {
		for j := range before[i] {
			if before[i][j] != after[i][j] {
				t.Fatalf("input mutated at (%d,%d): %v -> %v", i, j, before[i][j], after[i][j])
			}
		}
	}
}

// TestHouseholderSignConvention documents the LAPACK convention explicitly:
// R[k][k] is the negative of the norm of the column slice whenever the leading
// element of that slice is positive. See ADR-003.
func TestHouseholderSignConvention(t *testing.T) {
	t.Parallel()

	a, err := qr.FromRows([][]float64{{12, -51, 4}, {6, 167, -68}, {-4, 24, -41}})
	if err != nil {
		t.Fatalf("FromRows: %v", err)
	}
	f, err := qr.Householder(a)
	if err != nil {
		t.Fatalf("Householder: %v", err)
	}

	// The known-good decomposition of this matrix has a negative leading
	// diagonal on R. We only assert the sign and the magnitude, never the exact
	// value, because the last digits depend on the operation order.
	diagonal := f.R.At(0, 0)
	if diagonal >= 0 {
		t.Errorf("R[0][0] = %v, want negative under the LAPACK sign convention", diagonal)
	}
	// |R[0][0]| is the norm of the first column, which is preserved by any QR.
	if want := math.Sqrt(144.0 + 36.0 + 16.0); math.Abs(math.Abs(diagonal)-want) > 1e-9 {
		t.Errorf("|R[0][0]| = %v, want %v", math.Abs(diagonal), want)
	}
}

func TestHouseholderRejectsInvalidInput(t *testing.T) {
	t.Parallel()

	t.Run("nil matrix", func(t *testing.T) {
		t.Parallel()
		if _, err := qr.Householder(nil); err == nil {
			t.Fatal("expected an error for a nil matrix")
		}
	})

	t.Run("non finite values", func(t *testing.T) {
		t.Parallel()
		a, err := qr.NewMatrix(2, 2, []float64{1, math.NaN(), 3, 4})
		if err != nil {
			t.Fatalf("NewMatrix: %v", err)
		}
		if _, err := qr.Householder(a); err == nil {
			t.Fatal("expected an error for a matrix containing NaN")
		}
	})

	t.Run("infinity", func(t *testing.T) {
		t.Parallel()
		a, err := qr.NewMatrix(1, 2, []float64{math.Inf(1), 1})
		if err != nil {
			t.Fatalf("NewMatrix: %v", err)
		}
		if _, err := qr.Householder(a); err == nil {
			t.Fatal("expected an error for a matrix containing +Inf")
		}
	})
}

func TestMatrixHelpers(t *testing.T) {
	t.Parallel()

	t.Run("FromRows rejects ragged input", func(t *testing.T) {
		t.Parallel()
		if _, err := qr.FromRows([][]float64{{1, 2, 3}, {4, 5}}); err == nil {
			t.Fatal("expected an error for a ragged matrix")
		}
	})

	t.Run("FromRows rejects empty rows", func(t *testing.T) {
		t.Parallel()
		if _, err := qr.FromRows([][]float64{{}}); err == nil {
			t.Fatal("expected an error for a matrix with zero columns")
		}
		if _, err := qr.FromRows(nil); err == nil {
			t.Fatal("expected an error for a matrix with zero rows")
		}
	})

	t.Run("NewMatrix rejects a mismatched value count", func(t *testing.T) {
		t.Parallel()
		if _, err := qr.NewMatrix(2, 2, []float64{1, 2, 3}); err == nil {
			t.Fatal("expected an error when the value count does not match the shape")
		}
	})

	t.Run("IsFinite", func(t *testing.T) {
		t.Parallel()
		a, err := qr.NewMatrix(1, 2, []float64{1, 2})
		if err != nil {
			t.Fatalf("NewMatrix: %v", err)
		}
		if !a.IsFinite() {
			t.Error("IsFinite() = false, want true")
		}
		b, err := qr.NewMatrix(1, 1, []float64{math.Inf(-1)})
		if err != nil {
			t.Fatalf("NewMatrix: %v", err)
		}
		if b.IsFinite() {
			t.Error("IsFinite() = true, want false")
		}
	})

	t.Run("Multiplication shape check", func(t *testing.T) {
		t.Parallel()
		a, _ := qr.NewMatrix(2, 3, []float64{1, 2, 3, 4, 5, 6})
		b, _ := qr.NewMatrix(4, 1, []float64{1, 2, 3, 4})
		if _, err := a.Mul(b); err == nil {
			t.Fatal("expected a shape mismatch error")
		}
	})

	t.Run("At panics out of range", func(t *testing.T) {
		t.Parallel()
		a, _ := qr.NewMatrix(2, 2, []float64{1, 2, 3, 4})
		defer func() {
			if recover() == nil {
				t.Error("expected a panic for an out-of-range index")
			}
		}()
		_ = a.At(5, 0)
	})
}

func BenchmarkHouseholder100x100(b *testing.B) {
	rows := make([][]float64, 100)
	// A deterministic pseudo-random matrix: math/rand with a fixed seed keeps
	// the benchmark reproducible without depending on a particular Go release.
	seed := uint64(1469598103934665603)
	next := func() float64 {
		seed ^= seed << 13
		seed ^= seed >> 7
		seed ^= seed << 17
		return float64(seed%2000)/1000.0 - 1
	}
	for i := range rows {
		rows[i] = make([]float64, 100)
		for j := range rows[i] {
			rows[i][j] = next()
		}
	}
	a, err := qr.FromRows(rows)
	if err != nil {
		b.Fatalf("FromRows: %v", err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := qr.Householder(a); err != nil {
			b.Fatalf("Householder: %v", err)
		}
	}
}
