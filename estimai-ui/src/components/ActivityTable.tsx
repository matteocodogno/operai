import { memo, useMemo, type ChangeEvent } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type ColumnDef,
} from "@tanstack/react-table";
import { type Activity, PROFILES } from "../types";

interface ActivityTableProps {
  activities: Activity[];
  releaseNames: string[];
  globalAiGain: number;
  onUpdate: (id: string, field: keyof Activity, value: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onAddRelease: () => string;
}

function pertCalc(o: number, ml: number, p: number): number {
  return ((Number(o)||0) + 4*(Number(ml)||0) + (Number(p)||0)) / 6;
}

const COL_W = "44px 90px 108px 108px 58px 58px 58px 58px 58px 62px 58px 124px 106px 26px";
const RIGHT_COLS = new Set(["o", "ml", "p", "pert", "risk", "expected", "aiGain"]);

const columnHelper = createColumnHelper<Activity>();

const NEW_RELEASE_SENTINEL = "__new__";

const ActivityTable = memo(function ActivityTable({ activities, releaseNames, globalAiGain, onUpdate, onDelete, onAdd, onAddRelease }: ActivityTableProps) {
  const columns: ColumnDef<Activity, any>[] = useMemo(() => [
    columnHelper.accessor("num", {
      header: "#",
      cell: (info) => (
        <input
          value={info.getValue()}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onUpdate(info.row.original.id, "num", e.target.value)}
          placeholder="#"
          className="py-0.75 px-1.25 text-[10px]"
        />
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
  ], [releaseNames, globalAiGain, onUpdate, onDelete, onAddRelease]);

  const table = useReactTable({
    data: activities,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-disp text-sm font-bold">Activity Detail</h2>
        <button onClick={onAdd} className="bg-acc text-white py-1.5 px-3.25 font-medium text-xs">
          + Add Activity
        </button>
      </div>

      <div className="overflow-x-auto">
        <div style={{ minWidth: "1000px" }}>
          {/* Column headers */}
          <div
            className="grid gap-0.75 py-1.5 px-2 bg-ink-mid rounded-t-md text-[9px] text-soft font-mono uppercase tracking-[0.06em]"
            style={{ gridTemplateColumns: COL_W }}
          >
            {table.getHeaderGroups().map(headerGroup =>
              headerGroup.headers.map(header => (
                <div key={header.id} className={RIGHT_COLS.has(header.id) ? "text-right" : "text-left"}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </div>
              ))
            )}
          </div>

          {/* Rows */}
          {table.getRowModel().rows.map((row, idx) => {
            const risky = Number(row.original.risk) > 0;
            return (
              <div
                key={row.id}
                className={`grid gap-0.75 py-1 px-2 border-b border-rule items-center border-l-2 ${
                  risky
                    ? "bg-[rgba(245,166,35,.04)] border-l-org"
                    : idx % 2 === 0
                      ? "bg-ink-soft border-l-transparent"
                      : "bg-ink border-l-transparent"
                }`}
                style={{ gridTemplateColumns: COL_W }}
              >
                {row.getVisibleCells().map(cell => (
                  flexRender(cell.column.columnDef.cell, cell.getContext())
                ))}
              </div>
            );
          })}
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
