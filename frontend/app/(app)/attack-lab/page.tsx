'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bug, ExternalLink, FlaskConical, Landmark, Link2, FileSignature, OctagonX, PlayCircle, Play, ShieldAlert, ShieldCheck, Store,
  Terminal,
} from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { Skeleton, Spinner, StateBlock } from '@/components/app/ui';
import { api, ApiError } from '@/lib/api';
import { useConfig } from '@/lib/config';
import type { AttackResult, ScenarioId } from '@/lib/shared';

const LAYERS = [
  { id: 'merchant', title: 'Proof of merchant', icon: Store },
  { id: 'intent', title: 'Proof of intent', icon: FileSignature },
  { id: 'settlement', title: 'Proof of settlement', icon: Landmark },
] as const;

/** O1 — real attacks against the deployed contracts; each one is stopped by the contract, not the server. */
export default function AttackLabPage() {
  const cfg = useConfig();
  const testMode = cfg.chainId !== 143;
  const [results, setResults] = useState<Record<string, AttackResult | { error: string }>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [all, setAll] = useState<{ done: number; total: number } | null>(null);
  const [broadcast, setBroadcast] = useState(false);

  const sc = useQuery({ queryKey: ['scenarios'], queryFn: api.attackScenarios, retry: 1 });
  const scenarios = sc.data?.scenarios ?? [];

  const run = async (id: ScenarioId) => {
    setRunning(id);
    try {
      const r = await api.attackRun(cfg.chainId, id, broadcast);
      setResults((m) => ({ ...m, [id]: r }));
    } catch (e) {
      setResults((m) => ({ ...m, [id]: { error: (e as ApiError).message } }));
    } finally {
      setRunning(null);
    }
  };

  const runAll = async () => {
    setAll({ done: 0, total: scenarios.length });
    for (let i = 0; i < scenarios.length; i++) {
      await run(scenarios[i]!.id);
      setAll({ done: i + 1, total: scenarios.length });
    }
    setAll(null);
  };

  const blocked = Object.values(results).filter((r) => 'outcome' in r && r.outcome === 'BLOCKED').length;
  const ran = Object.values(results).length;

  return (
    <AppShell title="Attack Lab" nav="customer" back="/app">
      <div className="col gap-s">
        <h1 className="display">Try to <span className="hl">break</span> it</h1>
        <p className="muted">Real attacks against the test network. Every one is stopped by the payment contract, not by our server.</p>
      </div>

      {!testMode ? (
        <StateBlock
          icon={FlaskConical}
          tone="warn"
          title="Attack Lab runs in Test mode"
          action={
            <button className="btn" onClick={() => { cfg.setChainId(cfg.chains.find((c) => c.chainId !== 143)?.chainId ?? 10143); }}>
              Switch to Test mode
            </button>
          }
        />
      ) : sc.isLoading ? (
        <><Skeleton h={80} /><Skeleton h={80} /></>
      ) : sc.error ? (
        <StateBlock icon={ShieldAlert} tone="bad" title="Can't reach the Attack Lab" message={(sc.error as Error).message} />
      ) : (
        <>
          <div className="card row between">
            <label className="row small" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={broadcast} onChange={(e) => setBroadcast(e.target.checked)} />
              <Link2 size={14} /> Record on-chain
            </label>
            <button className="btn neon" onClick={runAll} disabled={!!running || !!all}>
              {all ? <Spinner size={14} /> : <PlayCircle size={18} />} {all ? `${all.done}/${all.total}` : `Run all ${scenarios.length} attacks`}
            </button>
          </div>

          {ran > 0 && (
            <div className={`notice ${blocked === ran ? 'ok' : 'bad'}`}>
              {blocked === ran ? <ShieldCheck size={18} /> : <OctagonX size={18} />}
              <div><b>{blocked} of {ran} attacks blocked</b></div>
            </div>
          )}

          {LAYERS.map((layer) => {
            const list = scenarios.filter((s) => s.proofLayer === layer.id);
            if (!list.length) return null;
            return (
              <div key={layer.id} className="col">
                <div className="label row"><layer.icon size={14} /> {layer.title}</div>
                {list.map((s) => {
                  const r = results[s.id];
                  const full = r && 'outcome' in r ? r : null;
                  return (
                    <div key={s.id} className="card col gap-s">
                      <div className="row between">
                        <div className="h3">{s.title}</div>
                        <button className="btn sm" onClick={() => void run(s.id)} disabled={!!running || !!all}>
                          {running === s.id ? <Spinner size={14} /> : <Play size={14} />} Run attack
                        </button>
                      </div>
                      <div className="small row" style={{ alignItems: 'flex-start' }}><Bug size={14} style={{ flex: 'none', marginTop: 2 }} /> <span><b>Attack:</b> {s.attack}</span></div>
                      <div className="small row" style={{ alignItems: 'flex-start' }}><ShieldCheck size={14} style={{ flex: 'none', marginTop: 2 }} /> <span><b>Defense:</b> {s.defense}</span></div>
                      <div><span className="pill mono">{s.expectedError}</span></div>
                      {r && 'error' in r && <div className="notice bad"><ShieldAlert size={18} /><div>{r.error}</div></div>}
                      {full && (
                        <div className={`notice ${full.outcome === 'BLOCKED' ? 'ok' : 'bad'}`}>
                          {full.outcome === 'BLOCKED' ? <ShieldCheck size={18} /> : <OctagonX size={18} />}
                          <div>
                            <b>{full.outcome === 'BLOCKED' ? 'BLOCKED' : 'NOT BLOCKED'}</b>
                            <div className="mono">{full.observed.errorName ?? full.observed.apiCode ?? ''}</div>
                            <div className="small">{full.observed.message}</div>
                            <div className="tiny">{full.durationMs} ms</div>
                            {full.explorerUrl && (
                              <a className="link row small" href={full.explorerUrl} target="_blank" rel="noreferrer">
                                <ExternalLink size={13} /> View the failed attempt
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <p className="help row"><Terminal size={14} /> Each scenario is also a Foundry test in the repo (<span className="mono">backend/contracts/test/Attacks.t.sol</span>).</p>
        </>
      )}
    </AppShell>
  );
}
