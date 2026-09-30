package qr

import "errors"

var (
	// errNilMatrix guards against a programming error at the adapter boundary:
	// a nil matrix is never a valid input, so it must never reach the algorithm.
	errNilMatrix = errors.New("matrix must not be nil")
	// errEmptyMatrix guards the zero-dimensional case, which has no factorization.
	errEmptyMatrix = errors.New("matrix must have at least one row and one column")
)
