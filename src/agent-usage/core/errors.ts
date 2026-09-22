export type UsageErrorCode =
  | "usage_attribution_unavailable"
  | "usage_binding_stale"
  | "usage_capture_runtime_unsupported"
  | "usage_collection_pending"
  | "usage_collection_timeout"
  | "usage_collector_closed"
  | "usage_discovery_limit"
  | "usage_epoch_mismatch"
  | "usage_invocation_not_found"
  | "usage_maintenance_conflict"
  | "usage_mapping_conflict"
  | "usage_mapping_mismatch"
  | "usage_mapping_revoked"
  | "usage_observer_unauthorized"
  | "usage_run_not_found"
  | "usage_session_not_found"
  | "usage_source_changed"
  | "usage_source_conflict"
  | "usage_source_failed"
  | "usage_source_incomplete"
  | "usage_source_not_file"
  | "usage_source_not_found"
  | "usage_source_path_denied"
  | "usage_source_too_large"
  | "usage_source_unsupported"
  | "usage_subject_deleted"
  | "usage_subject_mismatch"
  | "usage_tokenizer_asset_invalid"
  | "usage_tokenizer_id_conflict"
  | "usage_tokenizer_pending"
  | "usage_tokenizer_model_conflict";

/** Stable domain codes; diagnostic messages are never used as control flow. */
export class UsageError extends Error {
  readonly name = "UsageError";

  constructor(readonly code: UsageErrorCode, options?: ErrorOptions) {
    super(code, options);
  }
}
