import { memo, useMemo, useState, type ChangeEvent } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type Activity, PROFILES } from "../types";
import { computeActivityNums } from "../lib/activityNums";

interface ActivityTableProps {
  activities: Activity[];
  releaseNames: string[];
  globalAiGain: number;
  onUpdate: (id: string, field: keyof Activity, value: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onAddRelease: () => string;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

function pertCalc(o: number, ml: number, p: number): number {
  return ((Number(o)||0) + 4*(Number(ml)||0) + (Number(p)||0)) / 6;
}

const COL_W = "18px 44px 90px 108px 108px 58px 58px 58px 58px 58px 62px 58px 124px 106px 26px";
const RIGHT_COLS = new Set(["o", "ml", "p", "pert", "risk", "expected", "aiGain"]);

const columnHelper = createColumnHelper<Activity>();

const NEW_RELEASE_SENTINEL = "__new__";

// Sortable row wrapper
function SortableRow({
  id,
  children,
  className,
  style,
}: {
  id: string;
  children: React.ReactNode;
  className: string;
  style: React.CSSProperties;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const rowStyle: React.CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative",
    zIndex: isDragging ? 1 : "auto",
  };

  return (
    <div ref={setNodeRef} style={rowStyle} className={className}>
      {/* Drag handle — passed via context to the handle cell */}
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="flex items-center justify-center cursor-grab active:cursor-grabbing text-muted hover:text-soft select-none touch-none"
        style={{ fontSize: 14 }}
        title="Drag to reorder"
      >
        ⠿
      </div>
      {children}
    </div>
  );
}

const ActivityTable = memo(function ActivityTable({
  activities,
  releaseNames,
  globalAiGain,
  onUpdate,
  onDelete,
  onAdd,
  onAddRelease,
  onReorder,
}: ActivityTableProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const [collapsedEpics, setCollapsedEpics] = useState<Set<string>>(new Set());

  function toggleEpic(epicKey: string) {
    setCollapsedEpics(prev => {
      const next = new Set(prev);
      if (next.has(epicKey)) next.delete(epicKey);
      else next.add(epicKey);
      return next;
    });
  }

  const activityNums = useMemo(() => computeActivityNums(activities), [activities]);

  const columns: ColumnDef<Activity, any>[] = useMemo(() => [
    columnHelper.display({
      id: "num",
      header: "#",
      cell: (info) => (
        <div className="font-mono text-[10px] text-muted text-center select-none">
          {activityNums.get(info.row.original.id) ?? ''}
        </div>
      ),
    }),
    columnHelper.accessor("epic", {
      header: "Epic",
      cell: (info) => (
        <input
          value={info.getValue()}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(info.row.original.id, "epic", e.target.value)}
          placeholder="Epic…"
          className="py-0.75 px-1.25 text-[11px]"
        />
      ),
    }),
    columnHelper.accessor("act", {
      header: "Activity",
      cell: (info) => (
        <input
          value={info.getValue()}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(info.row.original.id, "act", e.target.value)}
          placeholder="Activity…"
          className="py-0.75 px-1.25 text-xs"
        />
      ),
    }),
    columnHelper.accessor("prof", {
      header: "Profile",
      cell: (info) => (
        <select
          value={info.getValue()}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => onUpdate(info.row.original.id, "prof", e.target.value)}
          className="py-0.75 px-1.25 text-[11px]"
        >
          {PROFILES.map(p => <option key={p}>{p}</option>)}
        </select>
      ),
    }),
    columnHelper.accessor("o", {
      header: "O",
      cell: (info) => (
        <input
          type="number"
          value={info.getValue()}
          step={0.5}
          min={0}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(info.row.original.id, "o", e.target.value)}
          className="text-right py-0.75 px-1.25 text-grn text-xs"
        />
      ),
    }),
    columnHelper.accessor("ml", {
      header: "ML",
      cell: (info) => (
        <input
          type="number"
          value={info.getValue()}
          step={0.5}
          min={0}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(info.row.original.id, "ml", e.target.value)}
          className="text-right py-0.75 px-1.25 text-xs"
        />
      ),
    }),
    columnHelper.accessor("p", {
      header: "P",
      cell: (info) => (
        <input
          type="number"
          value={info.getValue()}
          step={0.5}
          min={0}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(info.row.original.id, "p", e.target.value)}
          className="text-right py-0.75 px-1.25 text-red text-xs"
        />
      ),
    }),
    columnHelper.display({
      id: "pert",
      header: "PERT",
      cell: (info) => {
        const row = info.row.original;
        return (
          <div className="text-right font-mono text-xs text-acc-hi pr-0.75">
            {pertCalc(row.o, row.ml, row.p).toFixed(1)}
          </div>
        );
      },
    }),
    columnHelper.accessor("risk", {
      header: "Risk",
      cell: (info) => {
        const risky = Number(info.getValue()) > 0;
        return (
          <input
            type="number"
            value={info.getValue()}
            step={0.5}
            min={0}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(info.row.original.id, "risk", e.target.value)}
            className={`text-right py-0.75 px-1.25 text-xs ${risky ? "text-org" : "text-text"}`}
          />
        );
      },
    }),
    columnHelper.display({
      id: "expected",
      header: "Exp.",
      cell: (info) => {
        const row = info.row.original;
        const exp = pertCalc(row.o, row.ml, row.p) + (Number(row.risk)||0);
        return (
          <div className="text-right font-mono text-[13px] font-semibold pr-0.75">
            {exp.toFixed(1)}
          </div>
        );
      },
    }),
    columnHelper.display({
      id: "aiGain",
      header: "AI%",
      cell: (info) => {
        const row = info.row.original;
        const stored = row.aiGain !== undefined && row.aiGain !== null && (row.aiGain as unknown as string) !== ""
          ? Number(row.aiGain)
          : undefined;
        const displayVal = stored !== undefined ? Math.round(stored * 100) : "";
        return (
          <input
            type="number"
            value={displayVal}
            step={5}
            min={0}
            max={100}
            placeholder={String(Math.round(globalAiGain * 100))}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const v = e.target.value;
              onUpdate(row.id, "aiGain", v === "" ? "" : String(Number(v) / 100));
            }}
            className="text-right py-0.75 px-1.25 text-xs text-acc-hi"
          />
        );
      },
    }),
    columnHelper.accessor("notes", {
      header: "Notes",
      cell: (info) => (
        <input
          value={info.getValue()}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(info.row.original.id, "notes", e.target.value)}
          placeholder="Notes…"
          className="py-0.75 px-1.25 text-[11px] text-soft"
        />
      ),
    }),
    columnHelper.accessor("release", {
      header: "Release",
      cell: (info) => (
        <select
          value={info.getValue()}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            const val = e.target.value;
            if (val === NEW_RELEASE_SENTINEL) {
              const newName = onAddRelease();
              onUpdate(info.row.original.id, "release", newName);
            } else {
              onUpdate(info.row.original.id, "release", val);
            }
          }}
          className="py-0.75 px-1.25 text-[11px]"
        >
          {releaseNames.map(r => <option key={r}>{r}</option>)}
          <option value={NEW_RELEASE_SENTINEL}>＋ New release…</option>
        </select>
      ),
    }),
    columnHelper.display({
      id: "actions",
      header: "",
      cell: (info) => (
        <button
          onClick={() => onDelete(info.row.original.id)}
          className="bg-transparent text-muted text-[15px] py-0 pr-4"
        >
          ×
        </button>
      ),
    }),
  ], [activityNums, releaseNames, globalAiGain, onUpdate, onDelete, onAddRelease]);

  const table = useReactTable({
    data: activities,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // Map activity id → TanStack row for grouped rendering
  const rowById = useMemo(() => {
    const m = new Map<string, Row<Activity>>();
    for (const r of table.getRowModel().rows) m.set(r.original.id, r);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities]);

  // Epic grouping — preserves activity order, groups by epic value.
  // groupId = first activity's ID in each group → stable key even as epic name changes.
  const epicOrder = useMemo(() => {
    const seen = new Set<string>();
    const order: Array<{ epicKey: string; groupId: string }> = [];
    for (const a of activities) {
      if (!seen.has(a.epic)) { seen.add(a.epic); order.push({ epicKey: a.epic, groupId: a.id }); }
    }
    return order;
  }, [activities]);

  const epicGroups = useMemo(() => {
    const map = new Map<string, Activity[]>();
    for (const a of activities) {
      if (!map.has(a.epic)) map.set(a.epic, []);
      map.get(a.epic)!.push(a);
    }
    return map;
  }, [activities]);

  // Full list for index lookup in DnD; visible list for SortableContext
  const allIds = useMemo(() => activities.map(a => a.id), [activities]);
  const visibleIds = useMemo(() =>
    activities.filter(a => !collapsedEpics.has(a.epic)).map(a => a.id),
    [activities, collapsedEpics]
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = allIds.indexOf(active.id as string);
    const toIndex = allIds.indexOf(over.id as string);
    if (fromIndex !== -1 && toIndex !== -1) onReorder(fromIndex, toIndex);
  }

  return (
    <>
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-disp text-sm font-bold">Activity Detail</h2>
        <button onClick={onAdd} className="bg-acc text-white py-1.5 px-3.25 font-medium text-xs">
          + Add Activity
        </button>
      </div>

      <div className="overflow-x-auto">
        <div style={{ minWidth: "1080px" }}>
          {/* Column headers — includes drag handle column */}
          <div
            className="grid gap-0.75 py-1.5 px-2 bg-ink-mid rounded-t-md text-[9px] text-soft font-mono uppercase tracking-[0.06em]"
            style={{ gridTemplateColumns: COL_W }}
          >
            <div /> {/* handle column header — empty */}
            {table.getHeaderGroups().map(headerGroup =>
              headerGroup.headers.map(header => (
                <div key={header.id} className={RIGHT_COLS.has(header.id) ? "text-right" : "text-left"}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </div>
              ))
            )}
          </div>

          {/* Grouped + sortable rows */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
              {epicOrder.map(({ epicKey, groupId }) => {
                const label = epicKey || '(no epic)';
                const epicActs = epicGroups.get(epicKey) ?? [];
                const isCollapsed = collapsedEpics.has(epicKey);
                const subtotal = epicActs.reduce(
                  (s, a) => s + pertCalc(a.o, a.ml, a.p) + (Number(a.risk) || 0),
                  0
                );

                return (
                  <div key={groupId}>
                    {/* Epic header row */}
                    <div
                      className="flex items-center gap-2 py-1.25 px-2 border-b border-rule bg-ink-mid/60 cursor-pointer hover:bg-ink-mid transition-colors select-none border-l-2 border-l-acc/40"
                      onClick={() => toggleEpic(epicKey)}
                    >
                      <span className="text-[9px] text-acc w-2.5 shrink-0">
                        {isCollapsed ? '▶' : '▼'}
                      </span>
                      <span className="text-[11px] font-semibold text-acc-hi flex-1 truncate">
                        {label}
                      </span>
                      <span className="text-[10px] text-muted shrink-0">
                        {epicActs.length} {epicActs.length === 1 ? 'activity' : 'activities'}
                      </span>
                      <span className="text-[11px] font-mono font-semibold text-text ml-3 shrink-0">
                        Exp. {subtotal.toFixed(1)} d
                      </span>
                    </div>

                    {/* Activity rows */}
                    {!isCollapsed && epicActs.map((act, idx) => {
                      const row = rowById.get(act.id);
                      if (!row) return null;
                      const risky = Number(act.risk) > 0;
                      return (
                        <SortableRow
                          key={row.id}
                          id={act.id}
                          className={`grid gap-0.75 py-1 px-2 border-b border-rule items-center border-l-2 ${
                            risky
                              ? "bg-[rgba(245,166,35,.04)] border-l-org"
                              : idx % 2 === 0
                                ? "bg-ink-soft border-l-transparent"
                                : "bg-ink border-l-transparent"
                          }`}
                          style={{ gridTemplateColumns: COL_W }}
                        >
                          {row.getVisibleCells().map(cell =>
                            flexRender(cell.column.columnDef.cell, cell.getContext())
                          )}
                        </SortableRow>
                      );
                    })}
                  </div>
                );
              })}
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mt-3 text-[11px] text-soft font-mono flex-wrap">
        <span><span className="text-grn">O</span> = Optimistic</span>
        <span>ML = Most Likely (auto-derives O &amp; P)</span>
        <span><span className="text-red">P</span> = Pessimistic</span>
        <span><span className="text-acc-hi">PERT</span> = (O+4×ML+P)/6</span>
        <span><span className="text-org">Risk</span> = buffer days</span>
        <span><strong className="text-text">Exp.</strong> = PERT+Risk</span>
        <span><span className="text-acc-hi">AI%</span> = per-activity gain (blank = global default)</span>
      </div>
    </>
  );
});

export default ActivityTable;
