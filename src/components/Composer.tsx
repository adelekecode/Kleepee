import { useId, useRef, useState, type DragEvent } from "react";
import { MAX_FILE_BYTES, formatFileSize } from "../lib/fileTransfer";

export interface ComposerResult {
  textSent: boolean;
  accepted: File[];
  errors: string[];
}

interface ComposerProps {
  disabled?: boolean;
  pending?: boolean;
  error?: string | null;
  actionLabel?: string;
  placeholder?: string;
  onSubmit: (text: string, files: File[]) => Promise<ComposerResult>;
}

const MAX_TEXT_BYTES = 65536;

export function Composer({ disabled = false, pending = false, error, actionLabel = "Send", placeholder = "Paste or type something…", onSubmit }: ComposerProps) {
  const id = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const draftRevision = useRef(0);
  const dragDepth = useRef(0);
  const [draft, setDraft] = useState("");
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const byteCount = new TextEncoder().encode(draft).byteLength;
  const isTooLarge = byteCount > MAX_TEXT_BYTES;
  const busy = sending || pending;
  const canSubmit = !disabled && !busy && !isTooLarge && (stagedFiles.length > 0 || draft.trim().length > 0);
  const displayError = isTooLarge ? "That message is too large to send. Keep it under 65,536 bytes." : localError ?? error;

  function stageFiles(incoming: FileList | File[]) {
    const valid: File[] = [];
    const errors: string[] = [];
    for (const file of Array.from(incoming)) {
      if (file.size > MAX_FILE_BYTES) errors.push(`“${file.name}” exceeds the 25 MB limit.`);
      else valid.push(file);
    }
    setLocalError(errors.length ? errors.join(" ") : null);
    // File identity matters: two different files can have the same name and size.
    setStagedFiles((previous) => [...previous, ...valid.filter((file) => !previous.includes(file))]);
  }

  async function submit() {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSending(true);
    setLocalError(null);
    const submittedDraft = draft;
    const submittedRevision = draftRevision.current;
    const submittedFiles = stagedFiles.slice();
    try {
      const result = await onSubmit(submittedDraft, submittedFiles);
      if (result.textSent && draftRevision.current === submittedRevision) setDraft("");
      setStagedFiles((current) => current.filter((file) => !result.accepted.includes(file)));
      if (result.errors.length) setLocalError(result.errors.join(" "));
    } catch {
      setLocalError("Could not send. Your text and files are still here; try again.");
    } finally {
      submittingRef.current = false;
      setSending(false);
    }
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!disabled) stageFiles(event.dataTransfer.files);
  }

  return (
    <div className={`panel flex flex-col gap-3 transition-colors ${dragging ? "border-kleepee-focus ring-2 ring-kleepee-focus/20" : ""}`}
      onDrop={drop}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={busy}>
        <label className="sr-only" htmlFor={id}>Text to share</label>
        <textarea id={id} className="input-field min-h-[144px]" disabled={disabled} rows={4} value={draft}
          aria-invalid={isTooLarge} aria-describedby={`${id}-hint${displayError ? ` ${id}-error` : ""}`}
          placeholder={disabled ? "Waiting for a connection…" : dragging ? "Drop files here…" : placeholder}
          onChange={(event) => { draftRevision.current += 1; setDraft(event.target.value); setLocalError(null); }}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }}
        />
        {stagedFiles.length > 0 && <ul className="flex flex-col gap-2" aria-label="Files to send">
          {stagedFiles.map((file, index) => <li key={index} className="flex min-w-0 items-center gap-3 rounded-[18px] border border-kleepee-border bg-kleepee-panel px-3 py-2">
            <div className="min-w-0 flex-1"><p className="break-all text-sm text-kleepee-espresso">{file.name}</p><p className="text-xs text-kleepee-muted">{formatFileSize(file.size)}</p></div>
            <button type="button" className="btn-secondary shrink-0" aria-label={`Remove ${file.name}`} onClick={() => setStagedFiles((files) => files.filter((_, i) => i !== index))}>×</button>
          </li>)}
        </ul>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" disabled={disabled} className="btn-secondary gap-2" onClick={() => fileInputRef.current?.click()}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m8 12 7-7a3 3 0 0 1 4 4L9 19a5 5 0 0 1-7-7L13 1" transform="translate(1 2) scale(.85)"/><path d="m8 12 6-6"/></svg>
            Attach files
          </button>
          <button type="submit" disabled={!canSubmit} className="btn-primary">{busy ? "Working…" : actionLabel}</button>
        </div>
        <input ref={fileInputRef} type="file" multiple className="hidden" tabIndex={-1} onChange={(event) => { if (event.target.files) stageFiles(event.target.files); event.target.value = ""; }} />
        <p id={`${id}-hint`} className="text-xs leading-5 text-kleepee-muted">Any file type, up to 25 MB each. Drop files here or attach them.{byteCount > MAX_TEXT_BYTES * .75 && ` Text: ${byteCount.toLocaleString()} / 65,536 bytes.`}</p>
        {displayError && <p id={`${id}-error`} className="text-sm text-kleepee-danger" role="alert">{displayError}</p>}
      </form>
    </div>
  );
}
