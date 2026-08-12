import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  EnvironmentRepository,
  ProjectEnvironment,
  ProjectEnvironmentDetail,
  ProjectEnvironmentRevision,
  ProjectEnvironmentRevisionStatus
} from "../domain.js";

type EnvironmentRow = {
  id: string;
  name: string;
  current_revision_id: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

type RepositoryRow = {
  id: string;
  project_environment_id: string;
  name: string;
  git_url: string;
  prepare_command: string | null;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  id: string;
  project_environment_id: string;
  status: ProjectEnvironmentRevisionStatus;
  workspace_path: string | null;
  input_fingerprint: string;
  failure_stage: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

const toEnvironment = (row: EnvironmentRow): ProjectEnvironment => ({
  id: row.id,
  name: row.name,
  currentRevisionId: row.current_revision_id,
  lastCheckedAt: row.last_checked_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toRepository = (row: RepositoryRow): EnvironmentRepository => ({
  id: row.id,
  projectEnvironmentId: row.project_environment_id,
  name: row.name,
  gitUrl: row.git_url,
  prepareCommand: row.prepare_command,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toRevision = (row: RevisionRow): ProjectEnvironmentRevision => ({
  id: row.id,
  projectEnvironmentId: row.project_environment_id,
  status: row.status,
  workspacePath: row.workspace_path,
  inputFingerprint: row.input_fingerprint,
  failureStage: row.failure_stage,
  error: row.error,
  createdAt: row.created_at,
  finishedAt: row.finished_at
});

export type CreateEnvironmentRepositoryInput = {
  name: string;
  gitUrl: string;
  prepareCommand: string | null;
};

export type BeginRevisionInput = {
  projectEnvironmentId: string;
  configurationFingerprint: string;
  inputFingerprint: string;
  workspacePath: string;
  id?: string;
};

/** Stores project-environment configuration and revision state transitions. */
export class ProjectEnvironmentStore {
  constructor(private readonly dependencies: { db: Database.Database }) {}

  private get db(): Database.Database {
    return this.dependencies.db;
  }

  create(input: { name: string }): ProjectEnvironment {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO project_environments (id, name, current_revision_id, last_checked_at, created_at, updated_at)
      VALUES (?, ?, NULL, NULL, ?, ?)
    `).run(id, input.name, now, now);
    return toEnvironment(this.environmentRow(id)!);
  }

  update(id: string, input: { name: string }): ProjectEnvironment | undefined {
    this.assertMutable(id);
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE project_environments SET name = ?, updated_at = ? WHERE id = ?")
      .run(input.name, now, id);
    return result.changes === 0 ? undefined : toEnvironment(this.environmentRow(id)!);
  }

  list(): ProjectEnvironmentDetail[] {
    const rows = this.db.prepare("SELECT * FROM project_environments ORDER BY created_at ASC, id ASC").all() as EnvironmentRow[];
    return rows.map((row) => this.detail(toEnvironment(row)));
  }

  get(id: string): ProjectEnvironmentDetail | undefined {
    const row = this.environmentRow(id);
    return row === undefined ? undefined : this.detail(toEnvironment(row));
  }

  addRepository(projectEnvironmentId: string, input: CreateEnvironmentRepositoryInput): EnvironmentRepository {
    this.assertMutable(projectEnvironmentId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO environment_repositories
        (id, project_environment_id, name, git_url, prepare_command, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectEnvironmentId, input.name, input.gitUrl, input.prepareCommand, now, now);
    return toRepository(this.repositoryRow(id)!);
  }

  updateRepository(
    projectEnvironmentId: string,
    id: string,
    input: Partial<CreateEnvironmentRepositoryInput>
  ): EnvironmentRepository | undefined {
    this.assertMutable(projectEnvironmentId);
    const existing = this.repositoryRow(id);
    if (existing === undefined || existing.project_environment_id !== projectEnvironmentId) return undefined;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE environment_repositories
      SET name = ?, git_url = ?, prepare_command = ?, updated_at = ?
      WHERE id = ? AND project_environment_id = ?
    `).run(
      input.name ?? existing.name,
      input.gitUrl ?? existing.git_url,
      input.prepareCommand === undefined ? existing.prepare_command : input.prepareCommand,
      now,
      id,
      projectEnvironmentId
    );
    return toRepository(this.repositoryRow(id)!);
  }

  removeRepository(projectEnvironmentId: string, id: string): boolean {
    this.assertMutable(projectEnvironmentId);
    return this.db.prepare("DELETE FROM environment_repositories WHERE id = ? AND project_environment_id = ?")
      .run(id, projectEnvironmentId).changes === 1;
  }

  listRepositories(projectEnvironmentId: string): EnvironmentRepository[] {
    const rows = this.db.prepare(`
      SELECT * FROM environment_repositories
      WHERE project_environment_id = ? ORDER BY name ASC, id ASC
    `).all(projectEnvironmentId) as RepositoryRow[];
    return rows.map(toRepository);
  }

  configurationFingerprint(projectEnvironmentId: string): string {
    const values = this.listRepositories(projectEnvironmentId).map(({ name, gitUrl, prepareCommand }) => ({
      name,
      gitUrl,
      prepareCommand
    }));
    return createHash("sha256").update(JSON.stringify(values)).digest("hex");
  }

  beginRevision(input: BeginRevisionInput): ProjectEnvironmentRevision {
    return this.immediateTransaction(() => {
      if (this.configurationFingerprint(input.projectEnvironmentId) !== input.configurationFingerprint) {
        throw new Error("stale_environment_input");
      }
      const active = this.db.prepare(`
        SELECT id FROM project_environment_revisions
        WHERE project_environment_id = ? AND status = 'preparing'
      `).get(input.projectEnvironmentId);
      if (active !== undefined) throw new Error("environment_busy");

      const id = input.id ?? randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO project_environment_revisions
          (id, project_environment_id, status, workspace_path, input_fingerprint, failure_stage, error, created_at, finished_at)
        VALUES (?, ?, 'preparing', ?, ?, NULL, NULL, ?, NULL)
      `).run(id, input.projectEnvironmentId, input.workspacePath, input.inputFingerprint, now);
      return toRevision(this.revisionRow(id)!);
    });
  }

  publishRevision(id: string): ProjectEnvironmentRevision {
    return this.immediateTransaction(() => {
      const row = this.revisionRow(id);
      if (row === undefined || row.status !== "preparing") throw new Error("invalid_revision_state");
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE project_environment_revisions
        SET status = 'ready', failure_stage = NULL, error = NULL, finished_at = ? WHERE id = ?
      `).run(now, id);
      this.db.prepare(`
        UPDATE project_environments SET current_revision_id = ?, updated_at = ? WHERE id = ?
      `).run(id, now, row.project_environment_id);
      return toRevision(this.revisionRow(id)!);
    });
  }

  failRevision(id: string, failureStage: string, error: string): ProjectEnvironmentRevision {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE project_environment_revisions
      SET status = 'failed', failure_stage = ?, error = ?, finished_at = ?
      WHERE id = ? AND status = 'preparing'
    `).run(failureStage, error, now, id);
    if (result.changes !== 1) throw new Error("invalid_revision_state");
    return toRevision(this.revisionRow(id)!);
  }

  recoverPreparing(): ProjectEnvironmentRevision[] {
    const rows = this.db.prepare("SELECT id FROM project_environment_revisions WHERE status = 'preparing'")
      .all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.failRevision(id, "interrupted", "Project environment build was interrupted"));
  }

  getRevision(id: string): ProjectEnvironmentRevision | undefined {
    const row = this.revisionRow(id);
    return row === undefined ? undefined : toRevision(row);
  }

  getCurrentRevision(projectEnvironmentId: string): ProjectEnvironmentRevision | undefined {
    const environment = this.environmentRow(projectEnvironmentId);
    if (environment?.current_revision_id === null || environment === undefined) return undefined;
    return this.getRevision(environment.current_revision_id);
  }

  listRevisions(projectEnvironmentId: string): ProjectEnvironmentRevision[] {
    const rows = this.db.prepare(`
      SELECT * FROM project_environment_revisions
      WHERE project_environment_id = ? ORDER BY created_at DESC, id DESC
    `).all(projectEnvironmentId) as RevisionRow[];
    return rows.map(toRevision);
  }

  markChecked(projectEnvironmentId: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE project_environments SET last_checked_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, projectEnvironmentId);
  }

  clearRevisionWorkspacePath(id: string): void {
    this.db.prepare("UPDATE project_environment_revisions SET workspace_path = NULL WHERE id = ?").run(id);
  }

  private assertMutable(projectEnvironmentId: string): void {
    const preparing = this.db.prepare(`
      SELECT 1 FROM project_environment_revisions
      WHERE project_environment_id = ? AND status = 'preparing'
    `).get(projectEnvironmentId);
    if (preparing !== undefined) throw new Error("environment_busy");
  }

  private environmentRow(id: string): EnvironmentRow | undefined {
    return this.db.prepare("SELECT * FROM project_environments WHERE id = ?").get(id) as EnvironmentRow | undefined;
  }

  private repositoryRow(id: string): RepositoryRow | undefined {
    return this.db.prepare("SELECT * FROM environment_repositories WHERE id = ?").get(id) as RepositoryRow | undefined;
  }

  private revisionRow(id: string): RevisionRow | undefined {
    return this.db.prepare("SELECT * FROM project_environment_revisions WHERE id = ?").get(id) as RevisionRow | undefined;
  }

  private detail(environment: ProjectEnvironment): ProjectEnvironmentDetail {
    const revisions = this.listRevisions(environment.id);
    return {
      ...environment,
      repositories: this.listRepositories(environment.id),
      currentRevision: environment.currentRevisionId === null ? null : this.getRevision(environment.currentRevisionId) ?? null,
      latestRevision: revisions[0] ?? null
    };
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
