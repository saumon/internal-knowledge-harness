// Pattern-based secret redaction, shared by kb-state.mjs (Notion pages) and server.mjs (your notes).

// Safety net behind kb-sync's own redaction: catches key-shaped strings Claude missed.
const R = '[REDACTED]';
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,           // OpenAI / Anthropic
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,           // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_\w{30,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                   // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                             // AWS access key
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                        // Google
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,          // JWT
  /(?<![\/#\w-])[a-f0-9]{32,}(?![\w-])/gi,             // bare hex keys (not Notion ids in URLs)
];
// `password: x`, `DB_PASSWORD=x`, `**mdp** = x`, ... keeps the label, hides the value. "projet secret :" is a title, not a secret.
const LABELLED = /((?<!projets? )(?<![A-Za-z])(?:password|passwd|pwd|mdp|mot de passe|passphrase|secret|client[_ -]?secret|api[_ -]?key|apikey|access[_ -]?key|secret[_ -]?key|master[_ -]?key|(?:access[_ -]?|auth[_ -]?)?token)\b\**\s*[:=]\s*\**`?)(?!\[REDACTED\])([^\s|,;`]+)/gi;
const CONN_STRING = /(\b[a-z][a-z0-9+]*:\/\/[^\s:@\/]+:)([^\s@\/]+)(@)/gi; // scheme://user:pass@host
const URL_PARAM = /([?&](?:session_code|code|token|access_token|refresh_token|id_token|api_?key|key|secret|password|sig|signature)=)(?!\[REDACTED\])[^&\s)"'>]+/gi;

export function redactText(text) {
  let n = 0;
  const lines = text.split('\n').map((line) => {
    if (/^notion_id:/.test(line)) return line;
    for (const re of SECRET_PATTERNS) line = line.replace(re, () => (n++, R));
    line = line.replace(LABELLED, (_, label) => (n++, label + R));
    line = line.replace(CONN_STRING, (_, a, __, c) => (n++, a + R + c));
    line = line.replace(URL_PARAM, (_, a) => (n++, a + R));
    return line;
  });
  return { text: lines.join('\n'), count: n };
}
