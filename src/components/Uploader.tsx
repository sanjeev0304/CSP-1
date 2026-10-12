import { useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { UploadResponse } from "../lib/types";

/** True only for the non-blocking upload responses (no `status` field). */
function isStoredResult(
  r: UploadResponse,
): r is Extract<UploadResponse, { deduplicated: boolean }> {
  return "deduplicated" in r;
}

interface Props {
  onUploaded: () => void;
  onNoticesChanged: () => void;
}

export function Uploader({ onUploaded, onNoticesChanged }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    setLog([]);
    const messages: string[] = [];
    let anyBlocked = false;
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const { data, error } = await supabase.functions.invoke<UploadResponse>(
          "process-upload",
          { body: form },
        );
        if (error) throw new Error(`${file.name}: ${error.message}`);
        if (data) {
          if (isStoredResult(data)) {
            // Tier 1 (fallback linking path — no extraction ran) or Tier 2.
            if (data.tier === 1) {
              messages.push(
                `${file.name}: identical bytes already stored; reused existing blob (fallback).`,
              );
            } else {
              const note = data.extraction_ok
                ? "text extracted"
                : `metadata-only (${data.extraction_reason ?? "no text"})`;
              messages.push(
                `${file.name}: stored — ${note}; ${data.near_duplicate_pairs} possible duplicate(s).`,
              );
            }
          } else {
            // Blocked duplicate: NOT counted as uploaded; a message is
            // recorded and can be approved from the Messages inbox.
            const first = data.matches[0]?.filename ?? "an existing file";
            messages.push(
              `${data.incoming_filename}: not added — exact copy of ${first}. See Messages.`,
            );
            anyBlocked = true;
          }
        }
      }
      setLog(messages);
      onUploaded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      // Refresh the messages inbox after each batch finishes (blocked or not).
      if (anyBlocked) onNoticesChanged();
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="card uploader">
      <div className="uploader-row">
        <label className="file-btn">
          <input
            ref={inputRef}
            type="file"
            multiple
            onChange={(e) => handleFiles(e.target.files)}
            disabled={busy}
            hidden
          />
          {busy ? "Uploading…" : "Choose files"}
        </label>
        <span className="muted small">
          docx · pptx · xlsx · pdf · txt · md · csv — hashed, deduplicated, and
          compared on upload.
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      {log.length > 0 && (
        <ul className="upload-log">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
