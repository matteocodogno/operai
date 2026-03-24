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
    <div className="max-w-2xl">
      <h2 className="font-disp text-sm font-bold mb-4">Model Parameters</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch">
        {parameterFields.map(({ k, label, hint, step, max }) => (
          <div key={k} className="bg-ink-soft border border-rule rounded-[10px] py-[13px] px-4 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium mb-[2px]">{label}</div>
              <div className="text-[11px] text-muted">{hint}</div>
            </div>
            <input
              type="number"
              value={params[k]}
              min={0}
              max={max}
              step={step}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(k, e.target.value)}
              className="w-20 shrink-0 text-right text-sm font-mono bg-acc-lo border-acc text-acc-hi"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
