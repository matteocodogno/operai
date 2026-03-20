import { useCallback, useState } from "react";
import * as XLSX from "xlsx";
import Header from "./components/Header";
import MetricsBar from "./components/MetricsBar";
import ActivityTable from "./components/ActivityTable";
import SummaryTable from "./components/SummaryTable";
import ParametersPanel from "./components/ParametersPanel";
import type { Activity, Parameters, Release } from "./types";
import { deriveOP, pertCalc, useEstimator } from "./hooks/useEstimator";


function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

const DEF_PARAMS: Parameters = {
  parallelism: 0.7,
  sprintDays: 10,
  workingDaysMonth: 20,
  qaDeployDays: 0,
  qaTestDays: 0,
  pmDays: 0,
  aiCostCoef: 10,
  aiGain: 0.30,
};
const DEF_RELEASES: Release[] = [{id: uid(), name: "Release 1", fte: 1}, {id: uid(), name: "Release 2", fte: 1}];
const DEF_ACTS: Activity[] = [
  {
    id: uid(),
    num: "1.1",
    epic: "Auth",
    act: "Login flow",
    prof: "Backend Dev",
    o: 3.75,
    ml: 5,
    p: 8,
    risk: 0,
    notes: "",
    release: "Release 1",
  },
  {
    id: uid(),
    num: "1.2",
    epic: "Auth",
    act: "OAuth setup",
    prof: "Backend Dev",
    o: 6,
    ml: 8,
    p: 13,
    risk: 2,
    notes: "3rd party dep",
    release: "Release 1",
  },
  {
    id: uid(),
    num: "1.3",
    epic: "UI Shell",
    act: "Navigation",
    prof: "Frontend Dev",
    o: 3,
    ml: 4,
    p: 6,
    risk: 0,
    notes: "",
    release: "Release 1",
  },
  {
    id: uid(),
    num: "2.1",
    epic: "Dashboard",
    act: "Main view",
    prof: "Frontend Dev",
    o: 7.5,
    ml: 10,
    p: 16,
    risk: 0,
    notes: "",
    release: "Release 2",
  },
  {
    id: uid(),
    num: "2.2",
    epic: "Dashboard",
    act: "API endpoints",
    prof: "Developer",
    o: 4.5,
    ml: 6,
    p: 9.6,
    risk: 1,
    notes: "Awaiting spec",
    release: "Release 2",
  },
];

