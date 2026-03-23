import type { ProjectMeta } from "../types";

interface EstimatesScreenProps {
  projects: ProjectMeta[];
  currentId: string;
  onOpen: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
}

export default function EstimatesScreen({
  projects,
  currentId,
  onOpen,
  onDuplicate,
  onDelete,
  onNew,
}: EstimatesScreenProps) {
  const sorted = [...projects].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return (
    <div className="max-w-3xl mx-auto px-5 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-disp text-xl font-bold">My Estimates</h1>
        <button
          onClick={onNew}
          className="bg-acc text-white py-1.75 px-3.75 font-medium text-sm"
        >
          + New Estimate
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-16 text-muted text-sm">
          <div className="text-3xl mb-3 opacity-30">📋</div>
          <p>No estimates yet.</p>
          <button onClick={onNew} className="mt-4 text-acc underline text-sm">
            Create your first estimate
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((p) => (
            <div
              key={p.id}
              className={`flex items-center gap-4 px-4 py-3 rounded-md border ${
                p.id === currentId ? "border-acc bg-[rgba(91,106,247,.07)]" : "border-rule bg-ink-soft"
              }`}
            >
              {/* Info */}
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onOpen(p.id)}>
                <div className="text-sm font-medium truncate">{p.name || "Untitled"}</div>
                <div className="text-[11px] text-muted font-mono mt-0.5">
                  {p.author ? `${p.author} · ` : ""}{formatDate(p.updatedAt)}
                  {p.id === currentId && (
                    <span className="ml-2 text-acc font-semibold uppercase tracking-wide text-[9px]">current</span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => onOpen(p.id)}
                  className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-text hover:border-acc hover:text-acc transition-colors"
                >
                  Open
                </button>
                <button
                  onClick={() => onDuplicate(p.id)}
                  className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-muted hover:text-text transition-colors"
                  title="Duplicate"
                >
                  ⧉
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete "${p.name || "Untitled"}"? This cannot be undone.`)) {
                      onDelete(p.id);
                    }
                  }}
                  className="py-1 px-2.5 text-[11px] font-medium bg-ink border border-rule text-muted hover:text-red transition-colors"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
