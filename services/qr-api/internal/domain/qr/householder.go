package qr

import "math"

// Factorization holds the full QR factorization of a matrix A (m x n):
//
//	A = Q * R
//
// Q is m x m and orthogonal (Q^T * Q = I); R is m x n and upper triangular,
// meaning every entry below the main diagonal is exactly zero.
//
// We return the full factorization rather than the "thin"/reduced one because
// the challenge asks for a rectangular input to be factorized as-is, and the
// reduced form is ambiguous for wide matrices (m < n) where Q would be
// m x m anyway and R is m x n. Keeping both factors at their natural sizes
// also makes the reconstruction identity testable for every shape.
type Factorization struct {
	// Q is the orthogonal factor, m x m.
	Q *Matrix
	// R is the upper triangular factor, m x n.
	R *Matrix
}

// sign returns 1 for x >= 0 and -1 for x < 0, matching LAPACK's dsign
// convention. Returning 1 for exactly zero is what produces a negative
// leading diagonal entry in R for matrices whose first pivot is zero.
func sign(x float64) float64 {
	if x < 0 {
		return -1
	}
	return 1
}

// Householder computes the full QR factorization of m using Householder
// reflections.
//
// # Why Householder and not Gram-Schmidt
//
// Modified Gram-Schmidt is simpler to write but numerically unstable: it
// loses orthogonality roughly like O(n * eps) and blows up on ill-conditioned
// or near-dependent columns, which is exactly the input a QR endpoint is
// expected to receive. Householder reflectors are orthogonal by construction,
// so the computed Q stays orthogonal to machine precision for any input, at
// the cost of roughly 2x the flops. Cost is O(m * n^2).
//
// # Sign convention
//
// The diagonal of R is left exactly as LAPACK leaves it: the reflector is
// built as alpha = -sign(x0) * ||x||, which guarantees no cancellation while
// forming v[0] - alpha, but means R[k][k] is negative whenever the leading
// element of the column is positive. The factorization is equally valid with
// the opposite signs; we do not "fix" it, because doing so would break the
// exactness of the zeros we write below the diagonal and would deviate from
// every numerical library a reviewer might compare against. See ADR-003.
//
// The algorithm works for any shape, including tall (m > n), square (m == n)
// and wide (m < n) matrices. For wide matrices the first n columns of Q are
// the orthonormal basis produced by the reflectors and the remaining m - n
// columns complete it to a full basis, since R still has rank at most n.
func Householder(m *Matrix) (*Factorization, error) {
	if m == nil {
		return nil, errNilMatrix
	}
	if !m.IsFinite() {
		return nil, ErrNonFinite
	}
	if m.rows == 0 || m.cols == 0 {
		return nil, errEmptyMatrix
	}

	// Work on a copy: the caller's matrix must not be mutated.
	a := m.Clone()
	steps := min(a.rows, a.cols)

	// q accumulates the product of reflectors H_0 * ... * H_{steps-1},
	// starting from the identity, and ends up as the orthogonal factor.
	q := Identity(a.rows)
	// v is reused across iterations to avoid allocating in the inner loop.
	v := make([]float64, a.rows)
	// w is the scratch vector for the inner products. It must hold up to
	// max(rows, cols) entries because the R update runs over all columns while
	// the Q update runs over all rows of the current block.
	w := make([]float64, max(a.rows, a.cols))
	// u holds the intermediate product Q * v while Q is being updated. It must
	// be read in full before any column is written, so it cannot alias Q.
	u := make([]float64, a.rows)

	// Note on indexing: a column of a row-major matrix is strided by `cols`, not
	// contiguous, so every access below goes through data[i*cols + j] rather
	// than a slice of a column. The update loops walk j innermost, which keeps
	// each row's cache line in play for the whole inner iteration.
	for k := 0; k < steps; k++ {
		// n is the height of the active block A[k:, k:]; v is supported on rows
		// k..rows-1 and stored compactly in v[0..n-1].
		n := a.rows - k
		stride := a.cols

		// Scale the column slice by its largest magnitude before measuring it.
		// Without this, entries near the top of the float64 range would overflow
		// in the sum of squares and yield NaN for a perfectly finite input.
		scale := 0.0
		for i := 0; i < n; i++ {
			if av := math.Abs(a.data[(k+i)*stride+k]); av > scale {
				scale = av
			}
		}
		if scale == 0 {
			// A[k:, k] is already zero, so the reflector would be the identity.
			// Skipping the step keeps R's lower triangle exactly zero and leaves
			// Q untouched, instead of dividing by a zero norm.
			continue
		}

		// The scaled values live only in v. Writing them back into A would rescale
		// column k while leaving every other column untouched, so the reflector
		// would no longer act on a consistent matrix.
		var sumSquares float64
		for i := 0; i < n; i++ {
			scaled := a.data[(k+i)*stride+k] / scale
			v[i] = scaled
			sumSquares += scaled * scaled
		}
		norm := math.Sqrt(sumSquares)
		alpha := -sign(v[0]) * norm

		// v = x - alpha * e1, normalized to unit length. Choosing alpha with the
		// opposite sign to v[0] is what prevents catastrophic cancellation here.
		v[0] -= alpha
		var vSumSquares float64
		for i := 0; i < n; i++ {
			vSumSquares += v[i] * v[i]
		}
		vNorm := math.Sqrt(vSumSquares)
		if vNorm == 0 {
			continue
		}
		for i := 0; i < n; i++ {
			v[i] /= vNorm
		}

		// A[k:, k:] -= 2 * v * (v^T * A[k:, k:])
		for j := 0; j < a.cols; j++ {
			var dot float64
			for i := 0; i < n; i++ {
				dot += v[i] * a.data[(k+i)*stride+j]
			}
			w[j] = dot
		}
		for j := k; j < a.cols; j++ {
			factor := 2 * w[j]
			for i := 0; i < n; i++ {
				a.data[(k+i)*stride+j] -= factor * v[i]
			}
		}

		// Write exactly what LAPACK writes: alpha on the diagonal, hard zeros
		// below it. Rounding noise in the lower triangle would otherwise leak
		// into the statistics response and break the "R is triangular" check.
		a.data[k*stride+k] = alpha * scale
		for i := 1; i < n; i++ {
			a.data[(k+i)*stride+k] = 0
		}

		// Accumulate q = q * H_k. Since R = H_{p-1} ... H_0 * A and every
		// reflector is symmetric and orthogonal, A = (H_0 H_1 ... H_{p-1}) R, so
		// Q is built by successive RIGHT multiplication:
		//
		//	Q H = Q (I - 2 v v^T) = Q - 2 (Q v) v^T
		//
		// The intermediate product is Q v, not v^T Q. Columns of Q outside the
		// support of v are left alone because v_j = 0 there.
		for i := 0; i < q.rows; i++ {
			row := q.data[i*q.cols+k:]
			var dot float64
			for r := 0; r < n; r++ {
				dot += row[r] * v[r]
			}
			u[i] = dot
		}
		for r := 0; r < n; r++ {
			col := k + r
			factor := 2 * v[r]
			for i := 0; i < q.rows; i++ {
				q.data[i*q.cols+col] -= u[i] * factor
			}
		}
	}

	return &Factorization{
		Q: q,
		R: &Matrix{rows: a.rows, cols: a.cols, data: a.data},
	}, nil
}
