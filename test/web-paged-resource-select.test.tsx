// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { I18nProvider } from "../src/web/i18n.js";
import { PagedResourceSelect } from "../src/web/components/paged-resource-select.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
it("fetches one page at a time and keeps a selection across pages and search", async () => {
  sessionStorage.setItem("apiToken", "test-token");
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost"); requests.push(url);
    const page = Number(url.searchParams.get("page"));
    return new Response(JSON.stringify({ items: [{ id: page, name: `Agent ${page}` }], page, pageSize: 20, total: 40, totalPages: 2 }), { status: 200 });
  }));
  const Test = () => {
    const [value, setValue] = useState("");
    return <I18nProvider><PagedResourceSelect<{ id: number; name: string }> endpoint="/agents?enabled=true" value={value} onValueChange={setValue} getOption={(item) => ({ value: String(item.id), label: item.name })} ariaLabel="Agent" /></I18nProvider>;
  };
  render(<Test />);
  await screen.findByRole("option", { name: "Agent 1" });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.searchParams.get("pageSize")).toBe("20");
  expect(requests[0]!.searchParams.get("enabled")).toBe("true");
  fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("option", { name: "Agent 2" });
  expect(screen.getByLabelText("Agent")).toHaveValue("1");
  expect(screen.getByRole("option", { name: "Agent 1" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索 Agent"), { target: { value: "needle" } });
  await waitFor(() => expect(requests.at(-1)!.searchParams.get("query")).toBe("needle"));
  expect(requests.at(-1)!.searchParams.get("page")).toBe("1");
});
