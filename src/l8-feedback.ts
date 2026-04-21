import Database from 'better-sqlite3';

export type Rating = 'good' | 'bad' | 'partial';

export interface FeedbackRecord {
  request_id: string;
  rating: Rating;
  rule_suspected?: string;
  notes?: string;
}

export interface RuleStats {
  rule_name: string;
  evaluations: number;
  wins_good: number;
  wins_bad: number;
  wins_partial: number;
  enabled: number;
  auto_disabled_at: number | null;
  win_rate: number;
}

export class FeedbackLoop {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        rating TEXT NOT NULL,
        rule_suspected TEXT,
        notes TEXT,
        ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rule_stats (
        rule_name TEXT PRIMARY KEY,
        evaluations INTEGER DEFAULT 0,
        wins_good INTEGER DEFAULT 0,
        wins_bad INTEGER DEFAULT 0,
        wins_partial INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        auto_disabled_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_rule ON feedback(rule_suspected);
      CREATE INDEX IF NOT EXISTS idx_feedback_request ON feedback(request_id);
    `);
  }

  recordFeedback(record: FeedbackRecord): void {
    this.db.prepare(`
      INSERT INTO feedback (request_id, rating, rule_suspected, notes, ts)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      record.request_id,
      record.rating,
      record.rule_suspected ?? null,
      record.notes ?? null,
      Date.now(),
    );

    if (record.rule_suspected) {
      this.updateRuleStats(record.rule_suspected, record.rating);
    }
  }

  private updateRuleStats(ruleName: string, rating: Rating): void {
    // Upsert rule_stats
    this.db.prepare(`
      INSERT INTO rule_stats (rule_name, evaluations, wins_good, wins_bad, wins_partial)
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(rule_name) DO UPDATE SET
        evaluations = evaluations + 1,
        wins_good = wins_good + excluded.wins_good,
        wins_bad = wins_bad + excluded.wins_bad,
        wins_partial = wins_partial + excluded.wins_partial
    `).run(
      ruleName,
      rating === 'good' ? 1 : 0,
      rating === 'bad' ? 1 : 0,
      rating === 'partial' ? 1 : 0,
    );

    // Auto-disable if bad rate > 40% with at least 5 evaluations
    const stats = this.getRuleStats(ruleName);
    if (stats && stats.evaluations >= 5 && stats.enabled === 1) {
      const badRate = stats.wins_bad / stats.evaluations;
      if (badRate > 0.4) {
        this.db.prepare(`
          UPDATE rule_stats SET enabled = 0, auto_disabled_at = ? WHERE rule_name = ?
        `).run(Date.now(), ruleName);
      }
    }
  }

  getRuleStats(ruleName: string): RuleStats | undefined {
    const row = this.db.prepare(`SELECT * FROM rule_stats WHERE rule_name = ?`).get(ruleName) as RuleStats | undefined;
    if (!row) return undefined;
    return {
      ...row,
      win_rate: row.evaluations > 0 ? row.wins_good / row.evaluations : 0,
    };
  }

  getAllRuleStats(): RuleStats[] {
    const rows = this.db.prepare(`SELECT * FROM rule_stats ORDER BY evaluations DESC`).all() as RuleStats[];
    return rows.map((r) => ({
      ...r,
      win_rate: r.evaluations > 0 ? r.wins_good / r.evaluations : 0,
    }));
  }

  getDisabledRules(): string[] {
    const rows = this.db.prepare(`SELECT rule_name FROM rule_stats WHERE enabled = 0`).all() as { rule_name: string }[];
    return rows.map((r) => r.rule_name);
  }

  enableRule(ruleName: string): void {
    this.db.prepare(`UPDATE rule_stats SET enabled = 1, auto_disabled_at = NULL WHERE rule_name = ?`).run(ruleName);
  }

  formatRuleReport(): string {
    const rules = this.getAllRuleStats();
    if (rules.length === 0) return '## Rule Stats\n\nNo feedback recorded yet.';

    const lines = [
      '## Rule Stats',
      '',
      '| Rule | Evals | Good | Bad | Partial | Win Rate | Status |',
      '|---|---|---|---|---|---|---|',
    ];

    for (const r of rules) {
      const status = r.enabled ? '✅ Active' : '🚫 Disabled';
      lines.push(
        `| \`${r.rule_name}\` | ${r.evaluations} | ${r.wins_good} | ${r.wins_bad} | ${r.wins_partial} | ${(r.win_rate * 100).toFixed(0)}% | ${status} |`,
      );
    }

    return lines.join('\n');
  }
}
