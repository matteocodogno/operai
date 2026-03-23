import { useCallback, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import Header from "./components/Header";
import MetricsBar from "./components/MetricsBar";
import ActivityTable from "./components/ActivityTable";
import SummaryTable from "./components/SummaryTable";
import ParametersPanel from "./components/ParametersPanel";
import { pertCalc } from "./hooks/useEstimator";
import { useEstimatorContext } from "./context/EstimatorContext";

export default function App() {
  const [tab, setTab] = useState<"activities" | "summary" | "parameters">("activities");

  const {
    projectId, projects,
    name, author, params, releases, acts,
    summary, totals, byProfile,
    setName, setAuthor,
    updAct, addAct, delAct, reorderActs,
    updRel, addRel, delRel,
    updP,
    switchProject, newProject,
  } = useEstimatorContext();

  const rnames = useMemo(() => releases.map((r) => r.name), [releases]);

  const exportXLSX = useCallback(() => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Parameter", "Value"], ["Project", name], ["Author", author], ["Date", new Date().toLocaleDateString()], [],
      ["Parallelism factor", params.parallelism], ["Sprint duration (days)", params.sprintDays],
      ["Working days / month", params.workingDaysMonth], ["QA Deploy per release", params.qaDeployDays],
      ["QA Test per release", params.qaTestDays], ["PM overhead per release", params.pmDays],
    ]), "Parameters");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["#", "Epic", "Activity", "Profile", "Optimistic", "Most Likely", "Pessimistic", "PERT", "Risk Buffer", "Expected", "AI Gain %", "Notes", "Release"],
      ...acts.map((a) => {
        const pv = pertCalc(a.o, a.ml, a.p);
        const actGain = (a.aiGain !== undefined && a.aiGain !== null && (a.aiGain as unknown as string) !== "")
          ? Number(a.aiGain)
          : params.aiGain;
        return [a.num, a.epic, a.act, a.prof, +a.o, +a.ml, +a.p, +pv.toFixed(1), +a.risk, +(pv + (Number(a.risk) || 0)).toFixed(1), Math.round(actGain * 100), a.notes, a.release];
      }),
    ]), "Detail");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Release", "FTE", "Ind. M/D", "Planning", "Baseline", "Elapsed Days", "Total M/D", "Months", "Best", "Worst", "Range", "AI Cost", "AI-assisted Elapsed", "Total M/D (AI)"],
      ...summary.map((s) => s.res
        ? [s.name, s.fte, s.res.ind, s.res.plan, s.res.base, s.res.el, s.res.tm, s.res.mo, s.res.best, s.res.worst, `${s.res.best}–${s.res.worst} days`, s.res.aiCost, s.res.aiElapsed, s.res.aiTotalMD]
        : [s.name, s.fte, ...Array(12).fill("—")],
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
        projectId={projectId}
        projects={projects}
        onNameChange={setName}
        onAuthorChange={setAuthor}
        onSwitchProject={switchProject}
        onNewProject={newProject}
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
              tab === k
                ? "bg-acc text-white font-medium border-b-2 border-acc"
                : "bg-transparent text-muted font-normal border-b-2 border-transparent"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      <main className="flex-1 p-5 px-5.5 overflow-x-auto">
        {tab === "activities" && (
          <ActivityTable
            activities={acts}
            releaseNames={rnames}
            globalAiGain={params.aiGain}
            onUpdate={updAct}
            onDelete={delAct}
            onAdd={addAct}
            onAddRelease={addRel}
            onReorder={reorderActs}
          />
        )}

        {tab === "summary" && (
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

        {tab === "parameters" && (
          <ParametersPanel
            params={params}
            onUpdate={updP}
          />
        )}
      </main>
    </div>
  );
}
