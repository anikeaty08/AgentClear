ALTER TABLE "verification_checks"
  DROP CONSTRAINT "verification_checks_kind_check";

ALTER TABLE "verification_checks"
  ADD CONSTRAINT "verification_checks_kind_check" CHECK (
    "kind" IN ('json_path_exists', 'json_path_equals', 'json_type', 'sandbox_tests')
  ),
  ADD CONSTRAINT "verification_checks_path_shape_check" CHECK (
    jsonb_typeof("path") = 'array'
    AND (
      ("kind" = 'sandbox_tests' AND jsonb_array_length("path") = 0)
      OR
      ("kind" <> 'sandbox_tests' AND jsonb_array_length("path") > 0)
    )
  );
