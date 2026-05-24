"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  AlertTriangle,
  Check,
  Lightbulb,
  RefreshCw,
  Sparkles,
  X as XIcon,
} from "lucide-react";

import { customFetch, ApiError } from "@/api/mutator";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

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
  started_at: string | null;
  completed_at: string | null;
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
  started_at: string | null;
  completed_at: string | null;
  mode: "mark_only";
};

type StatusBucket =
  | "pending"
  | "todo"
  | "in_progress"
  | "done"
  | "rejected"
  | "history";

type CaioWaContactStats = {
  jid: string;
  contact_name: string | null;
  total: number;
  approved: number;
  replaced: number;
  manual_override: number;
  rejected: number;
  blocked: number;
  engaged: number;
  engagement_rate: number | null;
  avg_approval_time_s: number | null;
  last_interaction_at: string | null;
};

type CaioWaWindow = {
  days: number;
  min_interactions: number;
  total_interactions: number;
  engaged_interactions: number;
  engagement_rate: number | null;
  distinct_contacts: number;
};

type CaioWaApprovalsResponse = {
  status: CaioBridgeStatus;
  error_class: string | null;
  latency_ms: number;
  window: CaioWaWindow | null;
  contacts: CaioWaContactStats[];
};

type CaioCritiqueItem = {
  id: number;
  generated_at: string;
  approval_log_id: number;
  jid: string | null;
  action: string;
  contact_message: string | null;
  caio_suggestion: string | null;
  final_response: string | null;
  miss: string | null;
  hit: string | null;
  pattern: string | null;
  confidence: number | null;
};

type CaioCritiquesWindow = {
  since_days: number;
  since_iso: string | null;
  total_returned: number;
};

type CaioRecentCritiquesResponse = {
  status: CaioBridgeStatus;
  error_class: string | null;
  latency_ms: number;
  items: CaioCritiqueItem[];
  window: CaioCritiquesWindow;
};

type ActiveTab = "think_loop" | "reflexion" | "whatsapp";

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

