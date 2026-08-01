const SECRET_PATTERNS = [
    [/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
    [/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
    [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, "Bearer [REDACTED_TOKEN]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
    [/(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/gi, "$1=[REDACTED]"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
];
export function redactForRecall(value) {
    let result = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}
export function containsLikelySecret(value) {
    return redactForRecall(value) !== value;
}
export function automaticMemoryExclusion(value) {
    if (/\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s]+/.test(value)) {
        return "environment values are excluded from automatic curated memory";
    }
    const greeting = /^(?:hi|hello|dear)\s+[A-Z][\p{L}'-]*/imu.test(value);
    const outwardAsk = /\b(?:refer(?:ral| me)?|coffee chat|connect me|put me in touch|consider my application|hiring manager)\b/iu.test(value);
    if (greeting && outwardAsk) {
        return "user-facing outreach or application drafts are excluded from automatic curated memory";
    }
    if (/\b(?:we (?:worked|studied|collaborated)|our time (?:at|together)|you may remember me from)\b/iu.test(value)) {
        return "unverified relationship claims are excluded from automatic curated memory";
    }
    return null;
}
//# sourceMappingURL=redaction.js.map