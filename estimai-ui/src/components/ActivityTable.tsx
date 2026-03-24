import { memo, useMemo, useRef, useState, type ChangeEvent } from "react";
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
import { deriveOP } from "../hooks/useEstimator";
import { type WarningCode, WARNING_META } from "../lib/healthWarnings";

interface ActivityTableProps {
  activities: Activity[];
  releaseNames: string[];
  globalAiGain: number;
  onUpdate: (id: string, field: keyof Activity, value: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onAddRelease: () => string;
  onReorder: (fromIndex: number, toIndex: number) => void;
  activityWarnings: Map<string, WarningCode[]>;
}

function pertCalc(o: number, ml: number, p: number): number {
  return ((Number(o)||0) + 4*(Number(ml)||0) + (Number(p)||0)) / 6;
}

const COL_W = "18px 44px 90px 150px 100px 48px 48px 48px 48px 48px 62px 58px 32px 106px 28px 26px";
const RIGHT_COLS = new Set(["o", "ml", "p", "pert", "risk", "expected", "aiGain"]);
const CENTER_COLS = new Set(["notes"]);

// Navigable column indices (excludes num/drag-handle, pert, expected, actions)
// 0:epic  1:act  2:prof  3:o  4:ml  5:p  6:risk  7:aiGain  8:notes  9:release
const NAV_COL_MAX = 9;

const columnHelper = createColumnHelper<Activity>();
const NEW_RELEASE_SENTINEL = "__new__";

type NavHandler = (e: React.KeyboardEvent<HTMLElement>, row: number, col: number, isText: boolean) => void;

// MLCell — standalone component so it can hold isFocused state while living inside
// a stable columns[] closure. Receives ref objects (not values) so it always reads fresh data.
function MLCell({
  id, value, rowIdx,
  onUpdateRef, navRef,
}: {
  id: string
  value: number
  rowIdx: number
  onUpdateRef: React.MutableRefObject<(id: string, field: keyof Activity, value: string) => void>
  navRef: React.MutableRefObject<NavHandler>
}) {
  const [focused, setFocused] = useState(false)
  const derived = deriveOP(Number(value))
  const showTip = focused && Number(value) > 0

  return (
    <div className="relative w-full">
      <input
        type="number"
        value={value}
        step={0.5}
        min={0}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRef.current(id, "ml", e.target.value)}
        onKeyDown={(e) => navRef.current(e, rowIdx, 4, false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        data-cell={`${rowIdx}-4`}
        className="text-right py-0.75 px-1.25 text-xs w-full"
      />
      {showTip && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 pointer-events-none">
          <div className="bg-ink border border-rule rounded px-2 py-1 shadow-lg whitespace-nowrap">
            <div className="flex items-center gap-1.5 font-mono text-[10px]">
              <span className="text-muted">O</span>
              <span className="text-grn font-semibold">{derived.o.toFixed(1)}</span>
              <span className="text-muted/40">·</span>
              <span className="text-muted">P</span>
              <span className="text-red font-semibold">{derived.p.toFixed(1)}</span>
            </div>
          </div>
          {/* Caret */}
          <div className="absolute top-full left-1/2 -translate-x-1/2"
            style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '5px solid var(--rule)' }}
          />
        </div>
      )}
    </div>
  )
}

