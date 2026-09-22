/** Page-shaped management fixtures for existing interaction tests. */
export const pagedManagementResponse = (request: string, body: unknown, status = 200): Response => {
  const url = new URL(request, "http://localhost");
  let value = body;
  if (status < 400 && url.searchParams.has("page")) {
    const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const key = ["availableModels", "revisions", "files"].find(key => Array.isArray(record[key]));
    let items: unknown[] | undefined = Array.isArray(body) ? body : key ? record[key] as unknown[] : undefined;
    if (items !== undefined) {
      const metadata = {...record}; if (key) delete metadata[key];
      const query = url.searchParams.get("query")?.toLowerCase() ?? "";
      items = items.filter(item => JSON.stringify(item).toLowerCase().includes(query));
      if (url.searchParams.get("ready") === "true") items = items.filter(item => (item as {currentRevisionId: unknown}).currentRevisionId !== null);
      if (url.searchParams.get("enabled") === "true") items = items.filter(item => (item as {enabled: boolean}).enabled);
      if (url.searchParams.has("agentId")) items = items.filter(item => String((item as {agentId: unknown}).agentId) === url.searchParams.get("agentId"));
      if (url.pathname.endsWith("/skills")) items.sort((a, b) => Number((b as {enabled: boolean}).enabled) - Number((a as {enabled: boolean}).enabled));
      const page = Number(url.searchParams.get("page")), pageSize = Number(url.searchParams.get("pageSize") ?? 20);
      value = {...metadata, items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length, totalPages: Math.ceil(items.length / pageSize)};
    }
  }
  return new Response(JSON.stringify(value), {status, headers: {"content-type": "application/json"}});
};
