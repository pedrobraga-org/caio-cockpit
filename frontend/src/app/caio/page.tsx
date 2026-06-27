"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  Brain,
  AlertTriangle,
  Check,
  Database,
  FileText,
  HardDrive,
  Lightbulb,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X as XIcon,
} from "lucide-react";

import { customFetch, ApiError } from "@/api/mutator";
import { DashboardPageLayout } from "@/components/templates/DashboardPageLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  resolveBookmarkEvaluationCard,
  type BookmarkSkipDetails,
} from "@/lib/caio-bookmark-card";

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
  discord_message_id: string | null;
  discord_channel_id: string | null;
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
  discord_message_id: string | null;
  discord_channel_id: string | null;
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

type CaioBrainReadSource =
  | "runtime_contract"
  | "local_runtime_contract"
  | "markdown_projection"
  | "sqlite_store"
  | "structured_fact_store"
  | "audit";

type CaioBrainContractSummary = {
  contract_version: number;
  runtime_truth: string;
  icloud_source_of_truth_allowed: boolean;
  obsidian_source_of_truth_allowed: boolean;
  human_markdown_projection_role: string;
  required_terms: string[];
  critical_backup_areas: string[];
  backup_name_patterns: string[];
  allowlist_required_fields: string[];
  allowlist_date_format: string | null;
};

type CaioBrainFreshness = {
  status: string;
  observed_at: string;
  modified_at: string | null;
  age_seconds: number | null;
};

type CaioBrainPayloadMetadata = {
  content_type: string;
  size_bytes: number | null;
  sha256: string | null;
  snippet_chars: number;
  snippet_truncated: boolean;
  snippet_redacted: boolean;
  collection_count: number | null;
  recent_paths: string[];
};

type CaioBrainInventoryItem = {
  key: string;
  path: string | null;
  source: CaioBrainReadSource;
  exists: boolean;
  error_class: string | null;
  freshness: CaioBrainFreshness;
  payload_metadata: CaioBrainPayloadMetadata;
};

type CaioBrainProvenance = {
  store: string;
  key: string;
  observed_at: string;
  path: string | null;
  confidence: number | null;
};

type CaioBrainRead = {
  key: string;
  source: CaioBrainReadSource;
  provenance: CaioBrainProvenance;
  freshness: CaioBrainFreshness;
  payload_metadata: CaioBrainPayloadMetadata;
  path: string | null;
  snippet: string | null;
};

type CaioBrainAuditStatus = {
  status: "ok" | "error" | "timeout" | "unavailable";
  available: boolean;
  exit_code: number | null;
  error_class: string | null;
  script_path: string | null;
  stdout: string | null;
  stderr: string | null;
};

type CaioBrainLimits = {
  snippet_max_chars: number;
  collection_limit: number;
  audit_output_max_chars: number;
};

type CaioBrainStatusResponse = {
  status: CaioBridgeStatus;
  error_class: string | null;
  latency_ms: number;
  contract: CaioBrainContractSummary | null;
  inventory: CaioBrainInventoryItem[];
  reads: CaioBrainRead[];
  audit: CaioBrainAuditStatus | null;
  limits: CaioBrainLimits;
};

