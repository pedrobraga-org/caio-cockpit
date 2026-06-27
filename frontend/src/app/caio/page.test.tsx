import type React from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import CaioPage, { BookmarkSkipFields } from "./page";

const { customFetchMock, MockApiError } = vi.hoisted(() => {
  class MockApiError<TData = unknown> extends Error {
    status: number;
    data: TData | null;

    constructor(status: number, message: string, data: TData | null) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.data = data;
    }
  }

  return {
    customFetchMock: vi.fn(),
    MockApiError,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/caio",
  useRouter: () => ({
    replace: vi.fn(),
  }),
}));

vi.mock("next/link", () => {
  type LinkProps = React.PropsWithChildren<{
    href: string | { pathname?: string };
  }> &
    Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

  return {
    default: ({ href, children, ...props }: LinkProps) => (
      <a href={typeof href === "string" ? href : "#"} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock("@/auth/clerk", () => ({
  SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: () => null,
  useAuth: () => ({ isSignedIn: true }),
}));

vi.mock("@/api/mutator", () => ({
  customFetch: customFetchMock,
  ApiError: MockApiError,
}));

vi.mock("@/api/generated/default/default", () => ({
  useHealthzHealthzGet: () => ({ data: null, isError: false }),
}));

vi.mock("@/api/generated/users/users", () => ({
  useGetMeApiV1UsersMeGet: () => ({ data: null }),
}));

vi.mock("@/lib/use-organization-membership", () => ({
  useOrganizationMembership: () => ({ isAdmin: true }),
}));

vi.mock("@/components/templates/DashboardPageLayout", () => ({
  DashboardPageLayout: ({
    title,
    description,
    headerActions,
    children,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    headerActions?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <main>
      <header>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
        {headerActions}
      </header>
      {children}
    </main>
  ),
}));

const emptyThinkLoopResponse = {
  status: "ok",
  error_class: null,
  latency_ms: 4,
  items: [],
};

const fresh = {
  status: "fresh",
  observed_at: "2026-06-27T10:00:00Z",
  modified_at: "2026-06-27T09:00:00Z",
  age_seconds: 3600,
};

const basePayloadMetadata = {
  content_type: "text/markdown",
  size_bytes: 1024,
  sha256: "b".repeat(64),
  snippet_chars: 0,
  snippet_truncated: false,
  snippet_redacted: false,
  collection_count: null,
  recent_paths: [],
};

const brainOkResponse = {
  status: "ok",
  error_class: null,
  latency_ms: 18,
  contract: {
    contract_version: 1,
    runtime_truth: "local_runtime",
    icloud_source_of_truth_allowed: false,
    obsidian_source_of_truth_allowed: false,
    human_markdown_projection_role: "human_projection_cache",
    required_terms: ["BrainRead", "BrainWrite", "local-first"],
    critical_backup_areas: ["workspaces/caio-runtime/Braindump/"],
    backup_name_patterns: ["caio-brain-*"],
    allowlist_required_fields: ["path", "reason"],
    allowlist_date_format: "YYYY-MM-DD",
  },
  inventory: [
    {
      key: "BRAIN_RUNTIME.md",
      path: "BRAIN_RUNTIME.md",
      source: "runtime_contract",
      exists: true,
      error_class: null,
      freshness: fresh,
      payload_metadata: basePayloadMetadata,
    },
    {
      key: "memory/main.sqlite",
      path: "memory/main.sqlite",
      source: "sqlite_store",
      exists: true,
      error_class: null,
      freshness: fresh,
      payload_metadata: {
        ...basePayloadMetadata,
        content_type: "application/vnd.sqlite3",
        size_bytes: 4096,
      },
    },
    {
      key: "Braindump/*.md",
      path: "Braindump/",
      source: "markdown_projection",
      exists: true,
      error_class: null,
      freshness: fresh,
      payload_metadata: {
        ...basePayloadMetadata,
        collection_count: 2,
        recent_paths: [
          "Braindump/2026-06-27-super-long-brain-dump-filename-that-must-wrap.md",
          "Braindump/idea.md",
        ],
      },
    },
    {
      key: "contatos/*.md",
      path: "contatos/",
      source: "markdown_projection",
      exists: true,
      error_class: null,
      freshness: fresh,
      payload_metadata: {
        ...basePayloadMetadata,
        collection_count: 3,
        recent_paths: [
          "contatos/5511999999999@s.whatsapp.net.md",
          "contatos/Maria.md",
        ],
      },
    },
  ],
  reads: [
    {
      key: "memory/PEDRO_VIDA.md",
      source: "markdown_projection",
      provenance: {
        store: "caio-brain-runtime",
        key: "memory/PEDRO_VIDA.md",
        observed_at: "2026-06-27T10:00:00Z",
        path: "/Users/openclaw/.openclaw/workspaces/caio-runtime/memory/PEDRO_VIDA.md",
        confidence: 0.82,
      },
      freshness: fresh,
      payload_metadata: {
        ...basePayloadMetadata,
        snippet_chars: 46,
        snippet_truncated: false,
        snippet_redacted: false,
      },
      path: "memory/PEDRO_VIDA.md",
      snippet: "Projection snippet for the human-readable cache.",
    },
    {
      key: "memory/main.sqlite",
      source: "sqlite_store",
      provenance: {
        store: "caio-brain-runtime",
        key: "memory/main.sqlite",
        observed_at: "2026-06-27T10:00:00Z",
        path: "/Users/openclaw/.openclaw/workspaces/caio-runtime/memory/main.sqlite",
        confidence: null,
      },
      freshness: fresh,
      payload_metadata: {
        ...basePayloadMetadata,
        content_type: "application/vnd.sqlite3",
      },
      path: "memory/main.sqlite",
      snippet: null,
    },
    {
      key: "contatos/5511999999999@s.whatsapp.net.md",
      source: "markdown_projection",
      provenance: {
        store: "caio-brain-runtime",
        key: "contatos/5511999999999@s.whatsapp.net.md",
        observed_at: "2026-06-27T10:00:00Z",
        path: "/Users/openclaw/.openclaw/workspaces/caio-runtime/contatos/5511999999999@s.whatsapp.net.md",
        confidence: 0.7,
      },
      freshness: fresh,
      payload_metadata: {
        ...basePayloadMetadata,
        snippet_chars: 31,
      },
      path: "contatos/5511999999999@s.whatsapp.net.md",
      snippet: "Contact projection bounded snippet.",
    },
  ],
  audit: {
    status: "ok",
    available: true,
    exit_code: 0,
    error_class: null,
    script_path:
      "/Users/openclaw/.openclaw/workspaces/caio-runtime/tools-dev/brain-runtime-audit.sh",
    stdout: "BRAIN runtime OK",
    stderr: null,
  },
  limits: {
    snippet_max_chars: 600,
    collection_limit: 8,
    audit_output_max_chars: 2000,
  },
};

function mockCaioPageFetch(brainResponse: unknown = brainOkResponse) {
  customFetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/caio/think-loop/recent")) {
      return { data: emptyThinkLoopResponse };
    }
    if (url.startsWith("/api/v1/caio/brain/status")) {
      return { data: brainResponse };
    }
    throw new Error(`Unhandled URL in test: ${url}`);
  });
}

async function openBrainTab() {
  const user = userEvent.setup();
  render(<CaioPage />);
  await user.click(await screen.findByRole("tab", { name: "BRAIN" }));
  return user;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BookmarkSkipFields", () => {
  it("shows the complete long source URL with wrapping and title fallback", () => {
    const sourceUrl =
      "https://example.com/bookmarks/" +
      "very-long-path-segment-".repeat(12) +
      "?utm_source=" +
      "long-query-value-".repeat(10);

    render(
      <BookmarkSkipFields
        details={{
          sourceUrl,
          inferredProject: "caio-cockpit",
          estimatedComplexity: "low",
          discardReason: "Already handled.",
        }}
      />,
    );

    const sourceLink = screen.getByRole("link", { name: sourceUrl });

    expect(sourceLink).toHaveTextContent(sourceUrl);
    expect(sourceLink).toHaveAttribute("href", sourceUrl);
    expect(sourceLink).toHaveAttribute("title", sourceUrl);
    expect(sourceLink).toHaveClass("break-all");
  });
});

describe("CaioPage BRAIN tab", () => {
  it("shows the BRAIN loading state while the status request is in flight", async () => {
    let resolveBrain:
      | ((value: { data: typeof brainOkResponse }) => void)
      | undefined;
    customFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/v1/caio/think-loop/recent")) {
        return { data: emptyThinkLoopResponse };
      }
      if (url.startsWith("/api/v1/caio/brain/status")) {
        return new Promise((resolve) => {
          resolveBrain = resolve;
        });
      }
      throw new Error(`Unhandled URL in test: ${url}`);
    });

    const user = userEvent.setup();
    render(<CaioPage />);
    await user.click(await screen.findByRole("tab", { name: "BRAIN" }));

    expect(screen.getByText("Carregando BRAIN…")).toBeInTheDocument();

    resolveBrain?.({ data: brainOkResponse });
    expect(
      await screen.findByText("Runtime local-first é a fonte de verdade"),
    ).toBeInTheDocument();
  });

  it("loads the read-only BRAIN runtime status with contract, inventory, reads, and audit evidence", async () => {
    mockCaioPageFetch();

    await openBrainTab();

    expect(
      await screen.findByText("Runtime local-first é a fonte de verdade"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Markdown é projeção/cache humano; não é a API primária de memória da IA.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("BrainRead")).toBeInTheDocument();
    expect(screen.getByText("BrainWrite")).toBeInTheDocument();
    expect(screen.getByText("memory/main.sqlite")).toBeInTheDocument();
    expect(screen.getByText("BRAIN runtime OK")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Projection snippet for the human-readable cache.",
      ),
    ).toBeInTheDocument();

    expect(
      customFetchMock.mock.calls.some(([url]) =>
        String(url).startsWith("/api/v1/caio/brain/status"),
      ),
    ).toBe(true);
  });

  it("filters contact and braindump projections locally without exposing write controls", async () => {
    mockCaioPageFetch();

    const user = await openBrainTab();
    const filter = await screen.findByRole("searchbox", {
      name: "Filtrar inventário e leituras BRAIN",
    });

    await user.type(filter, "551199");

    expect(
      screen.getByText("contatos/5511999999999@s.whatsapp.net.md"),
    ).toBeInTheDocument();
    expect(screen.queryByText("contatos/Maria.md")).not.toBeInTheDocument();
    expect(screen.queryByText("Braindump/idea.md")).not.toBeInTheDocument();

    const brainPanel = screen.getByRole("tabpanel", { name: "BRAIN" });
    expect(
      within(brainPanel).queryByRole("button", {
        name: /salvar|editar|excluir|criar|write|delete|save|edit/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("renders disabled, error, and timeout bridge envelopes without crashing", async () => {
    const cases = [
      {
        status: "disabled",
        error_class: "BrainRuntimeDisabled",
        expected: "BRAIN bridge disabled",
      },
      {
        status: "error",
        error_class: "BrainRuntimeContractError",
        expected: "BRAIN bridge error: BrainRuntimeContractError",
      },
      {
        status: "timeout",
        error_class: "TimeoutError",
        expected: "BRAIN bridge timeout: TimeoutError",
      },
    ];

    for (const bridgeCase of cases) {
      cleanup();
      customFetchMock.mockReset();
      mockCaioPageFetch({
        status: bridgeCase.status,
        error_class: bridgeCase.error_class,
        latency_ms: 0,
        contract: null,
        inventory: [],
        reads: [],
        audit: { status: "unavailable", available: false },
        limits: {
          snippet_max_chars: 600,
          collection_limit: 8,
          audit_output_max_chars: 2000,
        },
      });

      await openBrainTab();

      await waitFor(() => {
        expect(screen.getByText(bridgeCase.expected)).toBeInTheDocument();
      });
      expect(
        screen.getByText("Nenhum artefato BRAIN disponível para exibir."),
      ).toBeInTheDocument();
    }
  });
});