// AiGainCell — shows "30%" when blurred, bare number when focused for easy editing.
function AiGainCell({
  id, stored, globalGainRef, rowIdx,
  onUpdateRef, navRef,
}: {
  id: string
  stored: number | undefined
  globalGainRef: React.MutableRefObject<number>
  rowIdx: number
  onUpdateRef: React.MutableRefObject<(id: string, field: keyof Activity, value: string) => void>
  navRef: React.MutableRefObject<NavHandler>
}) {
  const [focused, setFocused] = useState(false)
  const displayPct = stored !== undefined ? Math.round(stored * 100) : ''
  const placeholderPct = Math.round(globalGainRef.current * 100)

  return (
    <div className="relative flex items-center">
      <input
        type="number"
        value={focused ? displayPct : ''}
        readOnly={!focused}
        step={5}
        min={0}
        max={100}
        placeholder={focused ? String(placeholderPct) : undefined}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const v = e.target.value
          onUpdateRef.current(id, 'aiGain', v === '' ? '' : String(Number(v) / 100))
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => navRef.current(e, rowIdx, 7, false)}
        data-cell={`${rowIdx}-7`}
        className={`text-right py-0.75 px-1.25 text-xs w-full text-acc-hi ${focused ? '' : 'opacity-0 absolute'}`}
      />
      {!focused && (
        <span className="text-right py-0.75 px-1.25 text-xs text-acc-hi w-full select-none">
          {displayPct !== '' ? `${displayPct}%` : (
            <span className="text-muted/50">{placeholderPct}%</span>
          )}
        </span>
      )}
    </div>
  )
}

