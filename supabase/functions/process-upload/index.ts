// ---------------------------------------------------------------------------
// process-upload — runs on every upload.
//   Tier 1: SHA-256 blob dedup (per user).
//   Tier 2: extraction -> 5-word shingles -> down-weighted Jaccard + filename
//           edit-distance scoring -> near_duplicate_pairs.
// All comparisons are deterministic arithmetic. No AI service is called.
//
// The function runs with the *caller's* JWT, so every read/write is subject to
// Row-Level Security scoped to auth.uid(). Nothing here can cross user lines.
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";
import { sha256Hex } from "../_shared/hash.ts";
import {
  classifyPair,
  extensionOf,
  extractFile,
  filenameSimilarity,
  shingle,
  sizeBucket,
  stemOf,
  weightedJaccard,
} from "../_shared/text.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const BUCKET = "files";

// Below this many files we compare against every other file; above it we
// prefilter to the same extension and adjacent size buckets.
const PREFILTER_MIN_FILES = 2000;
const SIZE_BUCKET_RATIO = 1.2;

const INSERT_CHUNK = 500;
const HASH_CHUNK = 800;

/**
 * Shared Tier-1 linking path: the caller has an existing blob whose SHA-256
 * matches the incoming bytes. Under the block-exact-duplicates feature this
 * attempt is NOT linked: no logical_files row, no ref_count change, no Storage
 * write. Instead a blocked_uploads notice is upserted (created_at refreshed)
 * and the response tells the client which existing file(s) it duplicated.
 * If no logical file references the blob (unreachable in practice), fall back
 * to the previous linking behaviour so nothing regresses.
 */
async function blockOrLinkDuplicate(
  supabase: ReturnType<typeof createClient>,
  user: { id: string },
  existingBlobId: string,
  upload: {
    filename: string;
    filename_stem: string;
    extension: string;
    size_bytes: number;
  },
  sha: string,
): Promise<Response> {
  const { data: matches, error: matchesErr } = await supabase
    .from("logical_files")
    .select("id, filename")
    .eq("blob_id", existingBlobId)
    .order("uploaded_at", { ascending: true });
  if (matchesErr) return json({ error: matchesErr.message }, 500);

  if (!matches || matches.length === 0) {
    // Unreachable unless a blob lost all references; keep old behaviour.
    return linkToBlob(supabase, user, existingBlobId, upload, sha);
  }

  const { data: notice, error: noticeErr } = await supabase
    .from("blocked_uploads")
    .upsert(
      {
        user_id: user.id,
        incoming_filename: upload.filename,
        sha256_hash: sha,
        physical_blob_id: existingBlobId,
        filename_stem: upload.filename_stem,
        extension: upload.extension,
        size_bytes: upload.size_bytes,
        created_at: new Date().toISOString(),
      },
      { onConflict: "user_id,sha256_hash,incoming_filename" },
    )
    .select("id")
    .single();
  if (noticeErr || !notice) {
    // Never silently drop a file: surface the failure instead.
    return json(
      { error: noticeErr?.message ?? "blocked-duplicate notice write failed" },
      500,
    );
  }

  return json({
    status: "blocked_duplicate",
    notice_id: notice.id,
    incoming_filename: upload.filename,
    matches: matches.map((m) => ({ id: m.id, filename: m.filename })),
  });
}

