import { useState } from "react";

/** As typed: "2020-06-12", and "14:30" or "" when only the day is known. */
export interface DateInput {
  date: string;
  time: string;
}

interface DatePickerProps {
  /** Current date, when changing one. */
  initial: DateInput | null;
  /** Shown under the fields, e.g. what is known already ("The folder says 2020"). */
  hint?: string | null;
  onSave(d: DateInput): Promise<void>;
  onCancel(): void;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A stored wall-clock time as the inputs show it; without the time when it isn't known. */
export function toDateInput(t: number, withTime: boolean): DateInput {
  const d = new Date(t * 1000);
  return {
    date: `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: withTime ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : "",
  };
}

export function DatePicker({ initial, hint, onSave, onCancel }: DatePickerProps) {
  const [date, setDate] = useState(initial?.date ?? "");
  const [time, setTime] = useState(initial?.time ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!date || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ date, time });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="picker">
      <div className="row date-fields">
        <input
          className="input"
          type="date"
          value={date}
          min="1826-01-01"
          max={`${new Date().getFullYear() + 1}-12-31`}
          onChange={(e) => setDate(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Date"
          required
          autoFocus
        />
        <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} onKeyDown={onKeyDown} aria-label="Time (optional)" />
        {time && (
          <button className="btn btn-small btn-ghost" onClick={() => setTime("")} title="Only the day is known">
            No time
          </button>
        )}
      </div>
      <div className="dim small">
        {time ? "Date and time as shown on a clock where the photo was taken." : "The time is optional: leave it empty if you only know the day."}
        {hint && <> {hint}</>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn btn-small btn-primary" disabled={!date || saving} onClick={save}>
          {saving ? "Saving…" : "Save date"}
        </button>
        <button className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