type ActiveTab = "think_loop" | "reflexion" | "whatsapp" | "brain";

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
  variant?: "default" | "bookmark_skip";
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
  skipDetails?: BookmarkSkipDetails;
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
  const proposalPayload = (pairedProposal?.payload ?? {}) as Record<
    string,
    unknown
  >;
  const badges: { label: string; tone: string }[] = [];
  const bookmarkCard = resolveBookmarkEvaluationCard({
    eventType: item.event_type,
    source: item.source,
    producerId: item.producer_id,
    payloads: [payload, pairedProposal?.payload],
    decisionKind: item.decision?.decision ?? null,
  });

  if (bookmarkCard?.kind === "skip") {
    badges.push({
      label: "bookmark",
      tone: "bg-red-100 text-red-800 border border-red-200",
    });
    return {
      variant: "bookmark_skip",
      title: "Bookmark descartado",
      body: "",
      badges,
      impact:
        "Item descartado. Nenhum campo de implementação, PR, branch ou testes é exibido neste card.",
      impactTone: "bg-red-100 text-red-800",
      skipDetails: bookmarkCard.details,
    };
  }

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
    const proposalText = asString(proposalPayload.action);
    const proposalRationale = asString(proposalPayload.rationale);

    const policySentence =
      `Caio classificou esta ação como '${actionType}' e a política decidiu ` +
      `${allowed ? "permitir" : "bloquear"}` +
      `${level ? ` no nível ${level}` : ""}` +
      `${mode ? `, ${modeMeaning(mode).label}` : ""}` +
      `${requiresApproval ? ", aguardando aprovação Pedro" : ""}.` +
      (hardRule ? `\nRegra dura disparada: ${hardRule}` : "");

    const levelLine =
      level && LEVEL_MEANING[level]
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
      body:
        pattern ??
        "(pattern não disponível neste resumo — abra a tab Reflexion)",
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

type EventCategory = "pedro" | "blocked" | "skip" | "history";

