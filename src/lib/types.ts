export type Confidence = "high" | "provisional" | "metadata-only";

export interface LogicalFile {
  id: string;
  blob_id: string;
  filename: string;
  filename_stem: string;
  extension: string;
  size_bytes: number;
  page_count: number | null;
  uploaded_at: string;
  physical_blobs: { ref_count: number; size_bytes: number } | null;
}

export interface NearDuplicatePair {
  id: string;
  file_a_id: string;
  file_b_id: string;
  content_score: number | null;
  filename_score: number;
  composite_score: number;
  confidence: Confidence;
  status: "pending" | "kept" | "resolved";
  created_at: string;
}

export interface FileText {
  logical_file_id: string;
  extracted_text: string | null;
  extraction_ok: boolean;
  extraction_reason: string | null;
  expected_min_chars: number;
  actual_chars: number;
}

export interface BlockedUpload {
  id: string;
  incoming_filename: string;
  sha256_hash: string;
  physical_blob_id: string | null;
  created_at: string;
}

export interface MatchedFileRef {
  id: string;
  filename: string;
}

/** What process-upload can answer with. */
export type UploadResponse =
  | {
      tier: 1;
      deduplicated: true;
      logical_file_id: string;
      sha256: string;
      message: string;
    }
  | {
      tier: 2;
      deduplicated: false;
      logical_file_id: string;
      sha256: string;
      extraction_ok: boolean;
      extraction_reason: string | null;
      shingle_count: number;
      near_duplicate_pairs: number;
    }
  | {
      status: "blocked_duplicate";
      notice_id: string;
      incoming_filename: string;
      matches: MatchedFileRef[];
    };

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High confidence",
  "metadata-only": "Metadata only — content couldn't be compared",
  provisional: "Provisional — still learning your library",
};