const ACTION_TONES: Record<string, string> = {
  replaced: "bg-amber-100 text-amber-800",
  rejected: "bg-rose-100 text-rose-800",
  manual_override: "bg-sky-100 text-sky-800",
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function formatCertainty(value: unknown): string | null {
  const n = asNumber(value);
  return n === null ? null : `${Math.round(n * 100)}%`;
}

type RenderedSummary = {
  /** Short human title — what this event *is*. */
  title: string;
  /** The free-form body Pedro reads to decide. */
  body: string;
  /** Optional inline badges shown next to the event type badge. */
  badges: { label: string; tone: string }[];
  /** Plain-PT-BR "impacto real" line — what actually happens in the world. */
  impact?: string;
  /** Visual tone for the impact badge. */
  impactTone?: string;
};

const LEVEL_MEANING: Record<string, string> = {
  L1: "Apenas anotar — Caio só registra, nada é proposto a você",
  L2: "Sugerir — Caio te mostra a ideia, mas espera você decidir",
  L3: "Auto-executar — Caio age sem te perguntar (autonomia média)",
  L4: "Bloqueado até Pedro autorizar — ação crítica reservada para você",
};

function modeMeaning(mode: string | null): {
  text: string;
  tone: string;
  label: string;
} {
  if (mode === "shadow") {
    return {
      text:
        "Modo simulado: Caio ESCREVEU a decisão no log mas NÃO executou nada " +
        "no mundo real (nem WhatsApp, nem código, nem nada externo).",
      tone: "bg-slate-100 text-slate-700",
      label: "simulado · sem efeito real",
    };
  }
  if (mode === "live") {
    return {
      text:
        "Modo live: ação EXECUTADA de fato no canal/sistema correspondente. " +
        "Veja o card 'Dispatched' relacionado se houve confirmação.",
      tone: "bg-emerald-100 text-emerald-700",
      label: "executado de verdade",
    };
  }
  return {
    text: `Modo '${mode ?? "?"}': comportamento não traduzido na UI.`,
    tone: "bg-slate-100 text-slate-700",
    label: mode ?? "?",
  };
}

function renderSummary(
  item: CaioEventItem,
  pairedProposal?: CaioEventItem,
): RenderedSummary {
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const badges: { label: string; tone: string }[] = [];

  if (item.event_type === "think_loop.proposal") {
    const action = asString(payload.action) ?? "(proposta sem texto)";
    const actionType = asString(payload.action_type);
    const rationale = asString(payload.rationale);
    const certainty = formatCertainty(payload.certainty);
    const mode = asString(payload.mode);
    const requiresInput = asBoolean(payload.requires_pedro_input);

    if (actionType) {
      badges.push({
        label: actionType,
        tone: "bg-indigo-50 text-indigo-700 border border-indigo-200",
      });
    }
    if (certainty) {
      badges.push({
        label: `conf ${certainty}`,
        tone: "bg-slate-50 text-slate-700 border border-slate-200",
      });
    }
    if (mode) {
      const mm = modeMeaning(mode);
      badges.push({
        label: mm.label,
        tone:
          mode === "shadow"
            ? "bg-slate-50 text-slate-600 border border-slate-200"
            : "bg-emerald-50 text-emerald-700 border border-emerald-200",
      });
    }
    if (requiresInput) {
      badges.push({
        label: "precisa Pedro",
        tone: "bg-amber-50 text-amber-800 border border-amber-200",
      });
    }
    const mm = modeMeaning(mode);
    return {
      title: "Proposta do Caio",
      body: rationale ? `${action}\n\nPor quê: ${rationale}` : action,
      badges,
      impact: requiresInput
        ? `${mm.text} Caio marcou esta proposta como "precisa Pedro" — ` +
          `geralmente vira card no canal correspondente para você decidir.`
        : mm.text,
      impactTone: mm.tone,
    };
  }

  if (item.event_type === "think_loop.policy_decision") {
    const actionType = asString(payload.action_type) ?? "?";
    const level = asString(payload.level);
    const mode = asString(payload.mode);
    const allowed = asBoolean(payload.allowed);
    const certainty = formatCertainty(payload.certainty);
    const requiresApproval = asBoolean(payload.requires_approval);
    const hardRule = asString(payload.hard_rule_triggered);

    if (level) {
      badges.push({
        label: level,
        tone: "bg-amber-50 text-amber-800 border border-amber-200",
      });
    }
    if (mode) {
      const mm = modeMeaning(mode);
      badges.push({
        label: mm.label,
        tone:
          mode === "shadow"
            ? "bg-slate-50 text-slate-600 border border-slate-200"
            : "bg-emerald-50 text-emerald-700 border border-emerald-200",
      });
    }
    if (certainty) {
      badges.push({
        label: `conf ${certainty}`,
        tone: "bg-slate-50 text-slate-700 border border-slate-200",
      });
    }
    badges.push({
      label: allowed ? "permitido" : "bloqueado",
      tone: allowed
        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
        : "bg-rose-50 text-rose-700 border border-rose-200",
    });
    if (requiresApproval) {
      badges.push({
        label: "requer aprovação",
        tone: "bg-amber-50 text-amber-800 border border-amber-200",
      });
    }
    if (hardRule) {
      badges.push({
        label: `regra: ${hardRule}`,
        tone: "bg-rose-50 text-rose-700 border border-rose-200",
      });
    }

    // Build the body — preferring to show the *actual* proposal text when
    // we can pair it with the matching proposal event.
    const proposalPayload = (pairedProposal?.payload ?? {}) as Record<
      string,
      unknown
    >;
    const proposalText = asString(proposalPayload.action);
    const proposalRationale = asString(proposalPayload.rationale);

    const policySentence =
      `Caio classificou esta ação como '${actionType}' e a política decidiu ` +
      `${allowed ? "permitir" : "bloquear"}` +
      `${level ? ` no nível ${level}` : ""}` +
      `${mode ? `, ${modeMeaning(mode).label}` : ""}` +
      `${requiresApproval ? ", aguardando aprovação Pedro" : ""}.` +
      (hardRule ? `\nRegra dura disparada: ${hardRule}` : "");

    const levelLine = level && LEVEL_MEANING[level]
      ? `${level} significa: ${LEVEL_MEANING[level]}`
      : "";

    const bodyParts = [
      proposalText ? `Proposta original do Caio:\n"${proposalText}"` : null,
      proposalRationale ? `Por quê: ${proposalRationale}` : null,
      policySentence,
      levelLine || null,
    ].filter(Boolean);

    const mm = modeMeaning(mode);
    let impact = mm.text;
    if (!allowed) {
      impact = `Bloqueada pela política. Nada executado. Caio aguarda nova proposta ou intervenção.`;
    } else if (requiresApproval) {
      impact =
        `Aguardando aprovação do Pedro. Nada foi feito ainda; a ação é ` +
        `disparada (em modo ${mode ?? "?"}) só depois que você responde no ` +
        `canal de aprovação correspondente.`;
    }
    return {
      title: pairedProposal ? "Proposta + decisão" : "Decisão de política",
      body: bodyParts.join("\n\n"),
      badges,
      impact,
      impactTone: !allowed
        ? "bg-rose-100 text-rose-800"
        : requiresApproval
          ? "bg-amber-100 text-amber-800"
          : mm.tone,
    };
  }

  if (item.event_type === "think_loop.dispatched") {
    const channel = asString(payload.channel) ?? asString(payload.target);
    const summary = asString(payload.summary) ?? asString(payload.action);
    return {
      title: "Ação despachada",
      body:
        (summary ?? "(sem resumo)") +
        (channel ? `\nCanal/target: ${channel}` : ""),
      badges,
    };
  }

  if (item.event_type === "advisor.consult_requested") {
    const advisor = asString(payload.advisor_name) ?? "?";
    const question = asString(payload.question) ?? asString(payload.prompt);
    return {
      title: `Consulta ao advisor ${advisor}`,
      body: question ?? "(sem pergunta no payload)",
      badges,
    };
  }

  if (item.event_type === "reflexion.critique_generated") {
    const action = asString(payload.action);
    const pattern = asString(payload.pattern);
    const confidence = formatCertainty(payload.confidence);
    if (confidence) {
      badges.push({
        label: `conf ${confidence}`,
        tone: "bg-slate-50 text-slate-700 border border-slate-200",
      });
    }
    if (action) {
      badges.push({
        label: action,
        tone: "bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200",
      });
    }
    return {
      title: "Pattern aprendido pelo Caio",
      body: pattern ?? "(pattern não disponível neste resumo — abra a tab Reflexion)",
      badges,
    };
  }

  // Fallback: dump the payload so the card is not empty.
  let dump = "(sem payload)";
  try {
    dump = JSON.stringify(payload, null, 2);
  } catch {
    // keep fallback
  }
  return {
    title: item.event_type,
    body: dump,
    badges,
  };
}

type EventCategory = "pedro" | "blocked" | "history";

function categorize(
  item: CaioEventItem,
  pairedProposal?: CaioEventItem,
): EventCategory {
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const proposalPayload = (pairedProposal?.payload ?? {}) as Record<
    string,
    unknown
  >;

  if (item.event_type === "think_loop.policy_decision") {
    const allowed = asBoolean(payload.allowed);
    const requiresApproval = asBoolean(payload.requires_approval);
    const requiresPedro = asBoolean(proposalPayload.requires_pedro_input);
    const hardRule = asString(payload.hard_rule_triggered);
    if (allowed === false || hardRule) return "blocked";
    if (requiresApproval || requiresPedro) return "pedro";
    return "history";
  }

  if (item.event_type === "think_loop.proposal") {
    const requiresPedro = asBoolean(payload.requires_pedro_input);
    return requiresPedro ? "pedro" : "history";
  }

  // advisor consults, dispatched, fallback reflexion notes — all informative.
  return "history";
}

const CATEGORY_META: Record<
  EventCategory,
  { label: string; tone: string; ring: string }
> = {
  pedro: {
    label: "🟢 Aguarda você",
    tone: "bg-emerald-100 text-emerald-800",
    ring: "ring-2 ring-emerald-200",
  },
  blocked: {
    label: "🔴 Bloqueado",
    tone: "bg-rose-100 text-rose-800",
    ring: "ring-1 ring-rose-200",
  },
  history: {
    label: "📜 Histórico",
    tone: "bg-slate-100 text-slate-600",
    ring: "",
  },
};

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
  bridgeName: string,
): string {
  switch (status) {
    case "ok":
      return "";
    case "disabled":
      return `${bridgeName} desligada via env.`;
    case "circuit_open":
      return "Circuit breaker aberto após falhas repetidas. Reabrirá automaticamente em alguns segundos.";
    case "timeout":
      return `Leitura excedeu o timeout. Caio pode estar gravando ${bridgeName} — tente recarregar.`;
    case "error":
      return `Erro de leitura${errorClass ? ` (${errorClass})` : ""}.`;
  }
}

