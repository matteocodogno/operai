import { useState } from "react";
import type { ChangeEvent } from "react";
import type { Parameters, Release, ReleaseSummary, Totals } from "../types";
import { type WarningCode } from "../lib/healthWarnings";
import FormulaPopover from "./FormulaPopover";
import WarningBadge from "./WarningBadge";

interface SummaryTableProps {
  summary: ReleaseSummary[];
  releases: Release[];
  totals: Totals;
  byProfile: [string, number][];
  params: Parameters;
  releaseWarnings: Map<string, WarningCode[]>;
  onUpdateRelease: (id: string, field: keyof Release, value: string | number) => void;
  onAddRelease: () => void;
  onDeleteRelease: (id: string) => void;
  /**
   * T17 (specs/013-estimate-sharing/tasks.md; design.md S5): fed from
   * context's single `canEdit` gate (`!canEdit`). Defaults to `false` so
   * every pre-existing call site keeps its exact prior full-edit behaviour.
   * Release name/FTE inputs become `readOnly` (not `disabled`); the
   * "+ Release" pill and each release's "×" delete button are absent.
   */
  readOnly?: boolean;
}

interface ThProps {
  children: React.ReactNode;
  right?: boolean;
  ai?: boolean;
  tip?: string;
}

function Th({ children, right, ai, tip }: ThProps) {
  return (
    <th className={`py-2 px-2.5 text-[9px] font-mono uppercase tracking-[0.06em] border-b border-rule bg-ink-mid whitespace-nowrap ${right ? "text-right" : "text-left"} ${ai ? "text-[#b47fff]/70" : "text-soft"}`}>
      <span className="inline-flex items-center gap-0.5">
        {children}
        {tip && <FormulaPopover text={tip} />}
      </span>
    </th>
  );
}

interface TdProps {
  children: React.ReactNode;
  right?: boolean;
  bold?: boolean;
  colorClass?: string;
  className?: string;
}

function Td({ children, right, bold, colorClass, className }: TdProps) {
  return (
    <td className={`py-2.5 px-2.5 font-mono text-xs ${right ? "text-right" : "text-left"} ${bold ? "font-semibold" : "font-normal"} ${colorClass ?? "text-text"} ${className ?? ""}`}>
      {children}
    </td>
  );
}

