import type { ChangeEvent } from "react";
import type { ProjectMeta } from "../types";

const NEW_PROJECT_VALUE = "__new__";

interface HeaderProps {
  name: string;
  author: string;
  projectId: string;
  projects: ProjectMeta[];
  onNameChange: (name: string) => void;
  onAuthorChange: (author: string) => void;
  onSwitchProject: (id: string) => void;
  onNewProject: () => void;
  onExport: () => void;
}

export default function Header({
  name,
  author,
  projectId,
  projects,
  onNameChange,
  onAuthorChange,
  onSwitchProject,
  onNewProject,
  onExport,
}: HeaderProps) {
  const handleProjectChange = (e: ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === NEW_PROJECT_VALUE) onNewProject();
    else onSwitchProject(e.target.value);
  };

  // If the current project isn't in the list yet (unsaved blank), still show it as selected
  const currentInList = projects.some((p) => p.id === projectId);

  return (
    <header className="bg-ink-soft border-b border-rule px-4 flex items-center gap-4 h-14 sticky top-0 z-10">
      <span className="font-disp text-xl font-extrabold shrink-0 bg-[linear-gradient(130deg,#8b96ff,#2ec27e)] bg-clip-text text-transparent">
        EstimAI
      </span>

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
        onClick={onExport}
        className="text-white py-1.75 px-3.75 font-medium shrink-0 flex items-center gap-1.5 bg-[linear-gradient(130deg,var(--color-acc),#3a4cd8)] shadow-[0_2px_10px_rgba(91,106,247,.4)]"
      >
        <span>↓</span> Export Excel
      </button>
    </header>
  );
}
