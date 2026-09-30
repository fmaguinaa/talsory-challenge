package httpadapters

import (
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/interseguro/qr-api/internal/adapters/http/problem"
	"github.com/interseguro/qr-api/internal/application"
)

// factorizeRequest is the wire shape of POST /api/v1/qr/factorize, matching
// contracts/qr-api.yaml.
//
// Matrix is declared as [][]any rather than [][]float64 on purpose: with
// [][]float64, encoding/json rejects a non-numeric entry with a generic
// "cannot unmarshal string into float64" and no position information. Decoding
// loosely and validating in the application layer lets us report exactly which
// row and column is wrong, which is the difference between a 422 a client can
// act on and a 400 it can only guess at.
type factorizeRequest struct {
	// Matrix is the raw, unvalidated matrix.
	Matrix [][]any `json:"matrix"`
}

// factorizeResponse is the wire shape of a successful factorization.
type factorizeResponse struct {
	// Q is the orthogonal factor, m x m.
	Q [][]float64 `json:"q"`
	// R is the upper triangular factor, m x n.
	R [][]float64 `json:"r"`
}

// matrixHandler serves the QR endpoint.
type matrixHandler struct {
	// useCase is the application entry point.
	useCase *application.FactorizeUseCase
}

// factorize implements POST /api/v1/qr/factorize.
//
// Order of work: parse the envelope, extract the bearer token, hand both to the
// use case. The use case authorizes before validating the matrix, so an
// unauthenticated caller cannot probe the validation rules.
func (h *matrixHandler) factorize(c *fiber.Ctx) error {
	var body factorizeRequest
	if err := c.BodyParser(&body); err != nil {
		// A body that is not even JSON is answered here rather than by the
		// error handler: the wording of a parse failure is JSON-parser specific
		// and not worth exposing, so the client gets the contract instead.
		return writeProblem(c, problem.New(
			fiber.StatusBadRequest,
			problem.CategoryMalformedRequest,
			"Malformed request body",
			`The request body is not valid JSON for this endpoint; expected {"matrix": [[...], ...]}.`,
			c.Path(),
			requestIDOf(c),
		))
	}

	rows, err := decodeMatrix(body.Matrix)
	if err != nil {
		return writeProblem(c, problem.New(
			fiber.StatusUnprocessableEntity,
			problem.CategoryInvalidMatrix,
			"Invalid matrix",
			err.Error(),
			c.Path(),
			requestIDOf(c),
		))
	}

	result, err := h.useCase.Execute(c.UserContext(), application.FactorizeRequest{
		Token: bearerToken(c.Get(fiber.HeaderAuthorization)),
		Rows:  rows,
	})
	if err != nil {
		// Returned as-is; errorHandler maps it to the right status.
		return err
	}

	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	return c.JSON(factorizeResponse{Q: result.Q, R: result.R})
}

// decodeMatrix converts the loosely typed JSON body into float64 rows.
//
// A JSON number decodes as float64, so any entry that is not a number (a
// string, null, an object) fails here with the offending position rather than
// producing a silent zero. The element type check is what turns a malformed
// value into a precise, actionable message.
func decodeMatrix(raw [][]any) ([][]float64, error) {
	if raw == nil {
		return nil, &application.MatrixError{
			Reason: `field "matrix" is required and must be an array of arrays of numbers`,
			Err:    application.ErrInvalidMatrix,
		}
	}
	rows := make([][]float64, len(raw))
	for i, row := range raw {
		if row == nil {
			return nil, &application.MatrixError{
				Reason: "row " + strconv.Itoa(i) + " is null; every row must be an array of numbers",
				Err:    application.ErrInvalidMatrix,
			}
		}
		out := make([]float64, len(row))
		for j, cell := range row {
			value, ok := cell.(float64)
			if !ok {
				return nil, &application.MatrixError{
					Reason: "value at row " + strconv.Itoa(i) + ", column " + strconv.Itoa(j) + " must be a number",
					Err:    application.ErrInvalidMatrix,
				}
			}
			out[j] = value
		}
		rows[i] = out
	}
	return rows, nil
}

// bearerToken extracts the token from an Authorization header value.
//
// It returns "" when the header is absent or does not use the Bearer scheme,
// which the use case turns into ErrInvalidToken. A malformed header must not be
// treated as a token: passing the raw string on would send the client a
// confusing introspection failure instead of a clear "missing credentials".
func bearerToken(header string) string {
	const prefix = "bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