export default function SummaryTable({ summary, releases, totals, params, byProfile, releaseWarnings, onUpdateRelease, onAddRelease, onDeleteRelease, readOnly = false }: SummaryTableProps) {
  const [showAI, setShowAI] = useState(false)

  return (
    <>
      <div className="flex gap-2.5 mb-[18px] flex-wrap items-center">
        <h2 className="font-disp text-sm font-bold mr-2">Release Summary</h2>
        {releases.map(rel => {
          const ws = releaseWarnings.get(rel.id)
          return (
          <div key={rel.id} className={`bg-ink-soft border rounded-[10px] py-[9px] px-[13px] flex items-center gap-[9px] ${ws?.length ? 'border-org/40' : 'border-rule'}`}>
            <input
              value={rel.name}
              readOnly={readOnly}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRelease(rel.id, "name", e.target.value)}
              className="w-[106px] text-xs font-medium"
            />
            <span className="text-[10px] text-muted">FTE</span>
            <input
              type="number"
              value={rel.fte}
              readOnly={readOnly}
              min={1}
              step={1}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRelease(rel.id, "fte", e.target.value)}
              className="w-11 text-right"
            />
            {ws?.map(code => (
              <WarningBadge key={code} code={code} className="text-[11px]" />
            ))}
            {!readOnly && releases.length > 1 && (
              <button onClick={() => onDeleteRelease(rel.id)} className="bg-transparent text-muted text-sm">×</button>
            )}
          </div>
        )})}
        {!readOnly && (
          <button onClick={onAddRelease} className="bg-transparent text-soft py-[9px] px-[13px] border border-dashed border-rule rounded-[10px] text-xs">
            + Release
          </button>
        )}

        <div className="flex-1" />

        <button
          onClick={() => setShowAI(v => !v)}
          className={`flex items-center gap-1.5 py-[7px] px-3 text-[11px] border rounded transition-colors ${
            showAI
              ? 'border-[#b47fff]/50 text-[#b47fff] bg-[#b47fff]/8'
              : 'border-rule text-muted hover:text-soft hover:border-soft/40'
          }`}
        >
          <span className="text-[10px]">{showAI ? '✦' : '✦'}</span>
          {showAI ? 'Hide AI comparison' : 'Show AI comparison'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="text-xs w-full" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            {((): React.ReactNode => {
              const frBase = [2, 0.5, 1, 1, 1, 1, 1, 0.8, 0.8, 0.8, 1]
              const frAI   = [1, 1, 1]
              const cols   = showAI ? [...frBase, ...frAI] : frBase
              const total  = cols.reduce((a, b) => a + b, 0)
              return cols.map((fr, i) => (
                <col key={i} style={{ width: `${(fr / total * 100).toFixed(2)}%` }} />
              ))
            })()}
          </colgroup>
          <thead>
            <tr>
              <Th>Release</Th>
              <Th right tip="Number of people working on this release in parallel.">FTE</Th>
              <Th right tip="Sum of Expected effort (PERT + risk buffer) for all activities, plus QA and PM overhead.">Ind. M/D</Th>
              <Th right tip="Sprint coordination cost: FTE × (Ind. M/D ÷ Sprint duration) ÷ 8.">Planning</Th>
              <Th right tip="Total effort before parallelism adjustment: Ind. M/D + Planning days.">Baseline</Th>
              <Th right tip="Calendar days after team parallelism: ROUND(Baseline × (1 − parallelism × (FTE−1) / FTE)).">Elapsed d</Th>
              <Th right tip="Total person-days of effort: Elapsed days × FTE.">Total M/D</Th>
              <Th right tip="Rough calendar duration: Elapsed days ÷ working days per month.">Months</Th>
              <Th right tip="Best-case elapsed days — full pipeline run on Optimistic (O) estimates only.">Best</Th>
              <Th right tip="Worst-case elapsed days — full pipeline run on Pessimistic (P) estimates only.">Worst</Th>
              <Th right tip="Spread between best and worst case. Wide range signals high estimation uncertainty.">Range</Th>
              {showAI && <>
                <Th right ai tip="Estimated AI tooling cost: AI cost coefficient × FTE × Elapsed days.">AI Cost</Th>
                <Th right ai tip="Elapsed days after reducing each activity's expected effort by the AI productivity gain.">AI-assisted d</Th>
                <Th right ai tip="Total person-days with AI assistance: AI-assisted elapsed × FTE.">Total M/D (AI)</Th>
              </>}
            </tr>
          </thead>
          <tbody>
            {summary.map((s, idx) => {
              const ws = releaseWarnings.get(s.id)
              return (
              <tr key={s.id} className={`border-b border-rule ${idx % 2 === 0 ? "bg-ink-soft" : "bg-ink"}`}>
                <Td>
                  <span className="flex items-center gap-1.5">
                    {s.name}
                    {ws?.map(code => (
                      <WarningBadge key={code} code={code} className="text-[11px]" />
                    ))}
                  </span>
                </Td>
                <Td right colorClass="text-soft">{s.fte}</Td>
                {s.res ? (
                  <>
                    <Td right>{s.res.ind}</Td>
                    <Td right colorClass="text-soft">{s.res.plan.toFixed(1)}</Td>
                    <Td right colorClass="text-soft">{s.res.base}</Td>
                    <Td right bold colorClass="text-acc-hi">
                      {s.res.el}
                      <FormulaPopover text={[
                        `Ind. ${s.res.ind} d + Planning ${s.res.plan.toFixed(1)} d = Baseline ${s.res.base} d`,
                        `ROUND(${s.res.base} × (1 − ${params.parallelism} × ${s.fte - 1}/${s.fte} FTE)) = ${s.res.el} d`,
                      ].join('\n')} />
                    </Td>
                    <Td right bold>{s.res.tm}</Td>
                    <Td right colorClass="text-grn">{s.res.mo}</Td>
                    <Td right colorClass="text-grn">{s.res.best}</Td>
                    <Td right colorClass="text-red">{s.res.worst}</Td>
                    <td className="py-2.5 px-2.5 text-right">
                      <span className="font-mono text-[11px] bg-[rgba(245,166,35,0.12)] text-org py-[3px] px-[7px] rounded">
                        {s.res.best}–{s.res.worst}d
                      </span>
                    </td>
                    {showAI && <>
                      <Td right bold colorClass="text-[#b47fff]">{s.res.aiCost.toLocaleString()}</Td>
                      <Td right bold colorClass="text-[#b47fff]">
                        {s.res.aiElapsed}
                        <FormulaPopover text={[
                          `Expected ${s.res.sumExp} d × (1 − ${Math.round(params.aiGain * 100)}% AI gain) = ${s.res.sumAiExp} d`,
                          `Same pipeline → ${s.res.aiElapsed} d elapsed  (saves ${s.res.el - s.res.aiElapsed} d vs ${s.res.el} d standard)`,
                        ].join('\n')} />
                      </Td>
                      <Td right bold colorClass="text-[#b47fff]">{s.res.aiTotalMD}</Td>
                    </>}
                  </>
                ) : (
                  <td colSpan={showAI ? 12 : 9} className="py-2.5 px-2.5 text-center text-muted text-[11px] italic">
                    No activities assigned
                  </td>
                )}
              </tr>
            )})}
            <tr className="bg-ink-mid border-t-2 border-acc">
              <td className="py-2.5 px-2.5 font-disp font-bold text-[11px]">TOTAL</td>
              <td />
              <Td right bold>{totals.ind.toFixed(1)}</Td>
              <td />
              <Td right bold>{totals.base.toFixed(1)}</Td>
              <Td right bold colorClass="text-acc-hi" className="text-sm">{totals.el}</Td>
              <Td right bold className="text-sm">{totals.tm}</Td>
              <Td right bold colorClass="text-grn">{totals.mo}</Td>
              <Td right bold colorClass="text-grn">{totals.best}</Td>
              <Td right bold colorClass="text-red">{totals.worst}</Td>
              <td className="py-2.5 px-2.5 text-right">
                <span className="font-mono text-xs bg-[rgba(245,166,35,0.15)] text-org py-1 px-[9px] rounded font-semibold">
                  {totals.best}–{totals.worst}d
                </span>
              </td>
              {showAI && <>
                <Td right bold colorClass="text-[#b47fff]" className="text-sm">{totals.aiCost.toLocaleString()}</Td>
                <Td right bold colorClass="text-[#b47fff]" className="text-sm">{totals.aiElapsed}</Td>
                <Td right bold colorClass="text-[#b47fff]" className="text-sm">{totals.aiTotalMD}</Td>
              </>}
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className="font-disp text-sm font-bold mt-6 mb-2.5">By Specialist Profile</h2>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        {byProfile.map(([prof, days]) => (
          <div key={prof} className="bg-ink-soft border border-rule rounded-[10px] py-[11px] px-[15px]">
            <div className="text-[10px] text-soft mb-1">{prof}</div>
            <div className="font-mono text-[19px] text-acc-hi">
              {days.toFixed(1)}<span className="text-[10px] text-muted ml-[3px]">days</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
