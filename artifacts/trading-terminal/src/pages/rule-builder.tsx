import React, { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  useListAccounts,
  useListMarkets,
  getListAutomationsQueryKey,
} from '@workspace/api-client-react';
import {
  Sparkles, Wand2, Plus, Trash2, Pencil, AlertTriangle, Zap, Loader2, Save, X,
} from 'lucide-react';
import { cn, formatCompactPrice } from '@/lib/utils';
import { RuleFields, BROKER_LABELS, type RuleValue } from '@/components/rule-fields';

const EXAMPLES = [
  'Buy 0.001 BTC-USDT when it drops to $58,000, market order',
  'Sell 0.5 ETH-USDT if it rises to $3,200 with a limit at $3,190',
  'Buy 10 SOL-USDT when price falls below $120 on paper',
];

interface BuilderStatus {
  configured: boolean;
  model: string;
  draftsPerHour: number;
  usedThisHour?: number;
  endpoint?: string;
  responseFormat?: string;
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((body as any)?.error ?? `HTTP ${res.status}`) as Error & { endpoint?: string };
    err.endpoint = (body as any)?.endpoint;
    throw err;
  }
  return body as any;
}

export default function RuleBuilder() {
  const queryClient = useQueryClient();
  const { data: automations } = useListAutomations({
    query: { queryKey: getListAutomationsQueryKey(), refetchInterval: 5000 },
  });
  const { data: accounts } = useListAccounts();
  const { data: markets } = useListMarkets();

  const createAuto = useCreateAutomation();
  const deleteAuto = useDeleteAutomation();

  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState<RuleValue | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [explanation, setExplanation] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiEndpoint, setAiEndpoint] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<BuilderStatus | null>(null);

  const loadStatus = () =>
    fetchJson('/api/rule-builder/status').then(setStatus).catch(() => setStatus(null));

  useEffect(() => {
    loadStatus();
  }, []);

  const brokerOptions = useMemo(() => {
    const connected = new Set<string>(['paper']);
    accounts?.filter(a => a.status === 'active').forEach(a => connected.add(a.exchange));
    return Array.from(connected);
  }, [accounts]);

  const resetMessages = () => {
    setAiError(null);
    setAiEndpoint(null);
    setSaveError(null);
    setSaved(false);
  };

  const build = async () => {
    resetMessages();
    if (prompt.trim().length < 3) {
      setAiError('Describe the rule first.');
      return;
    }
    setAiLoading(true);
    try {
      const result = await fetchJson('/api/rule-builder/draft', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          mode: editingId ? 'edit' : 'create',
          currentRule: editingId ? draft : undefined,
        }),
      });
      setDraft(result.rule);
      setExplanation(result.explanation ?? '');
      setWarnings(Array.isArray(result.warnings) ? result.warnings : []);
      loadStatus();
    } catch (err: any) {
      setAiError(err?.message ?? 'Rule builder unavailable.');
      setAiEndpoint(err?.endpoint ?? null);
    } finally {
      setAiLoading(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    resetMessages();

    const payload = {
      symbol: draft.symbol,
      condition: draft.condition,
      triggerPrice: Number(draft.triggerPrice),
      side: draft.side,
      quantity: Number(draft.quantity),
      orderType: draft.orderType,
      limitPrice: draft.orderType === 'limit' ? Number(draft.limitPrice) : undefined,
      broker: draft.broker,
    };

    try {
      if (editingId) {
        await fetchJson(`/api/automations/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() });
      } else {
        await createAuto.mutateAsync({ data: payload as any });
      }
      setSaved(true);
      setDraft(null);
      setEditingId(null);
      setPrompt('');
      setExplanation('');
      setWarnings([]);
    } catch (err: any) {
      setSaveError(err?.message ?? 'Could not save the rule.');
    }
  };

  const startEdit = (rule: any) => {
    resetMessages();
    setEditingId(rule.id);
    setDraft({
      symbol: rule.symbol,
      condition: rule.condition,
      triggerPrice: rule.triggerPrice,
      side: rule.side,
      quantity: rule.quantity,
      orderType: rule.orderType,
      limitPrice: rule.limitPrice,
      broker: rule.broker,
    });
    setPrompt('');
    setExplanation('');
    setWarnings([]);
  };

  const cancel = () => {
    setDraft(null);
    setEditingId(null);
    setPrompt('');
    setExplanation('');
    setWarnings([]);
    resetMessages();
  };

  return (
    <div className="flex flex-col gap-6 font-mono max-w-6xl mx-auto w-full">
      <div className="flex items-center justify-between border-b border-border pb-4 gap-3 flex-wrap">
        <h1 className="text-lg font-bold tracking-widest flex items-center gap-2">
          <Wand2 className="w-5 h-5 text-primary" />
          RULE BUILDER
        </h1>
        <div className="flex items-center gap-2">
          {status?.configured && status.usedThisHour !== undefined && (
            <span className="text-[10px] text-muted-foreground" title={status.endpoint}>
              {status.usedThisHour}/{status.draftsPerHour} DRAFTS THIS HOUR
            </span>
          )}
          <span
            className={cn('text-[10px] font-bold px-2 py-0.5 border',
              status?.configured ? 'text-up border-up/30 bg-up/10' : 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10')}
            title={status?.endpoint ? `Endpoint: ${status.endpoint}` : undefined}
          >
            {status ? (status.configured ? `AI READY · ${status.model}` : 'AI NOT CONFIGURED') : 'CHECKING…'}
          </span>
        </div>
      </div>

      {status && !status.configured && (
        <div className="p-3 border border-yellow-400/30 bg-yellow-400/5 text-[11px] text-yellow-400 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            AI drafting is offline. Set <code className="text-foreground">{(status as { keyEnv?: string } | null)?.keyEnv ?? 'OPENROUTER_API_KEY'}</code> in the API service
            environment to turn it on — you can still build a rule by hand below and save it normally.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Prompt */}
        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-bold tracking-widest text-muted-foreground">
            {editingId ? `EDIT RULE #${editingId}` : 'DESCRIBE THE RULE'}
          </h2>
          <div className="p-4 border border-border bg-card flex flex-col gap-3">
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={4}
              placeholder="e.g. buy 0.001 BTC-USDT when it drops to 58000"
              className="w-full bg-input border border-border text-foreground px-3 py-2 text-xs focus:outline-none focus:border-primary resize-none"
            />

            <div className="flex flex-wrap gap-1">
              {EXAMPLES.map(ex => (
                <button
                  key={ex}
                  onClick={() => setPrompt(ex)}
                  className="text-[10px] px-2 py-1 border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 max-w-full truncate"
                  title={ex}
                >
                  {ex.length > 46 ? `${ex.slice(0, 46)}…` : ex}
                </button>
              ))}
            </div>

            {aiError && (
              <div className="text-down text-[10px] p-2 bg-down/10 border border-down/30">
                <div>{aiError}</div>
                {aiEndpoint && (
                  <div className="text-muted-foreground mt-1">Endpoint: {aiEndpoint}</div>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={build}
                disabled={aiLoading}
                className="flex-1 py-2 text-xs font-bold tracking-widest bg-primary/20 text-primary border border-primary/50 hover:bg-primary/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {aiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {aiLoading ? 'DRAFTING…' : editingId ? 'APPLY WITH AI' : 'BUILD WITH AI'}
              </button>
              {editingId && (
                <button onClick={cancel} className="px-3 py-2 text-xs border border-border text-muted-foreground hover:text-foreground">
                  CANCEL
                </button>
              )}
            </div>

            {explanation && (
              <div className="text-[10px] text-muted-foreground border-t border-border pt-2 leading-relaxed">
                <span className="text-foreground font-bold">AI: </span>{explanation}
              </div>
            )}
            {warnings.map((w, i) => (
              <div key={i} className="text-[10px] text-yellow-400 flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}
              </div>
            ))}
          </div>

          {/* Existing rules */}
          <h2 className="text-xs font-bold tracking-widest text-muted-foreground mt-2">YOUR RULES</h2>
          <div className="flex flex-col gap-2">
            {automations?.length === 0 && (
              <div className="p-6 border border-dashed border-border text-center text-[11px] text-muted-foreground">
                NO RULES YET — DESCRIBE ONE ABOVE OR USE THE AUTOMATIONS PAGE
              </div>
            )}
            {automations?.map(rule => (
              <div key={rule.id} className="p-3 border border-border bg-card flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-xs font-bold flex flex-wrap items-center gap-1.5">
                    <span className={rule.side === 'buy' ? 'text-up' : 'text-down'}>{rule.side.toUpperCase()}</span>
                    <span>{rule.quantity}</span>
                    <span className="text-muted-foreground">{rule.symbol}</span>
                    <span className="text-muted-foreground font-normal">when</span>
                    <span className="text-yellow-400">
                      {rule.condition === 'gte' ? '≥' : '≤'} {formatCompactPrice(rule.triggerPrice)}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase">
                    {BROKER_LABELS[rule.broker] ?? rule.broker} · {rule.orderType} · {rule.status}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {rule.status === 'active' && (
                    <button
                      onClick={() => startEdit(rule)}
                      title="Edit with AI"
                      className="p-1.5 border border-border text-muted-foreground hover:text-primary hover:border-primary/40"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    onClick={() => deleteAuto.mutate({ id: rule.id }, {
                      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAutomationsQueryKey() }),
                    })}
                    title="Delete rule"
                    className="p-1.5 border border-border text-muted-foreground hover:text-down hover:border-down/40"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Draft editor */}
        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-bold tracking-widest text-muted-foreground">RULE DRAFT</h2>
          {!draft ? (
            <div className="p-8 border border-dashed border-border text-center text-[11px] text-muted-foreground flex flex-col items-center gap-2">
              <Zap className="w-5 h-5 text-muted-foreground/50" />
              DESCRIBE A RULE AND PRESS BUILD WITH AI — THE DRAFT APPEARS HERE FOR REVIEW BEFORE IT IS SAVED
            </div>
          ) : (
            <div className="p-4 border border-border bg-card flex flex-col gap-3">
              <RuleFields
                value={draft}
                onChange={patch => setDraft(d => (d ? { ...d, ...patch } : d))}
                symbols={markets ?? []}
                brokers={brokerOptions}
              />

              <div className="text-[10px] text-muted-foreground leading-relaxed border-t border-border pt-2">
                <AlertTriangle className="w-3 h-3 inline mb-0.5 mr-1" />
                Review before saving. Broker-bound rules are parked by the order-placement kill switch until the
                safety gateway ships; paper rules fill locally.
              </div>

              {saveError && (
                <div className="text-down text-[10px] p-2 bg-down/10 border border-down/30">{saveError}</div>
              )}

              <button
                onClick={save}
                disabled={createAuto.isPending}
                className="w-full py-2 text-xs font-bold tracking-widest bg-primary/20 text-primary border border-primary/50 hover:bg-primary/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Save className="w-3.5 h-3.5" />
                {createAuto.isPending ? 'SAVING…' : editingId ? 'SAVE CHANGES' : 'SAVE RULE'}
              </button>
              <button
                onClick={cancel}
                className="w-full py-1.5 text-[10px] tracking-widest border border-border text-muted-foreground hover:text-foreground flex items-center justify-center gap-2"
              >
                <X className="w-3 h-3" /> DISCARD DRAFT
              </button>
            </div>
          )}

          {saved && (
            <div className="p-2 border border-up/30 bg-up/10 text-up text-[10px] flex items-center gap-2">
              <Plus className="w-3 h-3" /> RULE SAVED
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
