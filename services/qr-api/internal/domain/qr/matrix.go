// Package qr contains the pure, framework-free numerical core of the service:
// the Matrix type and the Householder QR factorization.
//
// Nothing in this package performs I/O, depends on Fiber, or reads
// configuration. That keeps the algorithm trivially testable and lets the
// application layer depend on a stable, boring interface.
package qr

import (
	"errors"
	"fmt"
	"math"
)

// ErrNonFinite is returned when a matrix contains NaN or an infinity.
// Such values have no meaningful QR factorization and would silently poison
// every downstream computation, so they are rejected at the boundary.
var ErrNonFinite = errors.New("matrix contains a non-finite value")

// Matrix is a dense, row-major matrix of float64 values stored as a single
// slice. Using a flat backing array avoids a per-row allocation and keeps the
// Householder inner loops contiguous in memory.
//
// The zero value is not usable; construct one with NewMatrix.
type Matrix struct {
	// rows is the number of rows.
	rows int
	// cols is the number of columns.
	cols int
	// data holds rows*cols values in row-major order.
	data []float64
}

// NewMatrix builds a Matrix from a copy of values, which must be laid out in
// row-major order and have exactly rows*cols elements.
//
// The slice is copied so the caller can reuse its backing array safely.
func NewMatrix(rows, cols int, values []float64) (*Matrix, error) {
	if rows <= 0 || cols <= 0 {
		return nil, fmt.Errorf("matrix dimensions must be positive, got %dx%d", rows, cols)
	}
	if len(values) != rows*cols {
		return nil, fmt.Errorf("expected %d values for a %dx%d matrix, got %d", rows*cols, rows, cols, len(values))
	}
	data := make([]float64, len(values))
	copy(data, values)
	return &Matrix{rows: rows, cols: cols, data: data}, nil
}

// FromRows builds a Matrix from a slice of rows, inferring the column count
// from the first row. All rows must share the same length.
func FromRows(rows [][]float64) (*Matrix, error) {
	if len(rows) == 0 {
		return nil, errors.New("matrix must have at least one row")
	}
	cols := len(rows[0])
	if cols == 0 {
		return nil, errors.New("matrix must have at least one column")
	}
	flat := make([]float64, 0, len(rows)*cols)
	for i, row := range rows {
		if len(row) != cols {
			return nil, fmt.Errorf("row %d has length %d, expected %d", i, len(row), cols)
		}
		flat = append(flat, row...)
	}
	return NewMatrix(len(rows), cols, flat)
}

// Rows returns the number of rows.
func (m *Matrix) Rows() int { return m.rows }

// Cols returns the number of columns.
func (m *Matrix) Cols() int { return m.cols }

// At returns the element at (i, j). It panics when the coordinates fall
// outside the matrix, mirroring the behaviour of the standard library slices.
func (m *Matrix) At(i, j int) float64 {
	if i < 0 || i >= m.rows || j < 0 || j >= m.cols {
		panic(fmt.Sprintf("index (%d,%d) out of range for %dx%d matrix", i, j, m.rows, m.cols))
	}
	return m.data[i*m.cols+j]
}

// Set writes v at (i, j), panicking when the coordinates are out of range.
func (m *Matrix) Set(i, j int, v float64) {
	if i < 0 || i >= m.rows || j < 0 || j >= m.cols {
		panic(fmt.Sprintf("index (%d,%d) out of range for %dx%d matrix", i, j, m.rows, m.cols))
	}
	m.data[i*m.cols+j] = v
}

// Clone returns a deep copy, so callers can mutate the result freely.
func (m *Matrix) Clone() *Matrix {
	data := make([]float64, len(m.data))
	copy(data, m.data)
	return &Matrix{rows: m.rows, cols: m.cols, data: data}
}

// ToRows returns the matrix as a fresh slice of slices, ready to be
// serialized as JSON.
func (m *Matrix) ToRows() [][]float64 {
	out := make([][]float64, m.rows)
	for i := range out {
		out[i] = make([]float64, m.cols)
		copy(out[i], m.data[i*m.cols:(i+1)*m.cols])
	}
	return out
}

// IsFinite reports whether every element is a finite number.
func (m *Matrix) IsFinite() bool {
	for _, v := range m.data {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}

// Mul computes the matrix product m * other.
//
// A full product is only used in tests and diagnostics, never on the request
// path, so clarity is preferred over a blocked/strassen implementation here.
func (m *Matrix) Mul(other *Matrix) (*Matrix, error) {
	if m.cols != other.rows {
		return nil, fmt.Errorf("cannot multiply %dx%d by %dx%d", m.rows, m.cols, other.rows, other.cols)
	}
	out := make([]float64, m.rows*other.cols)
	for i := 0; i < m.rows; i++ {
		for j := 0; j < other.cols; j++ {
			var sum float64
			for k := 0; k < m.cols; k++ {
				sum += m.data[i*m.cols+k] * other.data[k*other.cols+j]
			}
			out[i*other.cols+j] = sum
		}
	}
	return &Matrix{rows: m.rows, cols: other.cols, data: out}, nil
}

// Transpose returns the transpose of m.
func (m *Matrix) Transpose() *Matrix {
	out := make([]float64, len(m.data))
	for i := 0; i < m.rows; i++ {
		for j := 0; j < m.cols; j++ {
			out[j*m.rows+i] = m.data[i*m.cols+j]
		}
	}
	return &Matrix{rows: m.cols, cols: m.rows, data: out}
}

// Subtract returns m - other. The two matrices must have the same shape.
func (m *Matrix) Subtract(other *Matrix) (*Matrix, error) {
	if m.rows != other.rows || m.cols != other.cols {
		return nil, fmt.Errorf("cannot subtract %dx%d from %dx%d", other.rows, other.cols, m.rows, m.cols)
	}
	out := make([]float64, len(m.data))
	for i := range out {
		out[i] = m.data[i] - other.data[i]
	}
	return &Matrix{rows: m.rows, cols: m.cols, data: out}, nil
}

// Identity returns the n x n identity matrix.
func Identity(n int) *Matrix {
	out := make([]float64, n*n)
	for i := 0; i < n; i++ {
		out[i*n+i] = 1
	}
	return &Matrix{rows: n, cols: n, data: out}
}

// FrobeniusNorm returns sqrt(sum of squares of every element). It is the
// residual measure used throughout the tests: ||QR - A||_F.
func (m *Matrix) FrobeniusNorm() float64 {
	var sum float64
	for _, v := range m.data {
		sum += v * v
	}
	return math.Sqrt(sum)
}
