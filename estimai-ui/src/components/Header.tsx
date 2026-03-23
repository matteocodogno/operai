import type { ChangeEvent } from "react";
import type { ProjectMeta } from "../types";

const NEW_PROJECT_VALUE = "__new__";

interface HeaderProps {
  name: string;
  author: string;
  projectId: string;
  projects: ProjectMeta[];
  showingList: boolean;
  onNameChange: (name: string) => void;
  onAuthorChange: (author: string) => void;
  onSwitchProject: (id: string) => void;
  onNewProject: () => void;
  onExport: () => void;
  onShowList: () => void;
  onHideList: () => void;
}

export default function Header({
  name,
  author,
  projectId,
  projects,
  showingList,
  onNameChange,
  onAuthorChange,
  onSwitchProject,
  onNewProject,
  onExport,
  onShowList,
  onHideList,
}: HeaderProps) {
  const handleProjectChange = (e: ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === NEW_PROJECT_VALUE) onNewProject();
    else onSwitchProject(e.target.value);
  };

  const currentInList = projects.some((p) => p.id === projectId);

  const logo = (
    <button
      onClick={showingList ? onHideList : onShowList}
      className="font-disp text-xl font-extrabold shrink-0 bg-[linear-gradient(130deg,#8b96ff,#2ec27e)] bg-clip-text text-transparent bg-transparent border-0 p-0 cursor-pointer"
      title={showingList ? "Back to editor" : "My Estimates"}
    >
      EstimAI
    </button>
  );

  const logoMobile = (
    <button
      onClick={showingList ? onHideList : onShowList}
      className="font-disp text-xl font-extrabold shrink-0 bg-[linear-gradient(130deg,#8b96ff,#2ec27e)] bg-clip-text text-transparent bg-transparent border-0 p-0 cursor-pointer"
      title={showingList ? "Back to editor" : "My Estimates"}
    >
      E
    </button>
  );

  if (showingList) {
    return (
      <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
        <div className="flex items-center gap-4 h-14">
          {logo}
          <span className="text-muted text-[11px] font-mono hidden sm:block">/ My Estimates</span>
          <div className="flex-1" />
          <button
            onClick={onHideList}
            className="text-muted text-sm py-1 px-3 border border-rule hover:text-text transition-colors hidden sm:block"
          >
            ← Back to editor
          </button>
        </div>
      </header>
    );
  }

  const projectSelect = (
    <select
      value={projectId}
      onChange={handleProjectChange}
      className="shrink-0 bg-ink-soft border border-rule rounded px-2 py-1 text-[13px] text-muted max-w-[180px]"
    >
      {!currentInList && (
        <option value={projectId}>{name || "Untitled"}</option>
      )}
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name || "Untitled"}
        </option>
      ))}
      <option value={NEW_PROJECT_VALUE}>＋ New project</option>
    </select>
  );

  return (
    <header className="bg-ink-soft border-b border-rule px-4 sticky top-0 z-10">
      {/* Desktop */}
      <div className="hidden sm:flex items-center gap-4 h-14">
        {logo}

        {projectSelect}

        <input
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
          placeholder="Project name…"
          className="flex-1 max-w-[320px] bg-transparent border-0 border-b border-rule rounded-none text-[14px] py-4 px-0"
        />
        <input
          value={author}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onAuthorChange(e.target.value)}
          placeholder="Author"
          className="w-30 shrink-0"
        />
        <button
          onClick={onShowList}
          className="text-muted text-sm py-1 px-2.5 border border-rule hover:text-text transition-colors shrink-0"
          title="My Estimates"
        >
          ☰
        </button>
        <button
          onClick={onExport}
          className="text-white py-1.75 px-3.75 font-medium shrink-0 flex items-center gap-1.5 bg-[linear-gradient(130deg,var(--color-acc),#3a4cd8)] shadow-[0_2px_10px_rgba(91,106,247,.4)]"
        >
          <span>↓</span> Export Excel
        </button>
      </div>

      {/* Mobile */}
      <div className="flex sm:hidden items-center gap-3 h-12">
        {logoMobile}

        <div className="flex-1 min-w-0">
          {projectSelect}
        </div>

        <button
          onClick={onShowList}
          className="text-muted w-9 h-9 shrink-0 flex items-center justify-center border border-rule hover:text-text transition-colors"
          aria-label="My Estimates"
        >
          ☰
        </button>
        <button
          onClick={onExport}
          aria-label="Export Excel"
          className="text-white w-9 h-9 shrink-0 flex items-center justify-center bg-[linear-gradient(130deg,var(--color-acc),#3a4cd8)] shadow-[0_2px_10px_rgba(91,106,247,.4)] rounded"
        >
          ↓
        </button>
      </div>
    </header>
  );
}
