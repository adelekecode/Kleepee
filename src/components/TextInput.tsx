import { useId, useMemo, useState } from "react";

interface TextInputProps {
  label: string;
  placeholder: string;
  actionLabel: string;
  disabled?: boolean;
  pending?: boolean;
  minRows?: number;
  initialValue?: string;
  error?: string | null;
  onSubmit: (text: string) => Promise<boolean>;
}

const MAX_BYTES = 65536;

function countBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function TextInput({
  label,
  placeholder,
  actionLabel,
  disabled = false,
  pending = false,
  minRows = 4,
  initialValue = "",
  error,
  onSubmit,
}: TextInputProps) {
  const textareaId = useId();
  const [draft, setDraft] = useState(initialValue);
  const [localError, setLocalError] = useState<string | null>(null);
  const byteCount = useMemo(() => countBytes(draft), [draft]);
  const isTooLarge = byteCount > MAX_BYTES;
  const isBlank = draft.trim().length === 0;

  async function submit() {
    if (disabled || pending) return;

    if (isBlank) {
      setLocalError("Add some text first.");
      return;
    }

    if (isTooLarge) {
      setLocalError("That message is too large to send.");
      return;
    }

    setLocalError(null);
    const sent = await onSubmit(draft);

    if (sent) {
      setDraft("");
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" htmlFor={textareaId}>
        {label}
      </label>

      <textarea
        id={textareaId}
        className="input-field"
        disabled={disabled}
        rows={minRows}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => {
          setDraft(event.target.value);
          if (localError) setLocalError(null);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-h-5 text-sm text-kleepee-muted">
          {localError || error ? (
            <span className="text-kleepee-danger">{localError || error}</span>
          ) : (
            <span>
              {byteCount.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
            </span>
          )}
        </div>

        <button
          className="btn-primary w-full sm:w-auto"
          disabled={disabled || pending || isBlank || isTooLarge}
          type="submit"
        >
          {pending ? "Working..." : actionLabel}
        </button>
      </div>
    </form>
  );
}