function categorize(
  item: CaioEventItem,
  pairedProposal?: CaioEventItem,
): EventCategory {
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const proposalPayload = (pairedProposal?.payload ?? {}) as Record<
    string,
    unknown
  >;
  const bookmarkCard = resolveBookmarkEvaluationCard({
    eventType: item.event_type,
    source: item.source,
    producerId: item.producer_id,
    payloads: [payload, pairedProposal?.payload],
    decisionKind: item.decision?.decision ?? null,
  });
  if (bookmarkCard?.kind === "skip") return "skip";

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
  skip: {
    label: "❌ Skip",
    tone: "bg-red-100 text-red-800",
    ring: "ring-1 ring-red-200",
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

function brainStatusMessage(
  status: CaioBridgeStatus,
  errorClass: string | null,
): string | null {
  switch (status) {
    case "ok":
      return null;
    case "disabled":
      return "BRAIN bridge disabled";
    case "timeout":
      return `BRAIN bridge timeout${errorClass ? `: ${errorClass}` : ""}`;
    case "error":
      return `BRAIN bridge error${errorClass ? `: ${errorClass}` : ""}`;
    case "circuit_open":
      return "BRAIN bridge circuit open";
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

function nullableText(value: string | null): string {
  return value ?? "null";
}

function formatBytes(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function formatSource(source: CaioBrainReadSource): string {
  const labels: Record<CaioBrainReadSource, string> = {
    runtime_contract: "runtime contract",
    local_runtime_contract: "local runtime contract",
    markdown_projection: "Markdown projection/cache",
    sqlite_store: "runtime store",
    structured_fact_store: "structured fact store",
    audit: "audit",
  };
  return labels[source];
}

function formatBool(value: boolean): string {
  return value ? "sim" : "não";
}

function brainTextMatches(query: string, values: Array<string | null>): boolean {
  if (!query) return true;
  return values.some((value) => value?.toLowerCase().includes(query));
}

function filteredRecentPaths(
  item: CaioBrainInventoryItem,
  query: string,
): string[] {
  const paths = item.payload_metadata.recent_paths;
  if (!query) return paths;
  return paths.filter((path) => path.toLowerCase().includes(query));
}

function BrainMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-indigo-100 text-indigo-700">
            {icon}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {label}
            </p>
            <div className="mt-1 break-words text-sm font-semibold text-slate-900">
              {value}
            </div>
            {detail ? (
              <div className="mt-1 break-words text-xs text-slate-500">
                {detail}
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BrainMetaRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-slate-800">{children}</dd>
    </div>
  );
}

function BrainPathList({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {paths.slice(0, 6).map((path) => (
        <li
          key={path}
          className="break-all rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-700"
          title={path}
        >
          {path}
        </li>
      ))}
    </ul>
  );
}

function BrainInventoryCard({
  item,
  recentPaths,
}: {
  item: CaioBrainInventoryItem;
  recentPaths: string[];
}) {
  const sourceTone = item.source === "sqlite_store" ? "success" : "outline";
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div className="min-w-0">
          <p className="break-all text-sm font-semibold text-slate-900">
            {item.key}
          </p>
          {item.path && item.path !== item.key ? (
            <p className="mt-1 break-all text-xs text-slate-500">
              {item.path}
            </p>
          ) : null}
        </div>
        <Badge variant={item.exists ? "success" : "danger"} className="shrink-0">
          {item.exists ? "online" : "missing"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3 pt-2 text-sm text-slate-700">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={sourceTone}>{formatSource(item.source)}</Badge>
          <span className="text-xs text-slate-500">
            fresh {formatAge(item.freshness.age_seconds)}
          </span>
          {item.payload_metadata.collection_count !== null ? (
            <span className="text-xs text-slate-500">
              {item.payload_metadata.collection_count} artefatos
            </span>
          ) : null}
        </div>
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <BrainMetaRow label="Content type">
            {item.payload_metadata.content_type}
          </BrainMetaRow>
          <BrainMetaRow label="Tamanho">
            {formatBytes(item.payload_metadata.size_bytes)}
          </BrainMetaRow>
          <BrainMetaRow label="Observado">
            {formatOccurredAt(item.freshness.observed_at)}
          </BrainMetaRow>
          <BrainMetaRow label="Modificado">
            {item.freshness.modified_at
              ? formatOccurredAt(item.freshness.modified_at)
              : "—"}
          </BrainMetaRow>
        </dl>
        <BrainPathList paths={recentPaths} />
        {item.error_class ? (
          <p className="break-all rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
            {item.error_class}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BrainReadCard({ read }: { read: CaioBrainRead }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge
            variant={read.source === "sqlite_store" ? "success" : "outline"}
          >
            {formatSource(read.source)}
          </Badge>
          <span className="break-all text-sm font-semibold text-slate-900">
            BrainRead · {read.key}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-2 text-sm text-slate-700">
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <BrainMetaRow label="Store">{read.provenance.store}</BrainMetaRow>
          <BrainMetaRow label="Freshness">
            {read.freshness.status} · {formatAge(read.freshness.age_seconds)}
          </BrainMetaRow>
          <BrainMetaRow label="Confidence">
            {read.provenance.confidence === null
              ? "—"
              : `${Math.round(read.provenance.confidence * 100)}%`}
          </BrainMetaRow>
          <BrainMetaRow label="Payload">
            {read.payload_metadata.content_type} ·{" "}
            {formatBytes(read.payload_metadata.size_bytes)}
          </BrainMetaRow>
        </dl>
        {read.provenance.path ? (
          <p className="break-all rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
            {read.provenance.path}
          </p>
        ) : null}
        {read.snippet ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              bounded projection snippet
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">
              {read.snippet}
            </p>
            <p className="mt-2 text-[11px] text-slate-500">
              Snippet auxiliar e limitado; não substitui BrainRead no runtime.
            </p>
          </div>
        ) : (
          <p className="rounded-md border border-indigo-200 bg-indigo-50 p-2 text-xs font-medium text-indigo-800">
            Runtime store disponível sem snippet Markdown.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SkipCardField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-red-700">{label}</dt>
      <dd className="mt-1 break-words text-sm text-red-950">{children}</dd>
    </div>
  );
}

export function BookmarkSkipFields({
  details,
}: {
  details: BookmarkSkipDetails;
}) {
  return (
    <dl className="mt-3 grid gap-3 rounded-md border border-red-200 bg-red-100/60 p-3">
      <SkipCardField label="Fonte">
        {details.sourceUrl ? (
          <a
            href={details.sourceUrl}
            title={details.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all font-medium text-red-800 underline underline-offset-2 hover:text-red-950"
          >
            {details.sourceUrl}
          </a>
        ) : (
          nullableText(details.sourceUrl)
        )}
      </SkipCardField>
      <SkipCardField label="Projeto inferido">
        {nullableText(details.inferredProject)}
      </SkipCardField>
      <SkipCardField label="Complexidade estimada">
        {nullableText(details.estimatedComplexity)}
      </SkipCardField>
      <SkipCardField label="Motivo do descarte">
        <span className="whitespace-pre-wrap">
          {nullableText(details.discardReason)}
        </span>
      </SkipCardField>
    </dl>
  );
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

  const [waResponse, setWaResponse] = useState<CaioWaApprovalsResponse | null>(
    null,
  );
  const [waLoading, setWaLoading] = useState<boolean>(false);
  const [waError, setWaError] = useState<string | null>(null);
  const [waDays, setWaDays] = useState<number>(7);

  const [brainResponse, setBrainResponse] =
    useState<CaioBrainStatusResponse | null>(null);
  const [brainLoading, setBrainLoading] = useState<boolean>(false);
  const [brainError, setBrainError] = useState<string | null>(null);
  const [brainFilter, setBrainFilter] = useState<string>("");

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

  const loadWa = useCallback(async (days: number) => {
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
  }, []);

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

  const loadBrain = useCallback(async () => {
    setBrainLoading(true);
    setBrainError(null);
    try {
      const result = await customFetch<{ data: CaioBrainStatusResponse }>(
        "/api/v1/caio/brain/status?limit=8",
        { method: "GET" },
      );
      setBrainResponse(result.data);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "Failed to load BRAIN status";
      setBrainError(msg);
    } finally {
      setBrainLoading(false);
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
                          discord_message_id: fresh.discord_message_id,
                          discord_channel_id: fresh.discord_channel_id,
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

  useEffect(() => {
    if (activeTab === "brain" && brainResponse === null) {
      void loadBrain();
    }
  }, [activeTab, brainResponse, loadBrain]);

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
    if (category === "skip") return "rejected";
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

  const brainBanner = brainResponse
    ? brainStatusMessage(brainResponse.status, brainResponse.error_class)
    : null;
  const brainQuery = brainFilter.trim().toLowerCase();
  const filteredInventory = (brainResponse?.inventory ?? [])
    .map((item) => ({
      item,
      recentPaths: filteredRecentPaths(item, brainQuery),
    }))
    .filter(({ item, recentPaths }) =>
      brainTextMatches(brainQuery, [
        item.key,
        item.path,
        item.source,
        item.error_class,
        item.payload_metadata.content_type,
        ...recentPaths,
      ]),
    );
  const filteredReads = (brainResponse?.reads ?? []).filter((read) =>
    brainTextMatches(brainQuery, [
      read.key,
      read.path,
      read.source,
      read.provenance.store,
      read.provenance.key,
      read.provenance.path,
      read.snippet,
      read.payload_metadata.content_type,
    ]),
  );
  const runtimeStore = (brainResponse?.inventory ?? []).find(
    (item) => item.source === "sqlite_store",
  );
  const braindumpInventory = (brainResponse?.inventory ?? []).find((item) =>
    item.key.toLowerCase().includes("braindump"),
  );
  const contactsInventory = (brainResponse?.inventory ?? []).find((item) =>
    /conta(?:ct|to)/.test(item.key.toLowerCase()),
  );
  const onlineArtifacts = (brainResponse?.inventory ?? []).filter(
    (item) => item.exists,
  ).length;
  const totalProjectionCount = (brainResponse?.inventory ?? []).reduce(
    (acc, item) => acc + (item.payload_metadata.collection_count ?? 0),
    0,
  );

  const onReload = (() => {
    if (activeTab === "brain") return loadBrain;
    if (activeTab === "reflexion") return loadCritiques;
    if (activeTab === "whatsapp") return () => loadWa(waDays);
    return load;
  })();
  const reloadDisabled =
    activeTab === "brain"
      ? brainLoading
      : activeTab === "reflexion"
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
          <TabsTrigger value="brain">BRAIN</TabsTrigger>
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
                  Histórico do que Caio já fez sozinho (escondido por padrão).
                  Concordo/Discordo aqui só vira feedback retrospectivo, não
                  muda nada agora.
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
                const isSkipCard = summary.variant === "bookmark_skip";
                return (
                  <Card
                    key={item.event_id}
                    className={`${categoryMeta.ring} ${
                      isHistory ? "opacity-80" : ""
                    } ${isSkipCard ? "border border-red-200 !bg-red-50" : ""}`}
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
                      {isSkipCard && summary.skipDetails ? (
                        <>
                          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-red-700">
                            <span aria-hidden="true">❌</span>
                            {summary.title}
                          </p>
                          <BookmarkSkipFields details={summary.skipDetails} />
                        </>
                      ) : (
                        <>
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            {summary.title}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">
                            {summary.body}
                          </p>
                        </>
                      )}
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
                      ) : category === "skip" ? (
                        <p className="mt-3 text-xs font-semibold text-red-700">
                          Descartado pelo avaliador de bookmarks. Sem decisão
                          operacional sua a tomar aqui.
                        </p>
                      ) : category === "blocked" ? (
                        <p className="mt-3 text-xs font-semibold text-rose-700">
                          Bloqueado pela política — Caio não executou nada. Sem
                          decisão sua a tomar aqui (apenas ciência).
                        </p>
                      ) : (
                        <p className="mt-3 text-xs text-slate-500">
                          Caio já decidiu sozinho (auto-executou em modo shadow
                          ou ignorou). Os botões abaixo são apenas marcador
                          retrospectivo: dão sinal pro Reflexion (loop semanal)
                          se você concorda com a decisão dele.
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
                        {decided?.discord_message_id ? (
                          // Fase A: decision was recorded by reacting in
                          // Discord #caio-aprovacoes. The Cockpit becomes a
                          // viewer — show a deep link instead of buttons.
                          (() => {
                            const guildId =
                              process.env.NEXT_PUBLIC_DISCORD_GUILD_ID ?? "@me";
                            const url =
                              decided.discord_channel_id &&
                              decided.discord_message_id
                                ? `https://discord.com/channels/${guildId}/${decided.discord_channel_id}/${decided.discord_message_id}`
                                : null;
                            const label =
                              decided.decision === "approve"
                                ? "Aprovado no Discord"
                                : "Rejeitado no Discord";
                            const tone =
                              decided.decision === "approve"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100";
                            const content = (
                              <>
                                {decided.decision === "approve" ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : (
                                  <XIcon className="h-3.5 w-3.5" />
                                )}
                                {label}
                                <span className="ml-1 text-xs opacity-70">
                                  ↗
                                </span>
                              </>
                            );
                            return url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${tone}`}
                              >
                                {content}
                              </a>
                            ) : (
                              <span
                                className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium ${tone}`}
                              >
                                {content}
                              </span>
                            );
                          })()
                        ) : category !== "blocked" && category !== "skip" ? (
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
                          {expanded
                            ? "Esconder detalhes"
                            : "Ver detalhes (JSON)"}
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
                            aprovado em {formatOccurredAt(decided.decided_at)} ·
                            aguardando Caio pegar
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
                Nenhum critique nos últimos 30 dias. Reflexion roda aos domingos
                18h (SP).
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

        <TabsContent value="brain">
          <div className="space-y-4">
            <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
              <p className="flex items-center gap-2 font-semibold">
                <HardDrive className="h-4 w-4 flex-shrink-0 text-indigo-700" />
                Runtime local-first é a fonte de verdade
              </p>
              <p className="mt-1 text-xs leading-5 text-indigo-900">
                Markdown é projeção/cache humano; não é a API primária de
                memória da IA.
              </p>
            </div>

            {brainBanner ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{brainBanner}</span>
              </div>
            ) : null}

            {brainError ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {brainError}
              </div>
            ) : null}

            {brainLoading && !brainResponse ? (
              <p className="text-sm text-slate-500">Carregando BRAIN…</p>
            ) : brainResponse ? (
              <>
                <div className="grid gap-3 md:grid-cols-4">
                  <BrainMetric
                    icon={<ShieldCheck className="h-4 w-4" />}
                    label="Bridge"
                    value={brainResponse.status}
                    detail={
                      brainResponse.error_class ??
                      `${brainResponse.latency_ms}ms`
                    }
                  />
                  <BrainMetric
                    icon={<FileText className="h-4 w-4" />}
                    label="Audit"
                    value={brainResponse.audit?.status ?? "unavailable"}
                    detail={
                      brainResponse.audit?.available
                        ? "brain-runtime-audit.sh disponível"
                        : "audit indisponível"
                    }
                  />
                  <BrainMetric
                    icon={<Database className="h-4 w-4" />}
                    label="Runtime store"
                    value={runtimeStore?.exists ? "online" : "missing"}
                    detail={
                      runtimeStore
                        ? formatSource(runtimeStore.source)
                        : "memory/main.sqlite não encontrado"
                    }
                  />
                  <BrainMetric
                    icon={<Brain className="h-4 w-4" />}
                    label="Artifacts"
                    value={`${onlineArtifacts}/${brainResponse.inventory.length}`}
                    detail={`${totalProjectionCount} projeções inventariadas`}
                  />
                </div>

                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          Contrato BRAIN
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Lido de BRAIN_RUNTIME.md; termos abaixo governam a
                          ponte read-only do Cockpit.
                        </p>
                      </div>
                      {brainResponse.contract ? (
                        <Badge variant="accent">
                          v{brainResponse.contract.contract_version}
                        </Badge>
                      ) : (
                        <Badge variant="danger">indisponível</Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-2 text-sm text-slate-700">
                    {brainResponse.contract ? (
                      <>
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <BrainMetaRow label="Runtime truth">
                            {brainResponse.contract.runtime_truth}
                          </BrainMetaRow>
                          <BrainMetaRow label="Markdown role">
                            {
                              brainResponse.contract
                                .human_markdown_projection_role
                            }
                          </BrainMetaRow>
                          <BrainMetaRow label="iCloud source">
                            {formatBool(
                              brainResponse.contract
                                .icloud_source_of_truth_allowed,
                            )}
                          </BrainMetaRow>
                          <BrainMetaRow label="Obsidian source">
                            {formatBool(
                              brainResponse.contract
                                .obsidian_source_of_truth_allowed,
                            )}
                          </BrainMetaRow>
                        </dl>
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Required terms
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {brainResponse.contract.required_terms.map(
                              (term) => (
                                <Badge key={term} variant="outline">
                                  {term}
                                </Badge>
                              ),
                            )}
                          </div>
                        </div>
                        <div className="grid gap-3 text-xs sm:grid-cols-2">
                          <BrainMetaRow label="Backup areas">
                            {brainResponse.contract.critical_backup_areas.join(
                              ", ",
                            ) || "—"}
                          </BrainMetaRow>
                          <BrainMetaRow label="Allowlist fields">
                            {brainResponse.contract.allowlist_required_fields.join(
                              ", ",
                            ) || "—"}
                            {brainResponse.contract.allowlist_date_format
                              ? ` · ${brainResponse.contract.allowlist_date_format}`
                              : ""}
                          </BrainMetaRow>
                        </div>
                      </>
                    ) : (
                      <p className="text-sm text-slate-500">
                        Contrato não disponível neste envelope. O Cockpit não
                        tenta inferir memória primária a partir de Markdown.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      Inventário e leituras
                    </p>
                    <p className="text-xs text-slate-500">
                      Filtro local read-only para paths, JIDs, stores e
                      snippets limitados.
                    </p>
                  </div>
                  <div className="relative w-full md:w-80">
                    <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
                    <Input
                      type="search"
                      aria-label="Filtrar inventário e leituras BRAIN"
                      value={brainFilter}
                      onChange={(event) => setBrainFilter(event.target.value)}
                      placeholder="Filtrar paths, JIDs, stores..."
                      className="pl-9"
                    />
                  </div>
                </div>

                {filteredInventory.length === 0 &&
                filteredReads.length === 0 ? (
                  <Card>
                    <CardContent className="py-6 text-sm text-slate-500">
                      Nenhum artefato BRAIN disponível para exibir.
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-sm font-semibold text-slate-900">
                          Artifact inventory
                        </h2>
                        {braindumpInventory ? (
                          <Badge variant="outline">
                            Braindump{" "}
                            {braindumpInventory.payload_metadata
                              .collection_count ?? 0}
                          </Badge>
                        ) : null}
                        {contactsInventory ? (
                          <Badge variant="outline">
                            Contacts{" "}
                            {contactsInventory.payload_metadata
                              .collection_count ?? 0}
                          </Badge>
                        ) : null}
                      </div>
                      {filteredInventory.length === 0 ? (
                        <Card>
                          <CardContent className="py-6 text-sm text-slate-500">
                            Nenhum item de inventário corresponde ao filtro.
                          </CardContent>
                        </Card>
                      ) : (
                        filteredInventory.map(({ item, recentPaths }) => (
                          <BrainInventoryCard
                            key={item.key}
                            item={item}
                            recentPaths={recentPaths}
                          />
                        ))
                      )}
                    </div>

                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-sm font-semibold text-slate-900">
                          BrainRead projections
                        </h2>
                        <Badge variant="outline">
                          {filteredReads.length} recentes
                        </Badge>
                      </div>
                      {filteredReads.length === 0 ? (
                        <Card>
                          <CardContent className="py-6 text-sm text-slate-500">
                            Nenhuma leitura corresponde ao filtro.
                          </CardContent>
                        </Card>
                      ) : (
                        filteredReads.map((read) => (
                          <BrainReadCard key={read.key} read={read} />
                        ))
                      )}
                    </div>
                  </div>
                )}

                <Card>
                  <CardHeader className="pb-2">
                    <p className="text-sm font-semibold text-slate-900">
                      Audit output
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-2 text-sm text-slate-700">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          brainResponse.audit?.status === "ok"
                            ? "success"
                            : brainResponse.audit?.status === "unavailable"
                              ? "outline"
                              : "danger"
                        }
                      >
                        {brainResponse.audit?.status ?? "unavailable"}
                      </Badge>
                      {brainResponse.audit?.exit_code !== null &&
                      brainResponse.audit?.exit_code !== undefined ? (
                        <span className="text-xs text-slate-500">
                          exit {brainResponse.audit.exit_code}
                        </span>
                      ) : null}
                    </div>
                    {brainResponse.audit?.script_path ? (
                      <p className="break-all rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-600">
                        {brainResponse.audit.script_path}
                      </p>
                    ) : null}
                    {brainResponse.audit?.stdout ? (
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800">
                        {brainResponse.audit.stdout}
                      </pre>
                    ) : (
                      <p className="text-sm text-slate-500">
                        Sem stdout de audit neste envelope.
                      </p>
                    )}
                    {brainResponse.audit?.stderr ? (
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
                        {brainResponse.audit.stderr}
                      </pre>
                    ) : null}
                    <p className="text-[11px] text-slate-500">
                      Limites: snippets {brainResponse.limits.snippet_max_chars}
                      chars · coleção {brainResponse.limits.collection_limit} ·
                      audit {brainResponse.limits.audit_output_max_chars} chars.
                    </p>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>
        </TabsContent>
      </Tabs>
    </DashboardPageLayout>
  );
}
