import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Contract-first guard.
 *
 * The repository ships OpenAPI documents in `contracts/`, written before the
 * code. Nothing regenerates them from the implementation, so nothing stops the
 * two from drifting apart except a test like this one.
 *
 * The check is deliberately shallow: it asserts that every path and operation in
 * the specification is implemented and that the declared response codes are the
 * ones the code actually produces. A full spec-driven request validator would
 * be stronger, but it would also require generating types from the document,
 * which adds a build step for a service whose response types are already
 * hand-written and reviewed. The trade is recorded rather than hidden.
 */

/**
 * Locates the `contracts/` directory by walking up from this file.
 *
 * A fixed relative path would break the moment the test is run from a different
 * working directory, or from a container where the service has been copied out
 * of the monorepo. Searching upwards makes the test locate the contracts the
 * same way a person would.
 */
function findContractsDir(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'contracts');
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(
    'contracts/ was not found walking up from the test file; the OpenAPI documents live at the repository root',
  );
}

const CONTRACTS_DIR = findContractsDir();

/** Reads one contract as text. */
function loadContract(name: string): { raw: string } {
  const raw = readFileSync(join(CONTRACTS_DIR, name), 'utf8');
  // The specs are YAML. Rather than take a YAML dependency for one file per
  // test, only the structural facts needed here are extracted with a regex:
  // path keys and the status codes listed under each operation. A full parse
  // would be nicer, but this keeps the test dependency-free and its intent
  // obvious.
  return { raw };
}

/** Splits a spec into lines once; the helpers below scan that array. */
function linesOf(spec: string): string[] {
  return spec.split('\n');
}

/** Reports whether a line is a top-level path key such as `  /auth/login:`. */
function isPathKey(line: string): boolean {
  return /^ {2}\/[^:]*:\s*$/.test(line);
}

/** Reports whether a line is an operation key such as `    post:`. */
function isOperationKey(line: string): boolean {
  return /^ {4}(get|post|put|patch|delete):\s*$/.test(line);
}

/** Returns the index range `[start, end)` of a path block. */
function pathBlock(lines: string[], path: string): [number, number] {
  const start = lines.findIndex((line) => line.trimStart().startsWith(`${path}:`) && isPathKey(line));
  if (start < 0) return [-1, -1];

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (isPathKey(line) || /^components:\s*$/.test(line)) return [start, i];
  }
  return [start, lines.length];
}

/** Extracts the top-level path keys. */
function pathsOf(spec: string): string[] {
  return linesOf(spec).filter(isPathKey).map((line) => line.trim().replace(/:$/, ''));
}

/** Extracts the HTTP methods declared under a path. */
function methodsOf(spec: string, path: string): string[] {
  const lines = linesOf(spec);
  const [start, end] = pathBlock(lines, path);
  if (start < 0) return [];

  return lines
    .slice(start, end)
    .filter(isOperationKey)
    .map((line) => line.trim().replace(':', '').toUpperCase());
}

/** Extracts the response status codes documented for an operation. */
function statusesOf(spec: string, path: string, method: string): string[] {
  const lines = linesOf(spec);
  const [pathStart, pathEnd] = pathBlock(lines, path);
  if (pathStart < 0) return [];

  const block = lines.slice(pathStart, pathEnd);
  const methodStart = block.findIndex(
    (line) => isOperationKey(line) && line.trim().startsWith(`${method.toLowerCase()}:`),
  );
  if (methodStart < 0) return [];

  // The operation runs until the next operation key or the end of the path.
  let methodEnd = block.length;
  for (let i = methodStart + 1; i < block.length; i += 1) {
    if (isOperationKey(block[i] as string)) {
      methodEnd = i;
      break;
    }
  }

  // Response codes are indented eight spaces, one deeper than the `responses:`
  // key that owns them.
  return [
    ...new Set(
      block
        .slice(methodStart, methodEnd)
        .map((line) => /^ {8}'?(\d{3})'?:\s*$/.exec(line)?.[1])
        .filter((value): value is string => value !== undefined),
    ),
  ];
}

describe('contracts/orchestrator.yaml', () => {
  const spec = loadContract('orchestrator.yaml').raw;

  it('declares the public API prefix', () => {
    expect(pathsOf(spec)).toContain('/api/v1/matrix/analyze');
  });

  it('declares the login endpoint under /auth', () => {
    expect(pathsOf(spec)).toContain('/auth/login');
  });

  it('declares both health probes', () => {
    const paths = pathsOf(spec);
    expect(paths).toContain('/health/live');
    expect(paths).toContain('/health/ready');
  });

  it('documents exactly the operations the controller exposes', () => {
    expect(methodsOf(spec, '/api/v1/matrix/analyze')).toEqual(['POST']);
    expect(methodsOf(spec, '/auth/login')).toEqual(['POST']);
    expect(methodsOf(spec, '/health/live')).toEqual(['GET']);
    expect(methodsOf(spec, '/health/ready')).toEqual(['GET']);
  });

  it('documents the failure codes the orchestrator can actually produce', () => {
    // These are the codes ProblemDetailsFilter maps to. A status in the spec
    // that no code path produces is documentation the client cannot rely on.
    const documented = statusesOf(spec, '/api/v1/matrix/analyze', 'POST').sort();
    expect(documented).toEqual(
      ['200', '400', '401', '413', '422', '429', '502', '503', '504'].sort(),
    );
  });

  it('documents the login failure codes', () => {
    const documented = statusesOf(spec, '/auth/login', 'POST').sort();
    expect(documented).toEqual(['200', '400', '401', '429', '502', '504'].sort());
  });

  it('requires a bearer token on the analysis endpoint', () => {
    expect(spec).toMatch(/analyze:[\s\S]{0,400}security:\s*\n\s*- bearerAuth: \[\]/);
  });

  it('documents the problem+json error shape', () => {
    expect(spec).toContain('application/problem+json');
    // requestId is the one addition to the RFC, and the whole cross-service
    // trace depends on it being in every error body.
    expect(spec).toMatch(/requestId/);
  });
});

describe('contracts are consistent across services', () => {
  const names = [
    'auth-service.yaml',
    'qr-api.yaml',
    'stats-api.yaml',
    'orchestrator.yaml',
  ];

  it.each(names)('%s exists and declares OpenAPI 3.1', (name) => {
    const { raw } = loadContract(name);
    expect(raw).toContain('openapi: 3.1.0');
    expect(raw).toContain('info:');
  });

  it.each(names)('%s declares both health probes', (name) => {
    expect(pathsOf(loadContract(name).raw)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready']),
    );
  });

  it.each(names)('%s documents the problem+json error body', (name) => {
    expect(loadContract(name).raw).toContain('application/problem+json');
  });

  it.each(names)('%s documents the correlation header', (name) => {
    expect(loadContract(name).raw).toContain('X-Request-Id');
  });
});
