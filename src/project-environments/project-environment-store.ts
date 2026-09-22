import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import { pageResult, type PaginationQuery } from "../pagination.js";
import { insertedId } from "../db.js";

import type {
  EnvironmentRepository,
  ProjectEnvironment,
  ProjectEnvironmentDetail,
  ProjectEnvironmentRevision,
  ProjectEnvironmentRevisionStatus
} from "../domain.js";

type EnvironmentRow = {
  id: number;
  name: string;
  current_revision_id: number | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

type RepositoryRow = {
  id: number;
  project_environment_id: number;
  name: string;
  git_url: string;
  prepare_command: string | null;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  id: number;
  project_environment_id: number;
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
  projectEnvironmentId: number;
  configurationFingerprint: string;
  inputFingerprint: string;
};

/** Stores project-environment configuration and revision state transitions. */
export class ProjectEnvironmentStore {
  constructor(private readonly dependencies: { db: Database.Database }) {}

  private get db(): Database.Database {
    return this.dependencies.db;
  }

  create(input: { name: string }): ProjectEnvironment {
    const now = new Date().toISOString();
    const id = insertedId(this.db.prepare(`
      INSERT INTO project_environments (name, current_revision_id, last_checked_at, created_at, updated_at)
      VALUES (?, NULL, NULL, ?, ?)
    `).run(input.name, now, now));
    return toEnvironment(this.environmentRow(id)!);
  }

  update(id: number, input: { name: string }): ProjectEnvironment | undefined {
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

  listPage(pagination: PaginationQuery & { ready?: boolean }) {
    const where = `instr(lower(name), lower(?)) > 0${pagination.ready ? " AND EXISTS (SELECT 1 FROM project_environment_revisions r WHERE r.id = project_environments.current_revision_id AND r.status = 'ready' AND r.workspace_path IS NOT NULL)" : ""}`;
    const total = (this.db.prepare(`SELECT count(*) AS total FROM project_environments WHERE ${where}`).get(pagination.query ?? "") as { total: number }).total;
    const rows = this.db.prepare(`SELECT * FROM project_environments WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
      .all(pagination.query ?? "", pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as EnvironmentRow[];
    return pageResult(rows.map((row) => this.summary(toEnvironment(row))), total, pagination);
  }

  getSummary(id: number) {
    const row = this.environmentRow(id);
    return row === undefined ? undefined : this.summary(toEnvironment(row));
  }

  listRepositoriesPage(id: number, pagination: PaginationQuery) {
    const where = "project_environment_id = ? AND instr(lower(name), lower(?)) > 0";
    const total = (this.db.prepare(`SELECT count(*) AS total FROM environment_repositories WHERE ${where}`).get(id, pagination.query ?? "") as { total: number }).total;
    const rows = this.db.prepare(`SELECT * FROM environment_repositories WHERE ${where} ORDER BY name ASC, id ASC LIMIT ? OFFSET ?`)
      .all(id, pagination.query ?? "", pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as RepositoryRow[];
    return pageResult(rows.map(toRepository), total, pagination);
  }

  listRevisionsPage(id: number, pagination: PaginationQuery) {
    const where = "project_environment_id = ? AND (instr(lower(status), lower(?)) > 0 OR instr(CAST(id AS TEXT), ?) > 0)";
    const query = pagination.query ?? "";
    const total = (this.db.prepare(`SELECT count(*) AS total FROM project_environment_revisions WHERE ${where}`).get(id, query, query) as { total: number }).total;
    const rows = this.db.prepare(`SELECT * FROM project_environment_revisions WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(id, query, query, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as RevisionRow[];
    return pageResult(rows.map(toRevision), total, pagination);
  }

  private summary(environment: ProjectEnvironment) {
    const latest = this.db.prepare("SELECT * FROM project_environment_revisions WHERE project_environment_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(environment.id) as RevisionRow | undefined;
    const repositoryCount = (this.db.prepare("SELECT count(*) AS total FROM environment_repositories WHERE project_environment_id = ?").get(environment.id) as { total: number }).total;
    return { ...environment, repositoryCount,
      currentRevision: environment.currentRevisionId === null ? null : this.getRevision(environment.currentRevisionId) ?? null,
      latestRevision: latest === undefined ? null : toRevision(latest) };
  }

  get(id: number): ProjectEnvironmentDetail | undefined {
    const row = this.environmentRow(id);
    return row === undefined ? undefined : this.detail(toEnvironment(row));
  }

  addRepository(projectEnvironmentId: number, input: CreateEnvironmentRepositoryInput): EnvironmentRepository {
    this.assertMutable(projectEnvironmentId);
    const now = new Date().toISOString();
    const id = insertedId(this.db.prepare(`
      INSERT INTO environment_repositories
        (project_environment_id, name, git_url, prepare_command, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectEnvironmentId, input.name, input.gitUrl, input.prepareCommand, now, now));
    return toRepository(this.repositoryRow(id)!);
  }

  updateRepository(
    projectEnvironmentId: number,
    id: number,
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

  removeRepository(projectEnvironmentId: number, id: number): boolean {
    this.assertMutable(projectEnvironmentId);
    return this.db.prepare("DELETE FROM environment_repositories WHERE id = ? AND project_environment_id = ?")
      .run(id, projectEnvironmentId).changes === 1;
  }

  listRepositories(projectEnvironmentId: number): EnvironmentRepository[] {
    const rows = this.db.prepare(`
      SELECT * FROM environment_repositories
      WHERE project_environment_id = ? ORDER BY name ASC, id ASC
    `).all(projectEnvironmentId) as RepositoryRow[];
    return rows.map(toRepository);
  }

  configurationFingerprint(projectEnvironmentId: number): string {
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

      const now = new Date().toISOString();
      const id = insertedId(this.db.prepare(`
        INSERT INTO project_environment_revisions
          (project_environment_id, status, workspace_path, input_fingerprint, failure_stage, error, created_at, finished_at)
        VALUES (?, 'preparing', NULL, ?, NULL, NULL, ?, NULL)
      `).run(input.projectEnvironmentId, input.inputFingerprint, now));
      return toRevision(this.revisionRow(id)!);
    });
  }

  setRevisionWorkspacePath(id: number, workspacePath: string): void {
    this.db.prepare("UPDATE project_environment_revisions SET workspace_path = ? WHERE id = ?")
      .run(workspacePath, id);
  }

  publishRevision(id: number): ProjectEnvironmentRevision {
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

  failRevision(id: number, failureStage: string, error: string): ProjectEnvironmentRevision {
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
      .all() as Array<{ id: number }>;
    return rows.map(({ id }) => this.failRevision(id, "interrupted", "Project environment build was interrupted"));
  }

  getRevision(id: number): ProjectEnvironmentRevision | undefined {
    const row = this.revisionRow(id);
    return row === undefined ? undefined : toRevision(row);
  }

  getCurrentRevision(projectEnvironmentId: number): ProjectEnvironmentRevision | undefined {
    const environment = this.environmentRow(projectEnvironmentId);
    if (environment?.current_revision_id === null || environment === undefined) return undefined;
    return this.getRevision(environment.current_revision_id);
  }

  listRevisions(projectEnvironmentId: number): ProjectEnvironmentRevision[] {
    const rows = this.db.prepare(`
      SELECT * FROM project_environment_revisions
      WHERE project_environment_id = ? ORDER BY created_at DESC, id DESC
    `).all(projectEnvironmentId) as RevisionRow[];
    return rows.map(toRevision);
  }

  markChecked(projectEnvironmentId: number): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE project_environments SET last_checked_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, projectEnvironmentId);
  }

  clearRevisionWorkspacePath(id: number): void {
    this.db.prepare("UPDATE project_environment_revisions SET workspace_path = NULL WHERE id = ?").run(id);
  }

  isRevisionSnapshotPending(id: number): boolean {
    return this.db.prepare(`
      SELECT 1 FROM sessions
      WHERE project_environment_revision_id = ? AND workspace_path LIKE 'pending:%'
      LIMIT 1
    `).get(id) !== undefined;
  }

  private assertMutable(projectEnvironmentId: number): void {
    const preparing = this.db.prepare(`
      SELECT 1 FROM project_environment_revisions
      WHERE project_environment_id = ? AND status = 'preparing'
    `).get(projectEnvironmentId);
    if (preparing !== undefined) throw new Error("environment_busy");
  }

  private environmentRow(id: number): EnvironmentRow | undefined {
    return this.db.prepare("SELECT * FROM project_environments WHERE id = ?").get(id) as EnvironmentRow | undefined;
  }

  private repositoryRow(id: number): RepositoryRow | undefined {
    return this.db.prepare("SELECT * FROM environment_repositories WHERE id = ?").get(id) as RepositoryRow | undefined;
  }

  private revisionRow(id: number): RevisionRow | undefined {
    return this.db.prepare("SELECT * FROM project_environment_revisions WHERE id = ?").get(id) as RevisionRow | undefined;
  }

  private detail(environment: ProjectEnvironment): ProjectEnvironmentDetail {
    const summary = this.summary(environment);
    return {
      ...environment,
      repositories: this.listRepositories(environment.id),
      currentRevision: environment.currentRevisionId === null ? null : this.getRevision(environment.currentRevisionId) ?? null,
      latestRevision: summary.latestRevision
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