function formatJid(jid: string | null): string {
  if (!jid) return "—";
  // Strip the @s.whatsapp.net suffix; keep the digits the eye recognises.
  return jid.replace(/@s\.whatsapp\.net$/, "");
}

function formatConfidence(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
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
  // event_ids whose "ver detalhes" toggle is currently open.
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(
    () => new Set(),
  );

  const [critiquesResponse, setCritiquesResponse] =
    useState<CaioRecentCritiquesResponse | null>(null);
  const [critiquesLoading, setCritiquesLoading] = useState<boolean>(false);
  const [critiquesError, setCritiquesError] = useState<string | null>(null);

  const [waResponse, setWaResponse] =
    useState<CaioWaApprovalsResponse | null>(null);
  const [waLoading, setWaLoading] = useState<boolean>(false);
  const [waError, setWaError] = useState<string | null>(null);
  const [waDays, setWaDays] = useState<number>(7);

  const [activeTab, setActiveTab] = useState<ActiveTab>("think_loop");
  const [activeBucket, setActiveBucket] = useState<StatusBucket>("pending");

  const toggleExpanded = useCallback((eventId: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  }, []);

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

  const loadWa = useCallback(
    async (days: number) => {
      setWaLoading(true);
      setWaError(null);
      try {
        const result = await customFetch<{ data: CaioWaApprovalsResponse }>(
          `/api/v1/caio/wa/recent-approvals?days=${days}&min_interactions=1&limit=100`,
          { method: "GET" },
        );
        setWaResponse(result.data);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "Failed to load WhatsApp stats";
        setWaError(msg);
      } finally {
        setWaLoading(false);
      }
    },
    [],
  );

  const loadCritiques = useCallback(async () => {
    setCritiquesLoading(true);
    setCritiquesError(null);
    try {
      const result = await customFetch<{
        data: CaioRecentCritiquesResponse;
      }>("/api/v1/caio/reflexion/critiques?since_days=30&limit=50", {
        method: "GET",
      });
      setCritiquesResponse(result.data);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Failed to load critiques";
      setCritiquesError(msg);
    } finally {
      setCritiquesLoading(false);
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
                          started_at: fresh.started_at,
                          completed_at: fresh.completed_at,
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

  // Lazy-load critiques the first time the user opens the Reflexion tab —
  // weekly cadence means polling is unnecessary; a manual reload is enough.
  useEffect(() => {
    if (activeTab === "reflexion" && critiquesResponse === null) {
      void loadCritiques();
    }
  }, [activeTab, critiquesResponse, loadCritiques]);

  // Same lazy-load story for the WhatsApp engagement tab.
  useEffect(() => {
    if (activeTab === "whatsapp" && waResponse === null) {
      void loadWa(waDays);
    }
  }, [activeTab, waResponse, waDays, loadWa]);

  const rawItems = response?.items ?? [];

  // Pair each policy_decision with the proposal that immediately preceded it
  // within ±2s (Caio writes both events back-to-back). The paired proposal is
  // attached as a synthetic field so the policy card can show the actual
  // proposal text; the consumed proposal is then dropped from the rendered
  // list so Pedro sees one card per decision instead of two side-by-side.
  type DecoratedItem = CaioEventItem & {
    _pairedProposal?: CaioEventItem;
    _category?: EventCategory;
    _bucket?: StatusBucket;
  };
  const items: DecoratedItem[] = [];
  const consumedProposalIds = new Set<string>();
  for (let i = 0; i < rawItems.length; i++) {
    const ev = rawItems[i];
    if (ev.event_type === "think_loop.policy_decision") {
      // proposal usually appears immediately AFTER policy_decision in DESC
      // order because they share the timestamp and policy_decision is logged
      // moments later. Look at neighbours within ±2s.
      const evMs = Date.parse(ev.occurred_at);
      let paired: CaioEventItem | undefined;
      for (const cand of rawItems) {
        if (cand.event_type !== "think_loop.proposal") continue;
        if (consumedProposalIds.has(cand.event_id)) continue;
        const dt = Math.abs(Date.parse(cand.occurred_at) - evMs);
        if (Number.isFinite(dt) && dt <= 2000) {
          paired = cand;
          break;
        }
      }
      if (paired) {
        consumedProposalIds.add(paired.event_id);
        items.push({ ...ev, _pairedProposal: paired });
      } else {
        items.push(ev);
      }
    } else {
      items.push(ev);
    }
  }
  // Filter out proposals that were merged into a policy_decision card.
  const preCategoryItems = items.filter(
    (it) =>
      !(
        it.event_type === "think_loop.proposal" &&
        consumedProposalIds.has(it.event_id)
      ),
  );

  // Categorize each surviving item and split into buckets so the UI can
  // route each card into the right Pendente / To Do / Done / Rejected /
  // Histórico sub-pill.
  function bucketOf(
    decision: CaioEventDecisionRead | null,
    category: EventCategory,
  ): StatusBucket {
    if (category === "history") return "history";
    if (!decision) return "pending";
    if (decision.decision === "reject") return "rejected";
    if (decision.completed_at) return "done";
    if (decision.started_at) return "in_progress";
    return "todo";
  }

  const categorizedItems = preCategoryItems.map((it) => {
    const cat = categorize(it, it._pairedProposal);
    return {
      ...it,
      _category: cat,
      _bucket: bucketOf(it.decision, cat),
    };
  });
  const pendingItems = categorizedItems.filter(
    (it) => it._bucket === "pending",
  );
  const todoItems = categorizedItems.filter((it) => it._bucket === "todo");
  const inProgressItems = categorizedItems.filter(
    (it) => it._bucket === "in_progress",
  );
  const doneItems = categorizedItems.filter((it) => it._bucket === "done");
  const rejectedItems = categorizedItems.filter(
    (it) => it._bucket === "rejected",
  );
  const historyItems = categorizedItems.filter(
    (it) => it._bucket === "history",
  );

  const bucketCounts: Record<StatusBucket, number> = {
    pending: pendingItems.length,
    todo: todoItems.length,
    in_progress: inProgressItems.length,
    done: doneItems.length,
    rejected: rejectedItems.length,
    history: historyItems.length,
  };
  const renderedItems = (() => {
    switch (activeBucket) {
      case "pending":
        return pendingItems;
      case "todo":
        return todoItems;
      case "in_progress":
        return inProgressItems;
      case "done":
        return doneItems;
      case "rejected":
        return rejectedItems;
      case "history":
        return historyItems;
    }
  })();

  const statusBanner =
    response && response.status !== "ok"
      ? statusMessage(response.status, response.error_class, "Think Loop")
      : null;

  const critiqueItems = critiquesResponse?.items ?? [];
  const critiquesBanner =
    critiquesResponse && critiquesResponse.status !== "ok"
      ? statusMessage(
          critiquesResponse.status,
          critiquesResponse.error_class,
          "Reflexion",
        )
      : null;

  const onReload = (() => {
    if (activeTab === "reflexion") return loadCritiques;
    if (activeTab === "whatsapp") return () => loadWa(waDays);
    return load;
  })();
  const reloadDisabled =
    activeTab === "reflexion"
      ? critiquesLoading
      : activeTab === "whatsapp"
        ? waLoading
        : loading;

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
          Caio
        </span>
      }
      description="Decisões autônomas, propostas e patterns que o Caio aprendeu. Approve/reject no Think Loop é mark_only — registra no Cockpit DB sem disparar nada nos pipelines do Caio. Reflexion é read-only."
      headerActions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void onReload();
          }}
          disabled={reloadDisabled}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${reloadDisabled ? "animate-spin" : ""}`}
          />
          Recarregar
        </Button>
      }
    >
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as ActiveTab)}
      >
        <TabsList>
          <TabsTrigger value="think_loop">Think Loop</TabsTrigger>
          <TabsTrigger value="reflexion">Reflexion</TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
        </TabsList>

        <TabsContent value="think_loop">
          <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <p className="mb-2 flex items-center gap-1.5 font-semibold text-slate-800">
              <Sparkles className="h-3.5 w-3.5 text-slate-500" />
              Como ler os cards
            </p>
            <ul className="space-y-1.5">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex flex-shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                  🟢 verde
                </span>
                <span>Caio aguarda você decidir — sua resposta importa.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex flex-shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-rose-100 text-rose-800">
                  🔴 vermelho
                </span>
                <span>
                  A política do Caio bloqueou — só ciência, sem botão.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex flex-shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-600">
                  📜 cinza
                </span>
                <span>
                  Histórico do que Caio já fez sozinho (escondido por
                  padrão). Concordo/Discordo aqui só vira feedback
                  retrospectivo, não muda nada agora.
                </span>
              </li>
            </ul>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-1">
            {(
              [
                {
                  key: "pending",
                  label: "Pendente",
                  count: bucketCounts.pending,
                },
                { key: "todo", label: "To Do", count: bucketCounts.todo },
                {
                  key: "in_progress",
                  label: "In Progress",
                  count: bucketCounts.in_progress,
                },
                { key: "done", label: "Done", count: bucketCounts.done },
                {
                  key: "rejected",
                  label: "Rejected",
                  count: bucketCounts.rejected,
                },
                {
                  key: "history",
                  label: "Histórico",
                  count: bucketCounts.history,
                },
              ] as { key: StatusBucket; label: string; count: number }[]
            ).map((b) => (
              <Button
                key={b.key}
                size="sm"
                variant={activeBucket === b.key ? "primary" : "outline"}
                className={
                  activeBucket === b.key
                    ? "bg-indigo-600 text-white hover:bg-indigo-700"
                    : "border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
                }
                onClick={() => setActiveBucket(b.key)}
              >
                {b.label} ({b.count})
              </Button>
            ))}
          </div>

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
          ) : renderedItems.length === 0 ? (
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
              {renderedItems.map((item) => {
                const badge = EVENT_TYPE_BADGES[item.event_type] ?? {
                  label: item.event_type,
                  tone: "bg-slate-100 text-slate-800",
                };
                const level = levelBadge(item);
                const decided = item.decision;
                const pending = pendingDecisions.has(item.event_id);
                const summary = renderSummary(item, item._pairedProposal);
                const expanded = expandedEvents.has(item.event_id);
                const category: EventCategory = item._category ?? "history";
                const categoryMeta = CATEGORY_META[category];
                const isHistory = category === "history";
                return (
                  <Card
                    key={item.event_id}
                    className={`${categoryMeta.ring} ${isHistory ? "opacity-80" : ""}`}
                  >
                    <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${categoryMeta.tone}`}
                        >
                          {categoryMeta.label}
                        </span>
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
                        {summary.badges.map((b, idx) => (
                          <span
                            key={`${item.event_id}-badge-${idx}`}
                            className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${b.tone}`}
                          >
                            {b.label}
                          </span>
                        ))}
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
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {summary.title}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap">{summary.body}</p>
                      {summary.impact ? (
                        <div
                          className={`mt-3 rounded-md border border-slate-200 p-2 text-xs ${
                            summary.impactTone ?? "bg-slate-50 text-slate-700"
                          }`}
                        >
                          <p className="font-semibold uppercase tracking-wide">
                            impacto real
                          </p>
                          <p className="mt-0.5 whitespace-pre-wrap">
                            {summary.impact}
                          </p>
                        </div>
                      ) : null}
                      {category === "pedro" ? (
                        <p className="mt-3 text-xs font-semibold text-emerald-700">
                          Sua decisão aqui é registrada e usada pelo Reflexion
                          semanal para ajustar a política do Caio.
                        </p>
                      ) : category === "blocked" ? (
                        <p className="mt-3 text-xs font-semibold text-rose-700">
                          Bloqueado pela política — Caio não executou nada.
                          Sem decisão sua a tomar aqui (apenas ciência).
                        </p>
                      ) : (
                        <p className="mt-3 text-xs text-slate-500">
                          Caio já decidiu sozinho (auto-executou em modo
                          shadow ou ignorou). Os botões abaixo são apenas
                          marcador retrospectivo: dão sinal pro Reflexion
                          (loop semanal) se você concorda com a decisão dele.
                        </p>
                      )}
                      {expanded ? (
                        <pre className="mt-2 overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
                          {JSON.stringify(
                            {
                              event_id: item.event_id,
                              event_type: item.event_type,
                              source: item.source,
                              producer_id: item.producer_id,
                              occurred_at: item.occurred_at,
                              correlation_id: item.correlation_id,
                              thread_id: item.thread_id,
                              payload: item.payload,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {category !== "blocked" ? (
                          <>
                            <Button
                              size="sm"
                              variant={
                                decided?.decision === "approve"
                                  ? "primary"
                                  : "outline"
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
                              {decided?.decision === "approve"
                                ? "Aprovado"
                                : category === "pedro"
                                  ? "Aprovar"
                                  : "Concordo"}
                            </Button>
                            <Button
                              size="sm"
                              variant={
                                decided?.decision === "reject"
                                  ? "primary"
                                  : "outline"
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
                              {decided?.decision === "reject"
                                ? "Rejeitado"
                                : category === "pedro"
                                  ? "Rejeitar"
                                  : "Discordo"}
                            </Button>
                          </>
                        ) : null}
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
                          onClick={() => toggleExpanded(item.event_id)}
                        >
                          {expanded ? "Esconder detalhes" : "Ver detalhes (JSON)"}
                        </Button>
                        {pending ? (
                          <span className="text-xs text-slate-500">
                            salvando…
                          </span>
                        ) : decided?.completed_at ? (
                          <span className="text-xs text-emerald-700">
                            Caio terminou em{" "}
                            {formatOccurredAt(decided.completed_at)}
                          </span>
                        ) : decided?.started_at ? (
                          <span className="text-xs text-indigo-700">
                            Caio trabalhando desde{" "}
                            {formatOccurredAt(decided.started_at)}
                          </span>
                        ) : decided?.decision === "approve" ? (
                          <span className="text-xs text-slate-500">
                            aprovado em {formatOccurredAt(decided.decided_at)}{" "}
                            · aguardando Caio pegar
                          </span>
                        ) : decided ? (
                          <span className="text-xs text-slate-500">
                            em {formatOccurredAt(decided.decided_at)} ·
                            mark_only
                          </span>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="reflexion">
          {critiquesBanner ? (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{critiquesBanner}</span>
            </div>
          ) : null}

          {critiquesError ? (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {critiquesError}
            </div>
          ) : null}

          {critiquesLoading && !critiquesResponse ? (
            <p className="text-sm text-slate-500">Carregando critiques…</p>
          ) : critiqueItems.length === 0 ? (
            <Card>
              <CardContent className="py-6 text-sm text-slate-500">
                Nenhum critique nos últimos 30 dias. Reflexion roda aos
                domingos 18h (SP).
                {critiquesResponse
                  ? ` (status=${critiquesResponse.status}, latência=${critiquesResponse.latency_ms}ms)`
                  : ""}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">
                {critiqueItems.length} critiques · janela{" "}
                {critiquesResponse?.window.since_days ?? 30} dias
              </p>
              {critiqueItems.map((c) => {
                const actionTone =
                  ACTION_TONES[c.action] ?? "bg-slate-100 text-slate-800";
                return (
                  <Card key={c.id}>
                    <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold uppercase ${actionTone}`}
                        >
                          {c.action}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          conf {formatConfidence(c.confidence)}
                        </Badge>
                        <span className="text-xs font-normal text-slate-500">
                          {formatJid(c.jid)}
                        </span>
                      </div>
                      <span className="text-xs text-slate-500">
                        {formatOccurredAt(c.generated_at)}
                      </span>
                    </CardHeader>
                    <CardContent className="space-y-2 pt-2 text-sm text-slate-700">
                      {c.miss ? (
                        <div className="rounded-md border border-rose-200 bg-rose-50 p-2">
                          <p className="flex items-center gap-1 text-xs font-semibold text-rose-800">
                            <XIcon className="h-3 w-3" /> Miss
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-rose-900">
                            {c.miss}
                          </p>
                        </div>
                      ) : null}
                      {c.hit ? (
                        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2">
                          <p className="flex items-center gap-1 text-xs font-semibold text-emerald-800">
                            <Check className="h-3 w-3" /> Hit
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-emerald-900">
                            {c.hit}
                          </p>
                        </div>
                      ) : null}
                      {c.pattern ? (
                        <div className="rounded-md border border-fuchsia-200 bg-fuchsia-50 p-2">
                          <p className="flex items-center gap-1 text-xs font-semibold text-fuchsia-800">
                            <Lightbulb className="h-3 w-3" /> Pattern
                          </p>
                          <p className="mt-1 whitespace-pre-wrap font-medium text-fuchsia-900">
                            {c.pattern}
                          </p>
                        </div>
                      ) : null}
                      {!c.miss && !c.hit && !c.pattern ? (
                        <p className="text-xs text-slate-400">
                          (critique sem campos populados)
                        </p>
                      ) : null}
                      <p className="pt-1 text-xs text-slate-400">
                        <Sparkles className="mr-1 inline h-3 w-3" />
                        approval_log #{c.approval_log_id}
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="whatsapp">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {([3, 7, 30, 90] as const).map((d) => (
              <Button
                key={d}
                size="sm"
                variant={waDays === d ? "primary" : "outline"}
                className={
                  waDays === d
                    ? "bg-indigo-600 text-white hover:bg-indigo-700"
                    : "border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
                }
                onClick={() => {
                  setWaDays(d);
                  void loadWa(d);
                }}
              >
                Últimos {d}d
              </Button>
            ))}
          </div>

          {waResponse?.window ? (
            <Card className="mb-3 bg-indigo-50">
              <CardContent className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                  <span>
                    <strong>{waResponse.window.distinct_contacts}</strong>{" "}
                    contatos
                  </span>
                  <span>
                    <strong>{waResponse.window.total_interactions}</strong>{" "}
                    interações
                  </span>
                  <span>
                    <strong>{waResponse.window.engaged_interactions}</strong>{" "}
                    engajadas
                  </span>
                  <span className="font-semibold text-indigo-800">
                    Engagement{" "}
                    {waResponse.window.engagement_rate !== null
                      ? `${Math.round(waResponse.window.engagement_rate * 100)}%`
                      : "—"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Engajada = aprovada, substituída ou manual_override.
                  Não-engajada = rejeitada ou bloqueada.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {waResponse && waResponse.status !== "ok" ? (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                {statusMessage(
                  waResponse.status,
                  waResponse.error_class,
                  "WhatsApp",
                )}
              </span>
            </div>
          ) : null}

          {waError ? (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {waError}
            </div>
          ) : null}

          {waLoading && !waResponse ? (
            <p className="text-sm text-slate-500">Carregando WhatsApp…</p>
          ) : (waResponse?.contacts ?? []).length === 0 ? (
            <Card>
              <CardContent className="py-6 text-sm text-slate-500">
                Nenhuma interação WhatsApp na janela. Tente uma janela maior.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {(waResponse?.contacts ?? []).map((c) => {
                const rate = c.engagement_rate ?? 0;
                const ratePct = Math.round(rate * 100);
                const rateTone =
                  rate >= 0.8
                    ? "bg-emerald-100 text-emerald-800"
                    : rate >= 0.5
                      ? "bg-amber-100 text-amber-800"
                      : "bg-rose-100 text-rose-800";
                return (
                  <Card key={c.jid}>
                    <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="text-slate-800">
                          {c.contact_name || formatJid(c.jid)}
                        </span>
                        {c.contact_name ? (
                          <span className="text-xs font-normal text-slate-500">
                            {formatJid(c.jid)}
                          </span>
                        ) : null}
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${rateTone}`}
                        >
                          {c.engagement_rate !== null ? `${ratePct}%` : "—"}
                        </span>
                      </div>
                      <span className="text-xs text-slate-500">
                        {c.last_interaction_at
                          ? formatOccurredAt(c.last_interaction_at)
                          : ""}
                      </span>
                    </CardHeader>
                    <CardContent className="pt-2 text-sm text-slate-700">
                      <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
                        <span className="rounded bg-slate-100 px-2 py-1">
                          total <strong>{c.total}</strong>
                        </span>
                        <span className="rounded bg-emerald-100 px-2 py-1 text-emerald-800">
                          aprovadas <strong>{c.approved}</strong>
                        </span>
                        <span className="rounded bg-amber-100 px-2 py-1 text-amber-800">
                          substituídas <strong>{c.replaced}</strong>
                        </span>
                        <span className="rounded bg-sky-100 px-2 py-1 text-sky-800">
                          override <strong>{c.manual_override}</strong>
                        </span>
                        <span className="rounded bg-rose-100 px-2 py-1 text-rose-800">
                          rejeitadas <strong>{c.rejected}</strong>
                        </span>
                        <span className="rounded bg-slate-200 px-2 py-1 text-slate-700">
                          bloqueadas <strong>{c.blocked}</strong>
                        </span>
                      </div>
                      {c.avg_approval_time_s !== null ? (
                        <p className="mt-2 text-xs text-slate-500">
                          Tempo médio de aprovação:{" "}
                          {c.avg_approval_time_s < 60
                            ? `${c.avg_approval_time_s.toFixed(1)}s`
                            : `${(c.avg_approval_time_s / 60).toFixed(1)}min`}
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </DashboardPageLayout>
  );
}
