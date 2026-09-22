import { z } from "zod";
import type { Page } from "./domain.js";

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().trim().max(200).optional()
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const isPagedQuery = (query: unknown): boolean => typeof query === "object" && query !== null
  && ("page" in query || "pageSize" in query);

export const pageResult = <T>(items: T[], total: number, page: Pick<PaginationQuery, "page" | "pageSize">): Page<T> => ({
  items, page: page.page, pageSize: page.pageSize, total, totalPages: Math.ceil(total / page.pageSize)
});
