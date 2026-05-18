"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  AlertTriangle,
  Check,
  RefreshCw,
  X as XIcon,
} from "lucide-react";

import { customFetch, ApiError } from "@/api/mutator";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type CaioBridgeStatus =
  | "ok"
  | "error"
  | "disabled"
  | "circuit_open"
  | "timeout";

type CaioDecisionKind = "approve" | "reject";

type CaioEventDecisionRead = {
  decision: CaioDecisionKind;
  decided_at: string;
  decided_by_user_id: string;
  note: string | null;
};

type CaioEventItem = {
  event_id: string;
  occurred_at: string;
  event_type: string;
  source: string;
  producer_id: string;
  correlation_id: string | null;
  thread_id: string | null;
  payload: Record<string, unknown> | null;
  decision: CaioEventDecisionRead | null;
};

type CaioRecentEventsResponse = {
  status: CaioBridgeStatus;
  error_class: string | null;
  latency_ms: number;
  items: CaioEventItem[];
};

type CaioDecisionResponse = {
  event_id: string;
  decision: CaioDecisionKind;
  decided_at: string;
  decided_by_user_id: string;
  note: string | null;
  mode: "mark_only";
};

const EVENT_TYPE_BADGES: Record<string, { label: string; tone: string }> = {
  "think_loop.proposal": {
    label: "Proposal",
    tone: "bg-indigo-100 text-indigo-800",
  },
  "think_loop.policy_decision": {
    label: "Policy",
    tone: "bg-amber-100 text-amber-800",
  },
  "think_loop.dispatched": {
    label: "Dispatched",
    tone: "bg-emerald-100 text-emerald-800",
  },
  "advisor.consult_requested": {
    label: "Advisor",
    tone: "bg-sky-100 text-sky-800",
  },
  "reflexion.critique_generated": {
    label: "Critique",
    tone: "bg-fuchsia-100 text-fuchsia-800",
  },
};

function formatOccurredAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  const d = new Date(ms);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPayloadSummary(item: CaioEventItem): string {
  const payload = item.payload;
  if (!payload || typeof payload !== "object") {
    return "(no payload)";
  }
  if (typeof payload.action === "string" && payload.action) {
    return payload.action as string;
  }
  if (typeof payload.reason === "string" && payload.reason) {
    return payload.reason as string;
  }
  if (typeof payload.advisor_name === "string" && payload.advisor_name) {
    return `Consultou ${payload.advisor_name as string}`;
  }
  if (typeof payload.hit === "string" && payload.hit) {
    return payload.hit as string;
  }
  try {
    return JSON.stringify(payload).slice(0, 220);
  } catch {
    return "(unparsable payload)";
  }
}

function levelBadge(item: CaioEventItem): string | null {
  const payload = item.payload;
  if (!payload || typeof payload !== "object") return null;
  const level = (payload as { level?: unknown }).level;
  if (typeof level === "string" && /^L[1-4]$/.test(level)) {
    return level;
  }
  return null;
}

function statusMessage(
  status: CaioBridgeStatus,
  errorClass: string | null,
): string {
  switch (status) {
    case "ok":
      return "";
    case "disabled":
      return "Bridge desligada (CAIO_BRIDGE_EVENTS_ENABLED=false).";
    case "circuit_open":
      return "Circuit breaker aberto após falhas repetidas. Reabrirá automaticamente em alguns segundos.";
    case "timeout":
      return "Leitura excedeu o timeout (2s). Caio pode estar gravando — tente recarregar.";
    case "error":
      return `Erro de leitura${errorClass ? ` (${errorClass})` : ""}.`;
  }
}

