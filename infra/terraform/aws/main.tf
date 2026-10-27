provider "aws" {
  region = var.aws_region
}

# Example of a PRIVATE storage baseline for later deployment.
# Do NOT run terraform apply before reviewing cost, IAM, remote state and ownership.
resource "aws_s3_bucket" "artifacts" {
  bucket = var.bucket_name
  tags = {
    Project     = "aegis-ai"
    Environment = "portfolio"
    ManagedBy   = "terraform"
  }
}
resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}