export default function App() {
  const [tab, setTab] = useState<"activities" | "summary" | "parameters">("activities");
  const [name, setName] = useState("My Software Project");
  const [author, setAuthor] = useState("");
  const [params, setParams] = useState<Parameters>(DEF_PARAMS);
  const [releases, setRels] = useState<Release[]>(DEF_RELEASES);
  const [acts, setActs] = useState<Activity[]>(DEF_ACTS);

  const rnames = releases.map(r => r.name);
  const {summary, totals, byProfile} = useEstimator(acts, releases, params);

  const updAct = (id: string, f: keyof Activity, v: string) => setActs(prev => prev.map(a => {
    if (a.id!==id) return a;
    const u = {...a, [f]: v};
    if (f==="ml") {
      const d = deriveOP(Number(v));
      u.o = d.o;
      u.p = d.p;
    }
    return u;
  }));
  const addAct = () => setActs(prev => [...prev, {
    id: uid(),
    num: "",
    epic: "",
    act: "New activity",
    prof: "Developer",
    o: 3.75,
    ml: 5,
    p: 8,
    risk: 0,
    notes: "",
    release: rnames[0] || "Release 1",
  }]);
  const delAct = (id: string) => setActs(prev => prev.filter(a => a.id!==id));
  const updRel = (id: string, f: keyof Release, v: string | number) => setRels(prev => prev.map(r => r.id===id ? {
    ...r,
    [f]: v,
  }:r));
  const addRel = () => setRels(prev => [...prev, {id: uid(), name: `Release ${prev.length + 1}`, fte: 1}]);
  const delRel = (id: string) => setRels(prev => prev.filter(r => r.id!==id));
  const updP = (k: keyof Parameters, v: string) => setParams(prev => ({...prev, [k]: parseFloat(v) || 0}));

  const exportXLSX = useCallback(() => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Parameter", "Value"], ["Project", name], ["Author", author], ["Date", new Date().toLocaleDateString()], [],
      ["Parallelism factor", params.parallelism], ["Sprint duration (days)", params.sprintDays],
      ["Working days / month", params.workingDaysMonth], ["QA Deploy per release", params.qaDeployDays],
      ["QA Test per release", params.qaTestDays], ["PM overhead per release", params.pmDays],
    ]), "Parameters");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["#", "Epic", "Activity", "Profile", "Optimistic", "Most Likely", "Pessimistic", "PERT", "Risk Buffer", "Expected", "Notes", "Release"],
      ...acts.map(a => {
        const pv = pertCalc(a.o, a.ml, a.p);
        return [a.num, a.epic, a.act, a.prof, +a.o, +a.ml, +a.p, +pv.toFixed(1), +a.risk, +(pv + (Number(a.risk) || 0)).toFixed(1), a.notes, a.release];
      }),
    ]), "Detail");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Release", "FTE", "Ind. M/D", "Planning", "Baseline", "Elapsed Days", "Total M/D", "Months", "Best", "Worst", "Range", "AI Cost", "AI-assisted Elapsed", "Total M/D (AI)"],
      ...summary.map(s => s.res
        ? [s.name, s.fte, s.res.ind, s.res.plan, s.res.base, s.res.el, s.res.tm, s.res.mo, s.res.best, s.res.worst, `${s.res.best}–${s.res.worst} days`, s.res.aiCost, s.res.aiElapsed, s.res.aiTotalMD]
        :[s.name, s.fte, ...Array(12).fill("—")],
      ),
      ["TOTAL", "", totals.ind.toFixed(1), "", totals.base.toFixed(1), totals.el, totals.tm, totals.mo, totals.best, totals.worst, `${totals.best}–${totals.worst} days`, totals.aiCost, totals.aiElapsed, totals.aiTotalMD],
    ]), "Summary");
    XLSX.writeFile(wb, `${name.replace(/\s+/g, "_")}_estimate.xlsx`);
  }, [acts, summary, totals, params, name, author]);

  return (
    <div className="min-h-full w-full">
      <Header
        name={name}
        author={author}
        onNameChange={setName}
        onAuthorChange={setAuthor}
        onExport={exportXLSX}
      />

      <MetricsBar
        totals={totals}
        activityCount={acts.length}
        releaseCount={releases.length}
        profileCount={byProfile.length}
      />

      {/* Tabs */}
      <div className="flex gap-px px-5.5 pt-2.5 pb-0 border-b border-rule bg-ink-soft">
        {([["activities", "Activities"], ["summary", "Summary"], ["parameters", "Parameters"]] as const).map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`py-1.75 px-3.5 rounded-t-md rounded-b-none transition-all ${
              tab===k
                ? "bg-acc text-white font-medium border-b-2 border-acc"
                :"bg-transparent text-muted font-normal border-b-2 border-transparent"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      <main className="flex-1 p-5 px-5.5 overflow-x-auto">
        {tab==="activities" && (
          <ActivityTable
            activities={acts}
            releaseNames={rnames}
            onUpdate={updAct}
            onDelete={delAct}
            onAdd={addAct}
          />
        )}

        {tab==="summary" && (
          <SummaryTable
            summary={summary}
            releases={releases}
            totals={totals}
            byProfile={byProfile}
            onUpdateRelease={updRel}
            onAddRelease={addRel}
            onDeleteRelease={delRel}
          />
        )}

        {tab==="parameters" && (
          <ParametersPanel
            params={params}
            onUpdate={updP}
          />
        )}
      </main>
    </div>
  );
}
