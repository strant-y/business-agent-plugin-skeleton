const SECRET_PATTERNS = [
  /((?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*["']?)[^\s"',;]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/-]+/gi,
  /(sk-[A-Za-z0-9_-]+)/g,
  /([A-Fa-f0-9]{32,})/g,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, (_match, prefix?: string) => `${prefix ?? ''}[REDACTED]`),
    text,
  );
}
