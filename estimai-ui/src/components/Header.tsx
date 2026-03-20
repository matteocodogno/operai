import type { ChangeEvent } from "react";

interface HeaderProps {
  name: string;
  author: string;
  onNameChange: (name: string) => void;
  onAuthorChange: (author: string) => void;
  onExport: () => void;
}

export default function Header({ name, author, onNameChange, onAuthorChange, onExport }: HeaderProps) {
  return (
    <header className="bg-ink-soft border-b border-rule px-4 flex items-center gap-4 h-14 sticky top-0 z-10">
      <span className="font-disp text-xl font-extrabold shrink-0 bg-[linear-gradient(130deg,#8b96ff,#2ec27e)] bg-clip-text text-transparent">
        EstimAI
      </span>
      <input
        value={name}
        onChange={(e: ChangeEvent<HTMLInputElement>)=>onNameChange(e.target.value)}
        placeholder="Project name…"
        className="flex-1 max-w-[320px] bg-transparent border-0 border-b border-rule rounded-none text-[14px] py-4 px-0"
      />
      <input
        value={author}
        onChange={(e: ChangeEvent<HTMLInputElement>)=>onAuthorChange(e.target.value)}
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
