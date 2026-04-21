import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface Variant {
  name: string;
  instruction: string;
}

export interface ABExperiment {
  id: string;
  name: string;
  variants: Variant[];
  created_at: number;
  active: number;
}

export interface ABAssignment {
  experiment_id: string;
  variant_name: string;
  instruction: string;
}

export class ABTesting {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ab_experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        variants TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS ab_assignments (
        session_id TEXT NOT NULL,
        experiment_id TEXT NOT NULL,
        variant_name TEXT NOT NULL,
        assigned_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, experiment_id)
      );
    `);
  }

  createExperiment(name: string, variants: Variant[]): ABExperiment {
    if (variants.length < 2) throw new Error('Need at least 2 variants');
    const id = randomUUID();
    const exp: ABExperiment = { id, name, variants, created_at: Date.now(), active: 1 };
    this.db.prepare(
      `INSERT INTO ab_experiments (id, name, variants, created_at, active) VALUES (?, ?, ?, ?, 1)`
    ).run(id, name, JSON.stringify(variants), exp.created_at);
    return exp;
  }

  assign(sessionId: string, experimentName: string): ABAssignment | null {
    const row = this.db.prepare(
      `SELECT * FROM ab_experiments WHERE name = ? AND active = 1`
    ).get(experimentName) as { id: string; variants: string } | undefined;
    if (!row) return null;

    const variants: Variant[] = JSON.parse(row.variants);

    // Check existing assignment
    const existing = this.db.prepare(
      `SELECT variant_name FROM ab_assignments WHERE session_id = ? AND experiment_id = ?`
    ).get(sessionId, row.id) as { variant_name: string } | undefined;

    const variantName = existing?.variant_name
      ?? variants[Math.floor(Math.random() * variants.length)].name;

    if (!existing) {
      this.db.prepare(
        `INSERT INTO ab_assignments (session_id, experiment_id, variant_name, assigned_at) VALUES (?, ?, ?, ?)`
      ).run(sessionId, row.id, variantName, Date.now());
    }

    const variant = variants.find(v => v.name === variantName)!;
    return { experiment_id: row.id, variant_name: variantName, instruction: variant.instruction };
  }

  listExperiments(): ABExperiment[] {
    const rows = this.db.prepare(`SELECT * FROM ab_experiments ORDER BY created_at DESC`).all() as
      Array<{ id: string; name: string; variants: string; created_at: number; active: number }>;
    return rows.map(r => ({ ...r, variants: JSON.parse(r.variants) as Variant[] }));
  }

  deactivate(name: string): void {
    this.db.prepare(`UPDATE ab_experiments SET active = 0 WHERE name = ?`).run(name);
  }
}
