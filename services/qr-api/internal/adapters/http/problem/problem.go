// Package problem implements RFC 9457 Problem Details for all error responses.
//
// Every service in this monorepo returns errors in the same shape so that a
// client (the Expo app, or curl) can handle failures uniformly without knowing
// which backend produced them. The only field beyond the RFC is requestId,
// which lets a user-visible error be traced back to a single log line.
package problem

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
)

// MediaType is the content type mandated by the RFC.
const MediaType = "application/problem+json"

// TypeBase is the URI prefix under which every problem type lives. Using a
// stable, dereferenceable base is what makes `type` useful to a client: it
// can switch on the last segment instead of parsing `detail`.
const TypeBase = "https://interseguro.local/problems/"

// Category is the machine-readable last segment of `type`.
type Category string

// The categories this system emits. They are stable strings: changing one is
// an API change.
const (
	// CategoryInvalidMatrix covers structurally invalid matrices.
	CategoryInvalidMatrix Category = "invalid-matrix"
	// CategoryMalformedRequest covers unparseable bodies.
	CategoryMalformedRequest Category = "malformed-request"
	// CategoryUnauthorized covers missing or rejected credentials.
	CategoryUnauthorized Category = "unauthorized"
	// CategoryPayloadTooLarge covers body and dimension limit violations.
	CategoryPayloadTooLarge Category = "payload-too-large"
	// CategoryServiceUnavailable covers a dependency being unreachable.
	CategoryServiceUnavailable Category = "service-unavailable"
	// CategoryRateLimited covers throttling.
	CategoryRateLimited Category = "rate-limited"
	// CategoryBadGateway and CategoryGatewayTimeout cover a downstream reply.
	CategoryBadGateway     Category = "bad-gateway"
	CategoryGatewayTimeout Category = "gateway-timeout"
	// CategoryInternal covers anything unanticipated.
	CategoryInternal Category = "internal-error"
)

// Detail is an RFC 9457 problem document plus the correlation id.
type Detail struct {
	// Type is the URI identifying the problem category.
	Type string `json:"type"`
	// Title is a short, human-readable summary of the category.
	Title string `json:"title"`
	// Status is the HTTP status code, duplicated in the body on purpose so a
	// client that only reads the payload still sees it.
	Status int `json:"status"`
	// Detail explains what specifically went wrong. It must never contain a
	// stack trace, an internal host name or any secret.
	Detail string `json:"detail"`
	// Instance is the path of the request that produced the error.
	Instance string `json:"instance"`
	// RequestID correlates the response with the server logs.
	RequestID string `json:"requestId"`
}

// Response pairs a problem document with the headers it must be sent with.
type Response struct {
	// Detail is the body to serialize.
	Detail Detail
	// Headers holds optional extra headers, e.g. Retry-After or WWW-Authenticate.
	Headers map[string]string
}

// New builds a problem document for the given category, status, detail text
// and instance path.
func New(status int, category Category, title, detail, instance, requestID string) Response {
	return Response{
		Detail: Detail{
			Type:      TypeBase + string(category),
			Title:     title,
			Status:    status,
			Detail:    detail,
			Instance:  instance,
			RequestID: requestID,
		},
	}
}

// Write serializes the problem as the response body with the right status and
// content type. It takes an http.ResponseWriter-like pair so it can be reused
// by any Node or Go service; in qr-api it is called with Fiber's
// ctx.Response().SetBodyRaw and a manual status.
func Write(w http.ResponseWriter, resp Response) {
	// Headers are written before the body because Go sends them with the first
	// Write call.
	for k, v := range resp.Headers {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", MediaType)
	w.WriteHeader(resp.Detail.Status)

	// NewEncoder is used instead of json.Marshal so a Detail string containing
	// invalid UTF-8 is replaced rather than causing Marshal to fail; a failed
	// error response would be the worst possible outcome.
	_ = json.NewEncoder(w).Encode(resp.Detail)
}

// Encode renders the problem document as JSON bytes, for adapters that buffer
// the response themselves.
func (r Response) Encode() ([]byte, error) {
	return json.Marshal(r.Detail)
}

// RedactToken returns a short, non-reversible fingerprint of a token, safe to
// put in logs. It is a truncated SHA-256 digest: enough to correlate two log
// lines about the same token, useless for recovering the token itself.
func RedactToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])[:12]
}
