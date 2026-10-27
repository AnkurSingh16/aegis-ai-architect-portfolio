variable "aws_region" {
  description = "AWS region; this starter never deploys without explicit approval."
  type        = string
  default     = "ap-southeast-2"
}
variable "bucket_name" {
  description = "Globally unique name for an OPTIONAL private artifact bucket."
  type        = string
}
