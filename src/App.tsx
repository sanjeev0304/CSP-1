import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { missingEnv, supabase } from "./lib/supabase";
import { Auth } from "./components/Auth";
import { Uploader } from "./components/Uploader";
import { FileList } from "./components/FileList";
import { DuplicatesPanel } from "./components/DuplicatesPanel";
import { ComparisonView } from "./components/ComparisonView";
import { MessagesPanel } from "./components/MessagesPanel";
import { Dashboard, type DashboardStats } from "./components/Dashboard";
import type { BlockedUpload, LogicalFile, NearDuplicatePair } from "./lib/types";

type Tab = "files" | "duplicates" | "dashboard";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("files");
  const [files, setFiles] = useState<LogicalFile[]>([]);
  const [pairs, setPairs] = useState<NearDuplicatePair[]>([]);
  const [blobBytes, setBlobBytes] = useState(0);
  const [blobCount, setBlobCount] = useState(0);
  const [filterFileId, setFilterFileId] = useState<string | null>(null);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notices, setNotices] = useState<BlockedUpload[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const reload = useCallback(async () => {
    setLoadError(null);
    const [filesRes, pairsRes, blobsRes] = await Promise.all([
      supabase
        .from("logical_files")
        .select(
          "id, blob_id, filename, filename_stem, extension, size_bytes, page_count, uploaded_at, physical_blobs(ref_count, size_bytes)",
        )
        .order("uploaded_at", { ascending: false }),
      supabase
        .from("near_duplicate_pairs")
        .select("*")
        .eq("status", "pending")
        .order("composite_score", { ascending: false }),
      supabase.from("physical_blobs").select("size_bytes"),
    ]);

    if (filesRes.error || pairsRes.error || blobsRes.error) {
      setLoadError(
        filesRes.error?.message ?? pairsRes.error?.message ?? blobsRes.error?.message ?? "load failed",
      );
      return;
    }

    setFiles((filesRes.data ?? []) as unknown as LogicalFile[]);
    setPairs((pairsRes.data ?? []) as NearDuplicatePair[]);
    const blobs = (blobsRes.data ?? []) as { size_bytes: number }[];
    setBlobBytes(blobs.reduce((sum, b) => sum + Number(b.size_bytes), 0));
    setBlobCount(blobs.length);
  }, []);

  const refreshNotices = useCallback(async () => {
    const { data, error } = await supabase
      .from("blocked_uploads")
      .select("id, incoming_filename, sha256_hash, physical_blob_id, created_at")
      .order("created_at", { ascending: false });
    if (!error) setNotices((data ?? []) as BlockedUpload[]);
  }, []);

  // Signed-out: drop everything user-specific.
  useEffect(() => {
    if (!session) {
      setNotices([]);
      setFiles([]);
      setPairs([]);
    }
  }, [session]);

  useEffect(() => {
    if (session) {
      void reload();
      void refreshNotices();
    }
  }, [session, reload, refreshNotices]);

  const filesById = useMemo(
    () => new Map(files.map((f) => [f.id, f])),
    [files],
  );

  const pendingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pairs) {
      counts.set(p.file_a_id, (counts.get(p.file_a_id) ?? 0) + 1);
      counts.set(p.file_b_id, (counts.get(p.file_b_id) ?? 0) + 1);
    }
    return counts;
  }, [pairs]);

  const stats: DashboardStats = useMemo(
    () => ({
      logicalFiles: files.length,
      physicalBlobs: blobCount,
      uploadedBytes: files.reduce((s, f) => s + Number(f.size_bytes), 0),
      storedBytes: blobBytes,
      pendingReviews: pairs.length,
    }),
    [files, blobCount, blobBytes, pairs.length],
  );

  const selectedPair = pairs.find((p) => p.id === selectedPairId) ?? null;
  const pairA = selectedPair ? filesById.get(selectedPair.file_a_id) : undefined;
  const pairB = selectedPair ? filesById.get(selectedPair.file_b_id) : undefined;

  function handleChanged(close: boolean) {
    if (close) setSelectedPairId(null);
    void reload();
  }

  if (missingEnv) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">
          <h1>Configuration needed</h1>
          <p className="muted">
            Copy <code>.env.example</code> to <code>.env.local</code> and set{" "}
            <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>,
            then restart the dev server.
          </p>
        </div>
      </div>
    );
  }

  if (!ready) return <div className="auth-wrap muted">Loading…</div>;
  if (!session) return <Auth />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Safara</div>
        <nav className="tabs">
          <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
            Files
          </button>
          <button
            className={tab === "duplicates" ? "active" : ""}
            onClick={() => setTab("duplicates")}
          >
            Duplicates{pairs.length > 0 ? ` (${pairs.length})` : ""}
          </button>
          <button
            className={tab === "dashboard" ? "active" : ""}
            onClick={() => setTab("dashboard")}
          >
            Dashboard
          </button>
        </nav>
        <div className="topbar-right">
          <MessagesPanel
            notices={notices}
            allFiles={files}
            onAfterChange={() => {
              void reload();
              void refreshNotices();
            }}
          />
          <span className="muted small">{session.user.email}</span>
          <button className="link" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        {loadError && <p className="error">{loadError}</p>}

        {tab === "files" && (
          <>
            <Uploader
              onUploaded={() => void reload()}
              onNoticesChanged={() => void refreshNotices()}
            />
            <FileList
              files={files}
              pendingCounts={pendingCounts}
              onReviewFile={(id) => {
                setFilterFileId(id);
                setTab("duplicates");
              }}
              onChanged={() => void reload()}
            />
          </>
        )}

        {tab === "duplicates" && (
          <DuplicatesPanel
            pairs={pairs}
            filesById={filesById}
            filterFileId={filterFileId}
            onClearFilter={() => setFilterFileId(null)}
            onOpen={(id) => setSelectedPairId(id)}
          />
        )}

        {tab === "dashboard" && <Dashboard stats={stats} />}
      </main>

      {selectedPair && pairA && pairB && (
        <ComparisonView
          pair={selectedPair}
          fileA={pairA}
          fileB={pairB}
          onClose={() => setSelectedPairId(null)}
          onChanged={handleChanged}
        />
      )}
    </div>
  );
}
