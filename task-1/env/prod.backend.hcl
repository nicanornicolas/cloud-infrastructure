# terraform init -backend-config=env/prod.backend.hcl
# The state bucket is bootstrapped once, outside this stack, with versioning, uniform
# bucket-level access, public access prevention and IAM limited to the deployer identity.
bucket = "ktsm-prod-tfstate"
prefix = "scheduled-jobs"
