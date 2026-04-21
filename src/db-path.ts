import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the SQLite path used for session observability.
 *
 * Priority:
 *   1. CONDUIT_DB_PATH env-var (explicit opt-in, wins over default).
 *   2. ~/.claude-conduit/sessions.db (cross-platform default).
 *
 * The parent directory is not created here. Callers that open the
 * database (ObservabilityBus, dashboard) are responsible for
 * `mkdirSync(dirname(path), { recursive: true })` before use.
 */
export function resolveDbPath(): string {
  const env = process.env['CONDUIT_DB_PATH'];
  if (env && env.length > 0) return env;
  return join(homedir(), '.claude-conduit', 'sessions.db');
}

/**
 * Default directory for the conduit data folder under the user's home.
 * Used by CLI commands (`conduit init`, `conduit doctor`).
 */
export function defaultConduitDir(): string {
  return join(homedir(), '.claude-conduit');
}
