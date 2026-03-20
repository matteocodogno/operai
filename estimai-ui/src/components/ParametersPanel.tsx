import type { ChangeEvent } from "react";
import type { Parameters } from "../types";

interface ParametersPanelProps {
  params: Parameters;
  onUpdate: (key: keyof Parameters, value: string) => void;
}

export default function ParametersPanel({ params, onUpdate }: ParametersPanelProps) {
  const parameterFields = [
    { k:"parallelism" as const,       label:"Parallelism factor",                  hint:"% of work runnable in parallel with FTE > 1",      step:0.05, max:1 },
    { k:"sprintDays" as const,        label:"Sprint duration (working days)",       hint:"Drives planning/ceremony overhead calculation",    step:1 },
    { k:"workingDaysMonth" as const,  label:"Working days per month",              hint:"Converts elapsed days into months",                 step:1 },
    { k:"qaDeployDays" as const,      label:"QA Deploy per release (days)",        hint:"Fixed deployment cost per release",                 step:0.5 },
    { k:"qaTestDays" as const,        label:"QA Test per release (days)",          hint:"Fixed QA testing cost per release",                 step:0.5 },
    { k:"pmDays" as const,            label:"PM / Demand Mgmt per release (days)", hint:"Project management overhead per release",           step:0.5 },
    { k:"aiCostCoef" as const,        label:"AI cost coefficient",                  hint:"Cost per FTE per elapsed day (licences + infra). Default: 10.", step:1 },
    { k:"aiGain" as const,            label:"AI productivity gain",                 hint:"Fraction of effort saved using AI tools (0.0–1.0). Default: 0.30 = 30%.", step:0.05, max:1 },
  ];

  return (
    <div className="max-w-[520px]">
      <h2 className="font-disp text-sm font-bold mb-4">Model Parameters</h2>
      {parameterFields.map(({ k, label, hint, step, max })=>(
        <div key={k} className="bg-ink-soft border border-rule rounded-[10px] py-[13px] px-4 mb-[7px] flex items-center gap-3">
          <div className="flex-1">
            <div className="text-[13px] font-medium mb-[2px]">{label}</div>
            <div className="text-[11px] text-muted">{hint}</div>
          </div>
          <input
            type="number"
            value={params[k]}
            min={0}
            max={max}
            step={step}
            onChange={(e: ChangeEvent<HTMLInputElement>)=>onUpdate(k,e.target.value)}
            className="w-20 text-right text-sm font-mono bg-acc-lo border-acc text-acc-hi"
          />
        </div>
      ))}
      <div className="mt-[18px] py-3.5 px-4 bg-[rgba(91,106,247,0.07)] border border-[rgba(91,106,247,0.2)] rounded-[10px] text-xs text-soft leading-[1.9]">
        <strong className="text-acc-hi block mb-1.5">Calculation chain</strong>
        <div><strong>PERT</strong> = (O + 4×ML + P) / 6  <em className="text-muted">(intermediate — not used directly in Summary)</em></div>
        <div><strong>Expected</strong> = PERT + Risk Buffer</div>
        <div><strong>Individual M/D</strong> = Σ Expected + QA Deploy + QA Test + PM</div>
        <div><strong>Planning</strong> = FTE × (Individual / Sprint Duration) / 8</div>
        <div><strong>Baseline</strong> = Individual + Planning</div>
        <div><strong>Elapsed Days</strong> = ROUND(Baseline × (1 − Parallel × (FTE−1)/FTE))</div>
        <div><strong>Total Man/Days</strong> = Elapsed × FTE</div>
        <div><strong>AI-assisted days</strong> = Expected × (1 − AI Productivity Gain)  <em className="text-muted">(per activity in Detail)</em></div>
        <div><strong>AI-assisted Elapsed</strong> = same chain applied to AI-assisted days</div>
        <div><strong>AI Cost</strong> = Coefficient × FTE × Elapsed Days</div>
        <div><strong>Best / Worst</strong> = same chain using Optimistic / Pessimistic estimates</div>
      </div>
    </div>
  );
}