export default function CaioPage() {
  const [response, setResponse] = useState<CaioRecentEventsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // event_ids currently in-flight for a decision POST; disables their buttons.
  const [pendingDecisions, setPendingDecisions] = useState<Set<string>>(
    () => new Set(),
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await customFetch<{ data: CaioRecentEventsResponse }>(
        "/api/v1/caio/think-loop/recent?limit=30",
        { method: "GET" },
      );
      setResponse(result.data);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Failed to load";
      setErrorMessage(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const markDecision = useCallback(
    async (eventId: string, decision: CaioDecisionKind) => {
      setPendingDecisions((prev) => {
        const next = new Set(prev);
        next.add(eventId);
        return next;
      });
      setErrorMessage(null);
      try {
        const result = await customFetch<{ data: CaioDecisionResponse }>(
          "/api/v1/caio/think-loop/decisions",
          {
            method: "POST",
            body: JSON.stringify({ event_id: eventId, decision }),
          },
        );
        const fresh = result.data;
        // Optimistically patch the local list so the UI updates instantly.
        setResponse((prev) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((item) =>
                  item.event_id === eventId
                    ? {
                        ...item,
                        decision: {
                          decision: fresh.decision,
                          decided_at: fresh.decided_at,
                          decided_by_user_id: fresh.decided_by_user_id,
                          note: fresh.note,
                        },
                      }
                    : item,
                ),
              }
            : prev,
        );
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "Failed to mark decision";
        setErrorMessage(msg);
      } finally {
        setPendingDecisions((prev) => {
          const next = new Set(prev);
          next.delete(eventId);
          return next;
        });
      }
    },
    [],
  );

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const items = response?.items ?? [];
  const statusBanner =
    response && response.status !== "ok"
      ? statusMessage(response.status, response.error_class)
      : null;

  return (
    <DashboardPageLayout
      signedOut={{
        message:
          "Faça login para ver as decisões e propostas autônomas do Caio.",
        forceRedirectUrl: "/caio",
      }}
      title={
        <span className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-indigo-600" />
          Caio · Think Loop
        </span>
      }
      description="Últimas decisões e propostas autônomas do Caio. Approve/reject é mark_only — registra no Cockpit DB sem disparar nada nos pipelines do Caio."
      headerActions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void load();
          }}
          disabled={loading}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Recarregar
        </Button>
      }
    >
      {statusBanner ? (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{statusBanner}</span>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {errorMessage}
        </div>
      ) : null}

      {loading && !response ? (
        <p className="text-sm text-slate-500">Carregando…</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-slate-500">
            Nenhum evento Caio nos últimos registros.
            {response
              ? ` (status=${response.status}, latência=${response.latency_ms}ms)`
              : ""}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const badge = EVENT_TYPE_BADGES[item.event_type] ?? {
              label: item.event_type,
              tone: "bg-slate-100 text-slate-800",
            };
            const level = levelBadge(item);
            const decided = item.decision;
            const pending = pendingDecisions.has(item.event_id);
            return (
              <Card key={item.event_id}>
                <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${badge.tone}`}
                    >
                      {badge.label}
                    </span>
                    {level ? (
                      <Badge variant="outline" className="text-xs">
                        {level}
                      </Badge>
                    ) : null}
                    {decided ? (
                      <span
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${
                          decided.decision === "approve"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        {decided.decision === "approve" ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <XIcon className="h-3 w-3" />
                        )}
                        {decided.decision === "approve"
                          ? "Aprovado"
                          : "Rejeitado"}
                      </span>
                    ) : null}
                    <span className="text-xs font-normal text-slate-500">
                      {item.source}
                    </span>
                  </div>
                  <span className="text-xs text-slate-500">
                    {formatOccurredAt(item.occurred_at)}
                  </span>
                </CardHeader>
                <CardContent className="pt-2 text-sm text-slate-700">
                  <p className="whitespace-pre-wrap">
                    {formatPayloadSummary(item)}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={
                        decided?.decision === "approve" ? "primary" : "outline"
                      }
                      className={
                        decided?.decision === "approve"
                          ? "bg-emerald-600 text-white hover:bg-emerald-700"
                          : "border-emerald-200 text-emerald-800 hover:bg-emerald-50"
                      }
                      onClick={() => {
                        void markDecision(item.event_id, "approve");
                      }}
                      disabled={pending}
                    >
                      <Check className="h-3.5 w-3.5" />
                      {decided?.decision === "approve" ? "Aprovado" : "Aprovar"}
                    </Button>
                    <Button
                      size="sm"
                      variant={
                        decided?.decision === "reject" ? "primary" : "outline"
                      }
                      className={
                        decided?.decision === "reject"
                          ? "bg-rose-600 text-white hover:bg-rose-700"
                          : "border-rose-200 text-rose-800 hover:bg-rose-50"
                      }
                      onClick={() => {
                        void markDecision(item.event_id, "reject");
                      }}
                      disabled={pending}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                      {decided?.decision === "reject" ? "Rejeitado" : "Rejeitar"}
                    </Button>
                    {pending ? (
                      <span className="text-xs text-slate-500">salvando…</span>
                    ) : decided ? (
                      <span className="text-xs text-slate-500">
                        em {formatOccurredAt(decided.decided_at)} · mark_only
                      </span>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </DashboardPageLayout>
  );
}
