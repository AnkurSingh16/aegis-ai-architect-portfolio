output "artifact_bucket_name" {
  description = "Name of optional private bucket if explicitly provisioned."
  value       = aws_s3_bucket.artifacts.bucket
}
