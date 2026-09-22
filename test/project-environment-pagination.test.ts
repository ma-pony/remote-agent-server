import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectEnvironmentStore } from "../src/project-environments/project-environment-store.js";
import { registerProjectEnvironmentRoutes } from "../src/project-environments/project-environment-routes.js";
import { createTestDatabase } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it("pages environment summaries, repositories and build history without loading complete children", async () => {
  const { db } = createTestDatabase();
  const store = new ProjectEnvironmentStore({ db });
  const app = Fastify();
  registerProjectEnvironmentRoutes(app, store, { getState: () => ({ status: "idle" }), requestCheck: async () => undefined } as never);
  cleanups.push(async () => { await app.close(); db.close(); });
  const environment = store.create({ name: "Paged environment" });
  for (let index = 0; index < 3; index++) {
    store.addRepository(environment.id, { name: `repo-${index}`, gitUrl: "https://example.test/repo.git", prepareCommand: null });
    const revision = store.beginRevision({ projectEnvironmentId: environment.id, configurationFingerprint: store.configurationFingerprint(environment.id), inputFingerprint: String(index) });
    store.setRevisionWorkspacePath(revision.id, `/unused/${revision.id}`);
    store.publishRevision(revision.id);
  }
  const allRepositories = vi.spyOn(store, "listRepositories");
  const allRevisions = vi.spyOn(store, "listRevisions");
  const list = (await app.inject(`/project-environments?page=1&pageSize=1&query=Paged&ready=true`)).json();
  expect(list).toMatchObject({ page: 1, total: 1, items: [{ id: environment.id, repositoryCount: 3 }] });
  expect(list.items[0]).not.toHaveProperty("repositories");
  expect((await app.inject(`/project-environments/${environment.id}/summary`)).json()).toMatchObject({ repositoryCount: 3 });
  const repositories = (await app.inject(`/project-environments/${environment.id}/repositories?page=2&pageSize=2`)).json();
  expect(repositories).toMatchObject({ total: 3, items: [{ name: "repo-2" }] });
  const revisions = (await app.inject(`/project-environments/${environment.id}/revisions?page=2&pageSize=2`)).json();
  expect(revisions.total).toBe(3);
  expect(revisions.items).toHaveLength(1);
  expect(allRepositories).not.toHaveBeenCalled();
  expect(allRevisions).not.toHaveBeenCalled();
  expect((await app.inject(`/project-environments?page=1&pageSize=101`)).statusCode).toBe(400);
  expect((await app.inject(`/project-environments/999/revisions?page=1`)).statusCode).toBe(404);
  expect((await app.inject(`/project-environments`)).json()).toEqual(expect.any(Array));
  expect(allRevisions).not.toHaveBeenCalled();
});