/** The previous Tier-1 behaviour, only used when no reference exists. */
async function linkToBlob(
  supabase: ReturnType<typeof createClient>,
  user: { id: string },
  existingBlobId: string,
  upload: {
    filename: string;
    filename_stem: string;
    extension: string;
    size_bytes: number;
  },
  sha: string,
): Promise<Response> {
  await supabase.rpc("increment_blob_ref", { p_blob_id: existingBlobId });
  const { data: lf, error: lfErr } = await supabase
    .from("logical_files")
    .insert({
      user_id: user.id,
      blob_id: existingBlobId,
      filename: upload.filename,
      filename_stem: upload.filename_stem,
      extension: upload.extension,
      size_bytes: upload.size_bytes,
    })
    .select("id")
    .single();
  if (lfErr) return json({ error: lfErr.message }, 500);
  return json({
    tier: 1,
    deduplicated: true,
    logical_file_id: lf.id,
    sha256: sha,
    message: "Identical bytes already stored; reused existing blob.",
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function chunked<T>(
  items: T[],
  size: number,
  fn: (slice: T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await fn(items.slice(i, i + size));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "unauthorized" }, 401);

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "missing 'file' field" }, 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return json({ error: "empty file" }, 400);

    const filename = file.name || "untitled";
    const extension = extensionOf(filename);
    const stem = stemOf(filename);
    const sizeBytes = bytes.byteLength;
    const sha = await sha256Hex(bytes);

    // ===== Tier 1: byte-level dedup =========================================
    const { data: existingBlob } = await supabase
      .from("physical_blobs")
      .select("id")
      .eq("sha256_hash", sha)
      .maybeSingle();

    if (existingBlob) {
      return blockOrLinkDuplicate(supabase, user, existingBlob.id, {
        filename,
        filename_stem: stem,
        extension,
        size_bytes: sizeBytes,
      }, sha);
    }

    const storagePath = `${user.id}/${sha}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, bytes, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (uploadError && !/already exists/i.test(uploadError.message)) {
      return json({ error: `storage upload failed: ${uploadError.message}` }, 500);
    }

    const { data: blob, error: blobError } = await supabase
      .from("physical_blobs")
      .insert({
        user_id: user.id,
        sha256_hash: sha,
        storage_path: storagePath,
        size_bytes: sizeBytes,
        ref_count: 1,
      })
      .select("id")
      .single();

    // Tier-1 race fix: the UNIQUE constraint on (user_id, sha256_hash) can be
    // hit by a concurrent upload of the same bytes. The loser must not see a
    // raw 500 — it links to the winner's blob and reuses the already-stored
    // bytes instead. Postgres raises code 23505 for unique-violation.
    if (blobError) {
      const match = /unique constraint" (.*)" violated/.exec(blobError.message);
      if (match && match[1] === "physical_blobs_user_hash_key") {
        const { data: existingBlob } = await supabase
          .from("physical_blobs")
          .select("id")
          .eq("sha256_hash", sha)
          .maybeSingle();
        if (existingBlob) {
          return blockOrLinkDuplicate(supabase, user, existingBlob.id, {
            filename,
            filename_stem: stem,
            extension,
            size_bytes: sizeBytes,
          }, sha);
        }
      }
      return json({ error: blobError.message }, 500);
    }

    const { data: logical, error: logicalError } = await supabase
      .from("logical_files")
      .insert({
        user_id: user.id,
        blob_id: blob.id,
        filename,
        filename_stem: stem,
        extension,
        size_bytes: sizeBytes,
      })
      .select("id")
      .single();
    if (logicalError) return json({ error: logicalError.message }, 500);
    const fileId: string = logical.id;

    // ===== Extraction + confidence ==========================================
    const extracted = await extractFile(filename, bytes);
    await supabase.from("logical_files_text").insert({
      logical_file_id: fileId,
      user_id: user.id,
      extracted_text: extracted.ok ? extracted.text : null,
      extraction_ok: extracted.ok,
      expected_min_chars: extracted.expectedMinChars,
      actual_chars: extracted.text.length,
      extraction_reason: extracted.reason,
    });
    if (extracted.pageCount != null) {
      await supabase
        .from("logical_files")
        .update({ page_count: extracted.pageCount })
        .eq("id", fileId);
    }

    // ===== Shingling + document-frequency bump ==============================
    let myHashes: string[] = [];
    if (extracted.ok && extracted.text) {
      const shingles = shingle(extracted.text);
      myHashes = [...new Set(shingles.map((s) => s.hash))];
      await chunked(shingles, INSERT_CHUNK, async (slice) => {
        const rows = slice.map((s) => ({
          logical_file_id: fileId,
          user_id: user.id,
          shingle_hash: s.hash,
          start_offset: s.startOffset,
        }));
        const { error } = await supabase.from("file_shingles").insert(rows);
        if (error) throw new Error(`shingle insert: ${error.message}`);
      });
      await chunked(myHashes, HASH_CHUNK, async (slice) => {
        await supabase.rpc("bump_shingle_doc_frequency", { p_hashes: slice });
      });
    }

    // ===== Tier 2: candidate generation =====================================
    const { count: fileCount } = await supabase
      .from("logical_files")
      .select("id", { count: "exact", head: true });

    const prefilter = (fileCount ?? 0) > PREFILTER_MIN_FILES;

    let candidatesQuery = supabase
      .from("logical_files")
      .select("id, filename_stem, extension, size_bytes")
      .neq("id", fileId);

    if (prefilter) {
      const bucket = sizeBucket(sizeBytes);
      const min = Math.ceil(Math.pow(SIZE_BUCKET_RATIO, bucket - 1));
      const max = Math.floor(Math.pow(SIZE_BUCKET_RATIO, bucket + 2)) - 1;
      candidatesQuery = candidatesQuery
        .eq("extension", extension)
        .gte("size_bytes", min)
        .lte("size_bytes", max);
    }

    const { data: candidates } = await candidatesQuery.limit(10000);
    const candidateList = candidates ?? [];

    // ===== Scoring ==========================================================
    let pairsInserted = 0;

    if (candidateList.length > 0) {
      const candIds = candidateList.map((c) => c.id);

      const { data: textRows } = await supabase
        .from("logical_files_text")
        .select("logical_file_id, extraction_ok")
        .in("logical_file_id", candIds);
      const okById = new Map<string, boolean>(
        (textRows ?? []).map((t) => [t.logical_file_id, t.extraction_ok]),
      );

      const anyContentCompare = extracted.ok &&
        candidateList.some((c) => okById.get(c.id) === true);

      // Load shingles for candidates that have usable text.
      const candidateShingles = new Map<string, string[]>();
      if (anyContentCompare) {
        const okIds = candidateList
          .filter((c) => okById.get(c.id) === true)
          .map((c) => c.id);
        await chunked(okIds, 200, async (slice) => {
          const { data } = await supabase.rpc("get_file_shingles", {
            p_file_ids: slice,
          });
          for (const row of data ?? []) {
            const list = candidateShingles.get(row.logical_file_id) ?? [];
            list.push(row.shingle_hash);
            candidateShingles.set(row.logical_file_id, list);
          }
        });
      }

      const { data: nData } = await supabase.rpc("shingled_file_count");
      const N = Number(nData ?? 0);

      // Document frequencies for every shingle we might weight.
      const docFrequency = new Map<string, number>();
      if (anyContentCompare) {
        const needed = new Set<string>(myHashes);
        for (const hashes of candidateShingles.values()) {
          for (const h of hashes) needed.add(h);
        }
        await chunked([...needed], HASH_CHUNK, async (slice) => {
          const { data } = await supabase.rpc("get_doc_frequencies", {
            p_hashes: slice,
          });
          for (const row of data ?? []) {
            docFrequency.set(row.shingle_hash, row.doc_count);
          }
        });
      }

      const rows: Record<string, unknown>[] = [];
      for (const cand of candidateList) {
        const filenameScore = filenameSimilarity(stem, cand.filename_stem);

        const bothExtracted = extracted.ok && okById.get(cand.id) === true;
        let contentScore: number | null = null;
        let provisional = false;
        if (bothExtracted) {
          const r = weightedJaccard(
            myHashes,
            candidateShingles.get(cand.id) ?? [],
            docFrequency,
            N,
          );
          contentScore = r.score;
          provisional = r.provisional;
        }

        const { flagged, confidence, composite } = classifyPair(
          contentScore,
          provisional,
          filenameScore,
        );
        if (!flagged) continue;

        const [a, b] = fileId < cand.id ? [fileId, cand.id] : [cand.id, fileId];
        rows.push({
          user_id: user.id,
          file_a_id: a,
          file_b_id: b,
          content_score: contentScore,
          filename_score: filenameScore,
          composite_score: composite,
          confidence,
          status: "pending",
        });
      }

      if (rows.length > 0) {
        const { error } = await supabase
          .from("near_duplicate_pairs")
          .upsert(rows, { onConflict: "file_a_id,file_b_id" });
        if (error) throw new Error(`pairs insert: ${error.message}`);
        pairsInserted = rows.length;
      }
    }

    return json({
      tier: 2,
      deduplicated: false,
      logical_file_id: fileId,
      sha256: sha,
      extraction_ok: extracted.ok,
      extraction_reason: extracted.reason,
      shingle_count: myHashes.length,
      near_duplicate_pairs: pairsInserted,
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
