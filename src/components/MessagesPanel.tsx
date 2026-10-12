// MessagesPanel — the blocked-uploads inbox. An envelope button in the top bar
// toggles a dropdown listing every exact-duplicate upload attempt that was
// recorded instead of linked. Each message can be approved (links the incoming
// filename to the existing blob via the approve_blocked_upload RPC) or closed
// (deletes the notice). "Clear all" deletes every notice for the user.
//
// State changes happen only after the database call succeeds — no optimistic
// updates. Matched filenames are resolved LIVE from logical_files, so a
// renamed original shows its new name and a deleted one disappears.
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { formatDate } from "../lib/format";
import type { BlockedUpload, LogicalFile } from "../lib/types";

interface Props {
  notices: BlockedUpload[];
  allFiles: LogicalFile[];
  onAfterChange: () => void;
}

const MAX_SHOWN_MATCHES = 5;

const ENVELOPE_SVG = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
    <path d="M3.5 7l8.5 6 8.5-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export function MessagesPanel({ notices, allFiles, onAfterChange }: Props) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filesByBlobId = useMemo(
    () => new Map(allFiles.map((f) => [f.blob_id, f.filename])),
    [allFiles],
  );

  /** Returns the live matches for a notice, or null when the original is gone. */
  function liveMatches(notice: BlockedUpload): string[] | null {
    if (!notice.physical_blob_id) return null;
    const name = filesByBlobId.get(notice.physical_blob_id);
    return name ? [name] : null;
  }

  async function approve(id: string) {
    setBusyId(id);
    setPanelError(null);
    setItemErrors((prev) => ({ ...prev, [id]: "" }));
    const { error } = await supabase.rpc("approve_blocked_upload", {
      p_notice_id: id,
    });
    setBusyId(null);
    if (error) {
      const msg = error.message;
      if (msg.includes("original_deleted")) {
        setItemErrors((prev) => ({
          ...prev,
          [id]:
            "The original no longer exists and the file must be uploaded again.",
        }));
      } else {
        setItemErrors((prev) => ({ ...prev, [id]: msg }));
      }
      return;
    }
    onAfterChange();
  }

  async function closeOne(id: string) {
    setBusyId(id);
    setPanelError(null);
    const { error } = await supabase
      .from("blocked_uploads")
      .delete()
      .eq("id", id);
    setBusyId(null);
    if (error) {
      setPanelError(error.message);
      return;
    }
    onAfterChange();
  }

  async function clearAll() {
    setBusyId("all");
    setPanelError(null);
    // PostgREST rejects a DELETE without a filter; add a harmless always-true
    // one. RLS limits the delete to this user's own rows.
    const { error } = await supabase
      .from("blocked_uploads")
      .delete()
      .not("id", "is", null);
    setBusyId(null);
    if (error) {
      setPanelError(error.message);
      return;
    }
    onAfterChange();
  }

  const badge =
    notices.length === 0 ? null : notices.length > 9 ? "9+" : String(notices.length);

  return (
    <div className="messages-wrap" ref={wrapRef}>
      <button
        className="icon-btn"
        aria-label="Messages"
        aria-expanded={open}
        title="Messages"
        onClick={() => setOpen((v) => !v)}
      >
        {ENVELOPE_SVG}
        {badge && <span className="badge-count">{badge}</span>}
      </button>

      {open && (
        <div className="messages-panel" role="dialog" aria-label="Blocked uploads">
          <div className="panel-head">
            <h2>Messages</h2>
            <button
              className="link"
              onClick={() => void clearAll()}
              disabled={notices.length === 0 || busyId !== null}
            >
              Clear all
            </button>
          </div>

          {panelError && <p className="error">{panelError}</p>}

          {notices.length === 0 ? (
            <p className="muted messages-empty">No messages</p>
          ) : (
            <ul className="messages-list">
              {notices.map((n) => {
                const matches = liveMatches(n);
                const shown = (matches ?? []).slice(0, MAX_SHOWN_MATCHES);
                const extra = Math.max(
                  (matches?.length ?? 0) - MAX_SHOWN_MATCHES,
                  0,
                );
                const err = itemErrors[n.id];
                const originalDeleted =
                  err?.includes("must be uploaded again") ?? false;
                return (
                  <li key={n.id} className="message-item">
                    <div className="message-main">
                      <div>
                        <strong className="message-filename">
                          {n.incoming_filename}
                        </strong>
                        {matches === null ? (
                          <div className="muted small">
                            The original copy has since been deleted.
                          </div>
                        ) : (
                          <div className="muted small">
                            Exact copy of{" "}
                            {shown.map((m, i) => (
                              <span key={i}>
                                {i > 0 && ", "}
                                <strong>{m}</strong>
                              </span>
                            ))}
                            {extra > 0 && ` +${extra} more`}
                          </div>
                        )}
                        <div className="muted small">{formatDate(n.created_at)}</div>
                      </div>
                      <div className="message-actions">
                        <button
                          onClick={() => void approve(n.id)}
                          disabled={
                            busyId !== null ||
                            originalDeleted ||
                            matches === null
                          }
                        >
                          {busyId === n.id ? "Approving…" : "Approve anyway"}
                        </button>
                        <button
                          className="link"
                          aria-label="Close message"
                          onClick={() => void closeOne(n.id)}
                          disabled={busyId !== null}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    {err && <p className="error small">{err}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