// NotesCell — collapses to a narrow icon; expands to a floating input on click.
function NotesCell({
  id, value, rowIdx, onUpdateRef, navRef,
}: {
  id: string
  value: string
  rowIdx: number
  onUpdateRef: React.MutableRefObject<(id: string, field: keyof Activity, value: string) => void>
  navRef: React.MutableRefObject<NavHandler>
}) {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const hasNote = value.trim().length > 0

  function handleOpen() {
    setOpen(true)
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
  }

  return (
    <div className="relative flex items-center justify-center">
      <button
        onClick={handleOpen}
        className={`text-[12px] leading-none transition-colors select-none ${
          hasNote ? 'text-acc-hi/70 hover:text-acc-hi' : 'text-muted/25 hover:text-muted/60'
        }`}
        title={hasNote ? value : 'Add note'}
        tabIndex={-1}
      >
        💬
      </button>
      {open && (
        <input
          ref={inputRef}
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRef.current(id, 'notes', e.target.value)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false); return }
            navRef.current(e, rowIdx, 8, true)
          }}
          data-cell={`${rowIdx}-8`}
          placeholder="Add a note…"
          className="absolute right-0 top-1/2 -translate-y-1/2 z-20 w-52 py-0.75 px-2 text-[11px] text-soft bg-ink border border-acc/40 rounded shadow-lg"
        />
      )}
    </div>
  )
}

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
  activityWarnings,
  onUpdate,
  onDelete,
  onAdd,
  onAddRelease,
  onReorder,
}: ActivityTableProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [collapsedEpics, setCollapsedEpics] = useState<Set<string>>(new Set());

  // ── Stable refs for column closures ──────────────────────────────────────
  // columns has [] deps; all mutable values are accessed via refs so the array
  // reference never changes → TanStack Table keeps rows mounted → no focus loss.
  const onUpdateRef      = useRef(onUpdate);
  const onDeleteRef      = useRef(onDelete);
  const onAddReleaseRef  = useRef(onAddRelease);
  const releaseNamesRef  = useRef(releaseNames);
  const globalAiGainRef  = useRef(globalAiGain);
  const activityNumsRef  = useRef<Map<string, string>>(new Map());
  const actWarningsRef   = useRef<Map<string, WarningCode[]>>(new Map());
  const visibleRowIdxRef = useRef<Map<string, number>>(new Map());
  const visibleIdsRef    = useRef<string[]>([]);
  onUpdateRef.current      = onUpdate;
  onDeleteRef.current      = onDelete;
  onAddReleaseRef.current  = onAddRelease;
  releaseNamesRef.current  = releaseNames;
  globalAiGainRef.current  = globalAiGain;
  actWarningsRef.current   = activityWarnings;

  // ── Keyboard navigation ───────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);

  function focusCell(rowIdx: number, colIdx: number) {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-cell="${rowIdx}-${colIdx}"]`);
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }

  // Stored in a ref so column closures always call the latest version.
  const navRef = useRef<NavHandler>(() => {});
  navRef.current = (e, rowIdx, colIdx, isText) => {
    const maxRow = visibleIdsRef.current.length - 1;

    switch (e.key) {
      case 'Tab': {
        e.preventDefault();
        if (e.shiftKey) {
          if (colIdx > 0) focusCell(rowIdx, colIdx - 1);
          else if (rowIdx > 0) focusCell(rowIdx - 1, NAV_COL_MAX);
        } else {
          if (colIdx < NAV_COL_MAX) focusCell(rowIdx, colIdx + 1);
          else if (rowIdx < maxRow) focusCell(rowIdx + 1, 0);
        }
        break;
      }
      case 'Enter':
      case 'ArrowDown': {
        e.preventDefault();
        if (rowIdx < maxRow) focusCell(rowIdx + 1, colIdx);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        if (rowIdx > 0) focusCell(rowIdx - 1, colIdx);
        break;
      }
      case 'ArrowRight': {
        if (!isText) {
          e.preventDefault();
          if (colIdx < NAV_COL_MAX) focusCell(rowIdx, colIdx + 1);
        } else {
          const inp = e.currentTarget as HTMLInputElement;
          if (inp.selectionStart === inp.value.length) {
            e.preventDefault();
            if (colIdx < NAV_COL_MAX) focusCell(rowIdx, colIdx + 1);
          }
        }
        break;
      }
      case 'ArrowLeft': {
        if (!isText) {
          e.preventDefault();
          if (colIdx > 0) focusCell(rowIdx, colIdx - 1);
        } else {
          const inp = e.currentTarget as HTMLInputElement;
          if (inp.selectionStart === 0) {
            e.preventDefault();
            if (colIdx > 0) focusCell(rowIdx, colIdx - 1);
          }
        }
        break;
      }
    }
  };

  // ── Column definitions (stable — [] deps) ─────────────────────────────────
  const activityNums = useMemo(() => computeActivityNums(activities), [activities]);
  activityNumsRef.current = activityNums;

  const columns: ColumnDef<Activity, any>[] = useMemo(() => [
    columnHelper.display({
      id: "num",
      header: "#",
      cell: (info) => (
        <div className="font-mono text-[10px] text-muted text-center select-none">
          {activityNumsRef.current.get(info.row.original.id) ?? ''}
        </div>
      ),
    }),
    columnHelper.accessor("epic", {
      header: "Epic",
      cell: (info) => {
        const rowIdx = visibleRowIdxRef.current.get(info.row.original.id) ?? 0;
        return (
          <input
            value={info.getValue()}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRef.current(info.row.original.id, "epic", e.target.value)}
            onKeyDown={(e) => navRef.current(e, rowIdx, 0, true)}
            data-cell={`${rowIdx}-0`}
            placeholder="Epic…"
            className="py-0.75 px-1.25 text-[11px]"
          />
        );
      },
    }),
    columnHelper.accessor("act", {
      header: "Activity",
      cell: (info) => {
        const rowIdx = visibleRowIdxRef.current.get(info.row.original.id) ?? 0;
        const isUnnamed = info.getValue() === 'New activity';
        return (
          <input
            value={info.getValue()}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRef.current(info.row.original.id, "act", e.target.value)}
            onKeyDown={(e) => navRef.current(e, rowIdx, 1, true)}
            data-cell={`${rowIdx}-1`}
            placeholder="Activity…"
            className={`py-0.75 px-1.25 text-xs ${isUnnamed ? 'text-org/70 italic' : ''}`}
            title={isUnnamed ? 'Rename this activity before sharing with a client' : undefined}
          />
        );
      },
    }),
    columnHelper.accessor("prof", {
      header: "Profile",
      cell: (info) => {
        const rowIdx = visibleRowIdxRef.current.get(info.row.original.id) ?? 0;
        return (
          <select
            value={info.getValue()}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => onUpdateRef.current(info.row.original.id, "prof", e.target.value)}
            onKeyDown={(e) => navRef.current(e, rowIdx, 2, false)}
            data-cell={`${rowIdx}-2`}
            className="py-0.75 px-1.25 text-[11px]"
          >
            {PROFILES.map(p => <option key={p}>{p}</option>)}
          </select>
        );
      },
    }),
    columnHelper.accessor("o", {
      header: "O",
      cell: (info) => {
        const rowIdx = visibleRowIdxRef.current.get(info.row.original.id) ?? 0;
        return (
          <input
            type="number"
            value={info.getValue()}
            step={0.5}
            min={0}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRef.current(info.row.original.id, "o", e.target.value)}
            onKeyDown={(e) => navRef.current(e, rowIdx, 3, false)}
            data-cell={`${rowIdx}-3`}
            className="text-right py-0.75 px-1.25 text-grn text-xs"
          />
        );
      },
    }),
    columnHelper.accessor("ml", {
      header: "ML",
      cell: (info) => (
        <MLCell
          id={info.row.original.id}
          value={info.row.original.ml}
          rowIdx={visibleRowIdxRef.current.get(info.row.original.id) ?? 0}
          onUpdateRef={onUpdateRef}
          navRef={navRef}
        />
      ),
    }),
    columnHelper.accessor("p", {
      header: "P",
      cell: (info) => {
        const rowIdx = visibleRowIdxRef.current.get(info.row.original.id) ?? 0;
        return (
          <input
            type="number"
            value={info.getValue()}
            step={0.5}
            min={0}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRef.current(info.row.original.id, "p", e.target.value)}
            onKeyDown={(e) => navRef.current(e, rowIdx, 5, false)}
            data-cell={`${rowIdx}-5`}
            className="text-right py-0.75 px-1.25 text-red text-xs"
          />
        );
      },
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
        const rowIdx = visibleRowIdxRef.current.get(info.row.original.id) ?? 0;
        const risky = Number(info.getValue()) > 0;
        return (
          <input
            type="number"
            value={info.getValue()}
            step={0.5}
            min={0}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdateRef.current(info.row.original.id, "risk", e.target.value)}
            onKeyDown={(e) => navRef.current(e, rowIdx, 6, false)}
            data-cell={`${rowIdx}-6`}
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
        const rowIdx = visibleRowIdxRef.current.get(row.id) ?? 0;
        const stored = row.aiGain !== undefined && row.aiGain !== null && (row.aiGain as unknown as string) !== ""
          ? Number(row.aiGain) : undefined;
        return (
          <AiGainCell
            id={row.id}
            stored={stored}
            globalGainRef={globalAiGainRef}
            rowIdx={rowIdx}
            onUpdateRef={onUpdateRef}
            navRef={navRef}
          />
        );
      },
    }),
    columnHelper.accessor("notes", {
      header: "💬",
      cell: (info) => {
        const rowIdx = visibleRowIdxRef.current.get(info.row.original.id) ?? 0;
        return (
          <NotesCell
            id={info.row.original.id}
            value={info.getValue()}
            rowIdx={rowIdx}
            onUpdateRef={onUpdateRef}
            navRef={navRef}
          />
        );
      },
    }),
    columnHelper.accessor("release", {
      header: "Release",
      cell: (info) => {
        const rowIdx = visibleRowIdxRef.current.get(info.row.original.id) ?? 0;
        return (
          <select
            value={info.getValue()}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const val = e.target.value;
              if (val === NEW_RELEASE_SENTINEL) {
                const newName = onAddReleaseRef.current();
                onUpdateRef.current(info.row.original.id, "release", newName);
              } else {
                onUpdateRef.current(info.row.original.id, "release", val);
              }
            }}
            onKeyDown={(e) => navRef.current(e, rowIdx, 9, false)}
            data-cell={`${rowIdx}-9`}
            className="py-0.75 px-1.25 text-[11px]"
          >
            {releaseNamesRef.current.map(r => <option key={r}>{r}</option>)}
            <option value={NEW_RELEASE_SENTINEL}>＋ New release…</option>
          </select>
        );
      },
    }),
    columnHelper.display({
      id: "warn",
      header: "",
      cell: (info) => {
        const ws = actWarningsRef.current.get(info.row.original.id)
        if (!ws?.length) return null
        return (
          <div className="flex items-center gap-0.5">
            {ws.map(code => {
              const m = WARNING_META[code]
              return (
                <span key={code} className={`text-[11px] leading-none ${m.colorClass}`} title={m.title}>
                  {m.icon}
                </span>
              )
            })}
          </div>
        )
      },
    }),
    columnHelper.display({
      id: "actions",
      header: "",
      cell: (info) => (
        <button
          onClick={() => onDeleteRef.current(info.row.original.id)}
          className="bg-transparent text-muted text-[15px] py-0 pr-4"
        >
          ×
        </button>
      ),
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const table = useReactTable({ data: activities, columns, getCoreRowModel: getCoreRowModel() });

  const rowById = useMemo(() => {
    const m = new Map<string, Row<Activity>>();
    for (const r of table.getRowModel().rows) m.set(r.original.id, r);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities]);

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

  const allIds = useMemo(() => activities.map(a => a.id), [activities]);

  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const { epicKey } of epicOrder) {
      if (collapsedEpics.has(epicKey)) continue;
      for (const a of epicGroups.get(epicKey) ?? []) ids.push(a.id);
    }
    return ids;
  }, [epicOrder, epicGroups, collapsedEpics]);

  // Keep refs in sync for use inside column closures
  visibleIdsRef.current = visibleIds;
  visibleRowIdxRef.current = useMemo(
    () => new Map(visibleIds.map((id, i) => [id, i])),
    [visibleIds]
  );

  function toggleEpic(epicKey: string) {
    setCollapsedEpics(prev => {
      const next = new Set(prev);
      if (next.has(epicKey)) next.delete(epicKey);
      else next.add(epicKey);
      return next;
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = allIds.indexOf(active.id as string);
    const toIndex   = allIds.indexOf(over.id as string);
    if (fromIndex === -1 || toIndex === -1) return;
    onReorder(fromIndex, toIndex);
    const overAct   = activities.find(a => a.id === over.id);
    const activeAct = activities.find(a => a.id === active.id);
    if (overAct && activeAct && overAct.epic !== activeAct.epic) {
      onUpdate(active.id as string, 'epic', overAct.epic);
    }
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
        <div ref={containerRef} style={{ minWidth: "1080px" }}>
          <div
            className="grid gap-0.75 py-1.5 px-2 bg-ink-mid rounded-t-md text-[9px] text-soft font-mono uppercase tracking-[0.06em]"
            style={{ gridTemplateColumns: COL_W }}
          >
            <div />
            {table.getHeaderGroups().map(headerGroup =>
              headerGroup.headers.map(header => (
                <div key={header.id} className={RIGHT_COLS.has(header.id) ? "text-right" : CENTER_COLS.has(header.id) ? "text-center" : "text-left"}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </div>
              ))
            )}
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
              {epicOrder.map(({ epicKey, groupId }) => {
                const label     = epicKey || '(no epic)';
                const epicActs  = epicGroups.get(epicKey) ?? [];
                const isCollapsed = collapsedEpics.has(epicKey);
                const subtotal  = epicActs.reduce(
                  (s, a) => s + pertCalc(a.o, a.ml, a.p) + (Number(a.risk) || 0), 0
                );

                return (
                  <div key={groupId}>
                    <div
                      className="flex items-center gap-2 py-1.25 px-2 border-b border-rule bg-ink-mid/60 cursor-pointer hover:bg-ink-mid transition-colors select-none border-l-2 border-l-acc/40"
                      onClick={() => toggleEpic(epicKey)}
                    >
                      <span className="text-[9px] text-acc w-2.5 shrink-0">{isCollapsed ? '▶' : '▼'}</span>
                      <span className="text-[11px] font-semibold text-acc-hi flex-1 truncate">{label}</span>
                      <span className="text-[10px] text-muted shrink-0">
                        {epicActs.length} {epicActs.length === 1 ? 'activity' : 'activities'}
                      </span>
                      <span className="text-[11px] font-mono font-semibold text-text ml-3 shrink-0">
                        Exp. {subtotal.toFixed(1)} d
                      </span>
                    </div>

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
