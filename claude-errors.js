const failure = (message, code, status, resetAt = null) =>
  Object.assign(new Error(message), { code, status, resetAt });

export const describeClaudeFailure = (payload, stderr = '') => {
  const text = typeof payload === 'string' ? payload : String(payload?.result || payload?.error?.message
    || (Array.isArray(payload?.errors) ? payload.errors.join(' ') : '') || stderr);
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (/hit your (?:session |weekly |usage )?limit|usage limit|session limit|weekly limit|quota exceeded|out of extra usage/i.test(clean)) {
    const resetAt = clean.match(/resets?(?:\s+at)?\s+([^\n]+)/i)?.[1]?.trim().slice(0, 140) || null;
    return failure(`Alcanzaste el límite de uso de Claude. ${resetAt
      ? `Reinicio informado por Claude: ${resetAt}.`
      : 'Volvé a intentar cuando se renueve tu cuota.'} Esta consulta no pudo completarse.`,
    'claude_usage_limit', 429, resetAt);
  }
  if (/credit balance|insufficient (?:credits|balance)|out of credits/i.test(clean)) {
    return failure('Claude no tiene saldo disponible. Revisá los créditos de tu cuenta antes de reintentar.',
      'claude_insufficient_credits', 402);
  }
  if (payload?.api_error_status === 429 || /rate.?limit|too many requests/i.test(clean)) {
    return failure('Claude recibió demasiadas solicitudes. Esperá unos minutos y volvé a intentar.',
      'claude_rate_limit', 429);
  }
  if (payload?.api_error_status === 401 || /not logged in|authentication failed|invalid api key/i.test(clean)) {
    return failure('La sesión de Claude no está disponible. Iniciá sesión en Claude Code y volvé a intentar.',
      'claude_auth_required', 401);
  }
  // Never expose CLI envelopes, diagnostics or session identifiers to the interface.
  return failure('Claude no pudo completar la solicitud. Volvé a intentar; si persiste, revisá su conexión o sesión.',
    'claude_request_failed', 502);
};

export const parseClaudeResponse = (stdout, stderr = '', exitCode = 0, timedOut = false) => {
  if (timedOut) {
    throw failure('Claude tardó demasiado y la consulta se detuvo. Podés volver a intentar.', 'claude_timeout', 504);
  }
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw describeClaudeFailure(`${stdout}\n${stderr}`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw describeClaudeFailure('');
  if (payload.is_error || String(payload.subtype || '').startsWith('error')
    || payload.api_error_status >= 400 || exitCode !== 0) throw describeClaudeFailure(payload, stderr);
  return { text: String(payload.result || '').trim(), denials: payload.permission_denials || [] };
};
