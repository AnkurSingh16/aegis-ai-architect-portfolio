# Terraform AWS starter — preview only

This sample config shows a private/versioned S3 artifact bucket with public access blocked. It **does not** host the React frontend, API or database. Those require separately designed infrastructure.

Do not run `terraform apply` until we have confirmed the AWS account, billing alerts, IAM/OIDC credentials, state backend locking, region, a unique `bucket_name`, teardown plan and security review.

Local validation (Terraform installed):

```bash
terraform fmt -recursive
cd infra/terraform/aws
terraform init -backend=false
terraform validate
terraform plan -var='bucket_name=REPLACE-WITH-GLOBALLY-UNIQUE-NAME'
```

`terraform plan` may require valid AWS credentials; never paste them into prompts. `terraform apply` is intentionally not part of the automated CI workflow.
